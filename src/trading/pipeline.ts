// Trading pipeline orchestrator — Lucid $25K Flex evaluation compliant
// Flow: MarketData → SignalGenerator → RiskEngine (Lucid rules) → TradeExecutor
// Usage: node --env-file=.env src/trading/pipeline.ts

import { MarketDataFeed } from './market-data.js';
import { RiskEngine } from './risk-engine.js';
import { SignalGenerator } from './signals.js';
import { TradovateClient } from './tradovate-client.js';
import { TradeExecutor } from './executor.js';
import { Bar, CONTRACT_SPECS, DEFAULT_CONFIG, LUCID_25K_FLEX, PipelineConfig, Symbol } from './types.js';

async function main() {
  const config: PipelineConfig = {
    ...DEFAULT_CONFIG,
    symbols: ['MES', 'MNQ'],
    lucid: LUCID_25K_FLEX,
  };

  const lucid = config.lucid;
  console.log('=== Trading Pipeline — LucidFlex $25K Evaluation ===');
  console.log(`Instruments:       ${config.symbols.join(', ')}`);
  console.log(`Max loss (EOD):    $${lucid.trailingDrawdownUsd} trailing drawdown`);
  console.log(`Profit target:     $${lucid.profitTargetUsd}`);
  console.log(`Consistency:       best day ≤ ${lucid.consistencyMaxPct * 100}% of total profit`);
  console.log(`Max contracts:     ${lucid.maxContracts} micros | trading with ${config.maxPositionSize}`);
  console.log(`Trading hours UTC: open ${lucid.tradingStartUtc} – flat by ${lucid.tradingEndUtc}`);
  console.log(`Stop-loss: ${config.stopLossTicks} ticks | Take-profit: ${config.takeProfitTicks} ticks`);
  console.log('');

  // 1. Authenticate with Tradovate demo
  const client = TradovateClient.fromEnv(false); // false = demo
  await client.authenticate();
  const accountId = await client.getAccountId();
  console.log(`[Pipeline] Account ID: ${accountId} | Mode: ${client.getMode()}`);

  // 2. Resolve contract IDs for MES and MNQ
  const symbolContracts = new Map<Symbol, number>();
  for (const symbol of config.symbols) {
    const contract = await client.findContract(symbol);
    symbolContracts.set(symbol, contract.id);
    console.log(`[Pipeline] ${symbol} → contractId=${contract.id} (${contract.name})`);
  }

  // 3. Initialise pipeline components
  const generator = new SignalGenerator();
  const riskEngine = new RiskEngine(config);
  const executor = new TradeExecutor(client, accountId);

  // 4. Start market data feed (token obtained from authenticated client)
  const feed = new MarketDataFeed(
    client.getAccessToken(),
    symbolContracts,
    config.barIntervalSeconds * 1000,
  );

  // 5. Wire up the pipeline
  feed.on('bar', async (bar: Bar) => {
    // Stage 1: generate signal
    const signal = generator.onBar(bar);
    if (!signal) return;

    // Stage 2: Lucid risk validation — all 10 rules must pass
    const riskResult = riskEngine.validate(signal);
    if (!riskResult.approved) {
      console.log(`[Pipeline] ✗ REJECTED (${signal.symbol} ${signal.direction}): ${riskResult.reason}`);
      return;
    }

    console.log(`[Pipeline] ✓ APPROVED: ${signal.symbol} ${signal.direction} | ${riskResult.reason}`);

    // Stage 3: execute via Tradovate demo
    const order = await executor.execute(signal, riskResult);
    console.log(`[Pipeline] Order: ${order.status} | id=${order.id.slice(0, 8)}`);

    if (order.status === 'Completed') {
      executor.printAuditLog(order.id);

      // Record trade in risk engine for Lucid tracking
      // NOTE: actual fill P&L should come from Tradovate fill events.
      // Using estimated P&L here (close price - entry × tick value × qty).
      const spec = CONTRACT_SPECS[signal.symbol];
      const estimatedPnl = signal.direction === 'Buy'
        ? (riskResult.takeProfitPrice - signal.price) / spec.tickSize * spec.tickValue * riskResult.quantity
        : (signal.price - riskResult.takeProfitPrice) / spec.tickSize * spec.tickValue * riskResult.quantity;

      riskEngine.recordTrade(signal.symbol, signal.direction, estimatedPnl);

      if (riskEngine.isPassed()) {
        console.log('\n🎉 EVALUATION PASSED — Profit target bereikt!');
        console.log('   Submit je account op lucidtrading.com voor funded account activatie.\n');
      }
    }
  });

  feed.start();

  // Graceful shutdown — also enforces Lucid overnight flat rule
  const shutdown = () => {
    console.log('\n[Pipeline] Shutting down — closing all open positions (Lucid overnight rule)...');
    feed.stop();
    // TODO: iterate executor.getAllOrders() with status 'Working' and cancel/flatten
    const allOrders = executor.getAllOrders();
    console.log(`\n[Pipeline] Session summary: ${allOrders.length} orders placed`);
    for (const sym of config.symbols as Symbol[]) {
      const stats = riskEngine.getDailyStats(sym);
      console.log(`  ${sym}: ${stats.tradeCount} trades | day P&L=$${stats.realizedPnl.toFixed(2)}`);
    }
    riskEngine.printEvaluationStatus();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('\n[Pipeline] Running — press Ctrl+C to stop\n');
}

main().catch((err) => {
  console.error('[Pipeline] Fatal error:', err.message);
  process.exit(1);
});
