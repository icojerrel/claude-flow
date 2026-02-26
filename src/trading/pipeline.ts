// Trading pipeline orchestrator
// Flow: MarketData → SignalGenerator → RiskEngine → TradeExecutor
// Usage: node --env-file=.env src/trading/pipeline.ts

import { MarketDataFeed } from './market-data.js';
import { RiskEngine } from './risk-engine.js';
import { SignalGenerator } from './signals.js';
import { TradovateClient } from './tradovate-client.js';
import { TradeExecutor } from './executor.js';
import { Bar, DEFAULT_CONFIG, PipelineConfig, Symbol } from './types.js';

async function main() {
  const config: PipelineConfig = {
    ...DEFAULT_CONFIG,
    symbols: ['MES', 'MNQ'],
  };

  console.log('=== Trading Pipeline Starting ===');
  console.log(`Instruments: ${config.symbols.join(', ')}`);
  console.log(`Max daily loss: $${config.maxDailyLossUsd}`);
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

  // 4. Start market data feed
  const feed = new MarketDataFeed(
    process.env.TRADOVATE_ACCESS_TOKEN ?? '', // set after auth
    symbolContracts,
    config.barIntervalSeconds * 1000,
  );

  // 5. Wire up the pipeline
  feed.on('bar', async (bar: Bar) => {
    // Stage 1: generate signal
    const signal = generator.onBar(bar);
    if (!signal) return;

    // Stage 2: risk validation (byzantine-style: all rules must pass)
    const riskResult = riskEngine.validate(signal);
    if (!riskResult.approved) {
      console.log(`[Pipeline] Signal REJECTED: ${riskResult.reason}`);
      return;
    }

    console.log(`[Pipeline] Signal APPROVED: ${signal.symbol} ${signal.direction} | ${riskResult.reason}`);

    // Stage 3: execute
    const order = await executor.execute(signal, riskResult);
    console.log(`[Pipeline] Order status: ${order.status} | id=${order.id.slice(0, 8)}`);

    if (order.status === 'Completed') {
      // Estimate P&L for audit (simplified — actual P&L comes from Tradovate fills)
      executor.printAuditLog(order.id);
    }
  });

  feed.start();

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[Pipeline] Shutting down...');
    feed.stop();
    const allOrders = executor.getAllOrders();
    console.log(`[Pipeline] Session summary: ${allOrders.length} orders placed`);
    for (const sym of config.symbols) {
      const stats = riskEngine.getDailyStats(sym);
      console.log(`  ${sym}: ${stats.tradeCount} trades | P&L=$${stats.realizedPnl.toFixed(2)}`);
    }
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
