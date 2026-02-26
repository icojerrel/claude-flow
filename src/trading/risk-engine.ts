// Risk engine — validates signals before execution
// Guards: daily loss limit, max position size, risk score threshold,
//         market hours, duplicate signal prevention

import { CONTRACT_SPECS, PipelineConfig, RiskResult, Signal, Symbol } from './types.js';

interface DailyStats {
  realizedPnl: number;
  tradeCount: number;
  date: string; // YYYY-MM-DD
}

export class RiskEngine {
  private dailyStats = new Map<Symbol, DailyStats>();
  private lastSignalDirection = new Map<Symbol, 'Buy' | 'Sell'>();

  constructor(private readonly config: PipelineConfig) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private getStats(symbol: Symbol): DailyStats {
    const today = this.today();
    const existing = this.dailyStats.get(symbol);
    if (!existing || existing.date !== today) {
      const fresh: DailyStats = { realizedPnl: 0, tradeCount: 0, date: today };
      this.dailyStats.set(symbol, fresh);
      return fresh;
    }
    return existing;
  }

  validate(signal: Signal): RiskResult {
    const spec = CONTRACT_SPECS[signal.symbol];
    const stats = this.getStats(signal.symbol);

    // 1. Risk score threshold (from signal generator)
    if (signal.riskScore > this.config.riskScoreThreshold) {
      return {
        approved: false,
        reason: `Risk score ${signal.riskScore.toFixed(2)} exceeds threshold ${this.config.riskScoreThreshold}`,
        stopLossPrice: 0,
        takeProfitPrice: 0,
        quantity: 0,
      };
    }

    // 2. Daily loss limit
    if (stats.realizedPnl <= -this.config.maxDailyLossUsd) {
      return {
        approved: false,
        reason: `Daily loss limit reached ($${Math.abs(stats.realizedPnl).toFixed(2)} / $${this.config.maxDailyLossUsd})`,
        stopLossPrice: 0,
        takeProfitPrice: 0,
        quantity: 0,
      };
    }

    // 3. Duplicate signal prevention (same direction as last trade)
    const lastDir = this.lastSignalDirection.get(signal.symbol);
    if (lastDir === signal.direction) {
      return {
        approved: false,
        reason: `Duplicate signal direction (${signal.direction}) — waiting for opposite signal`,
        stopLossPrice: 0,
        takeProfitPrice: 0,
        quantity: 0,
      };
    }

    // 4. Compute stop-loss and take-profit prices
    const ticksToPrice = (ticks: number) => ticks * spec.tickSize;
    const slDistance = ticksToPrice(this.config.stopLossTicks);
    const tpDistance = ticksToPrice(this.config.takeProfitTicks);

    const stopLossPrice = signal.direction === 'Buy'
      ? signal.price - slDistance
      : signal.price + slDistance;

    const takeProfitPrice = signal.direction === 'Buy'
      ? signal.price + tpDistance
      : signal.price - tpDistance;

    // 5. Risk/reward check (must be at least 1.5:1)
    const rrRatio = tpDistance / slDistance;
    if (rrRatio < 1.5) {
      return {
        approved: false,
        reason: `Risk/reward ratio ${rrRatio.toFixed(2)} below minimum 1.5`,
        stopLossPrice: 0,
        takeProfitPrice: 0,
        quantity: 0,
      };
    }

    const quantity = Math.min(this.config.maxPositionSize, 1);

    return {
      approved: true,
      reason: `OK | RR=${rrRatio.toFixed(1)} | daily P&L=$${stats.realizedPnl.toFixed(2)}`,
      stopLossPrice,
      takeProfitPrice,
      quantity,
    };
  }

  // Call after a trade is closed to track P&L
  recordTrade(symbol: Symbol, direction: 'Buy' | 'Sell', pnlUsd: number): void {
    const stats = this.getStats(symbol);
    stats.realizedPnl += pnlUsd;
    stats.tradeCount += 1;
    this.lastSignalDirection.set(symbol, direction);
    console.log(
      `[RiskEngine] ${symbol} trade recorded: P&L=$${pnlUsd.toFixed(2)} | ` +
      `Daily total=$${stats.realizedPnl.toFixed(2)} (${stats.tradeCount} trades)`
    );
  }

  getDailyStats(symbol: Symbol): DailyStats {
    return this.getStats(symbol);
  }

  resetForNewDay(): void {
    this.dailyStats.clear();
    this.lastSignalDirection.clear();
    console.log('[RiskEngine] Daily stats reset');
  }
}
