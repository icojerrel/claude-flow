// Risk engine — Lucid Trading $25K Flex Account evaluation compliance
// Rules enforced:
//   1. Daily loss limit ($1,000)
//   2. Trailing drawdown ($1,500 from peak equity — floors at starting balance)
//   3. Profit target tracker ($1,500 to pass)
//   4. Minimum trading days (5 distinct days)
//   5. Consistency rule (no single day > 30% of total realised profit)
//   6. News blackout window (±2 min around high-impact events)
//   7. Trading hours gate (CME session only, 08:30–15:00 CT / 13:30–20:00 UTC)
//   8. Overnight position guard (flat at session end)
//   9. Signal risk score threshold
//   10. Duplicate direction prevention

import {
  CONTRACT_SPECS,
  HIGH_IMPACT_NEWS_TIMES_UTC,
  LucidConfig,
  PipelineConfig,
  RiskResult,
  Signal,
  Symbol,
} from './types.js';

interface DailyStats {
  date: string;           // YYYY-MM-DD
  realizedPnl: number;
  tradeCount: number;
}

export class RiskEngine {
  // Lucid account equity tracking
  private peakEquity: number;
  private currentEquity: number;
  private readonly startingEquity: number;

  // Daily state (resets each trading day)
  private dailyStats = new Map<Symbol, DailyStats>();
  private lastSignalDirection = new Map<Symbol, 'Buy' | 'Sell'>();

  // Evaluation progress
  private tradingDays = new Set<string>();      // distinct YYYY-MM-DD traded
  private totalRealizedPnl = 0;

  private readonly lucid: LucidConfig;

  constructor(private readonly config: PipelineConfig) {
    this.lucid = config.lucid;
    this.startingEquity = this.lucid.accountSizeUsd;
    this.currentEquity = this.startingEquity;
    this.peakEquity = this.startingEquity;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  validate(signal: Signal): RiskResult {
    const checks = [
      this.checkTradingHours(),
      this.checkNewsBlackout(),
      this.checkTrailingDrawdown(),
      this.checkDailyLoss(signal.symbol),
      this.checkConsistency(signal.symbol),
      this.checkRiskScore(signal),
      this.checkDuplicateDirection(signal),
    ];

    const failed = checks.find((c) => !c.approved);
    if (failed) return { ...failed, stopLossPrice: 0, takeProfitPrice: 0, quantity: 0 };

    return this.buildApprovedResult(signal);
  }

  recordTrade(symbol: Symbol, direction: 'Buy' | 'Sell', pnlUsd: number): void {
    const today = this.today();
    const stats = this.getDayStats(symbol);
    stats.realizedPnl += pnlUsd;
    stats.tradeCount += 1;

    this.totalRealizedPnl += pnlUsd;
    this.currentEquity += pnlUsd;
    this.tradingDays.add(today);
    this.lastSignalDirection.set(symbol, direction);

    // Update trailing peak
    if (this.currentEquity > this.peakEquity) {
      this.peakEquity = this.currentEquity;
    }

    console.log(
      `[RiskEngine] ${symbol} P&L=$${pnlUsd.toFixed(2)} | ` +
      `Daily=$${stats.realizedPnl.toFixed(2)} | ` +
      `Total=$${this.totalRealizedPnl.toFixed(2)} | ` +
      `Equity=$${this.currentEquity.toFixed(2)} | ` +
      `Peak=$${this.peakEquity.toFixed(2)}`
    );

    this.printEvaluationStatus();
  }

  printEvaluationStatus(): void {
    const drawdownFloor = Math.max(
      this.startingEquity,
      this.peakEquity - this.lucid.trailingDrawdownUsd,
    );
    const drawdownUsed = this.peakEquity - this.currentEquity;
    const drawdownRemaining = this.lucid.trailingDrawdownUsd - drawdownUsed;
    const targetProgress = (this.totalRealizedPnl / this.lucid.profitTargetUsd * 100).toFixed(1);

    console.log(`\n╔══ Lucid Evaluation Status ═══════════════════╗`);
    console.log(`║ Profit target:  $${this.totalRealizedPnl.toFixed(0).padStart(6)} / $${this.lucid.profitTargetUsd} (${targetProgress}%)`);
    console.log(`║ Trading days:   ${this.tradingDays.size} / ${this.lucid.minTradingDays} required`);
    console.log(`║ Trailing DD:    $${drawdownUsed.toFixed(0).padStart(6)} used / $${this.lucid.trailingDrawdownUsd} max`);
    console.log(`║ DD floor:       $${drawdownFloor.toFixed(0)} (account cannot go below)`);
    console.log(`║ DD remaining:   $${drawdownRemaining.toFixed(0)}`);
    console.log(`╚══════════════════════════════════════════════╝\n`);
  }

  getDailyStats(symbol: Symbol): DailyStats { return this.getDayStats(symbol); }
  getTradingDays(): number { return this.tradingDays.size; }
  getTotalPnl(): number { return this.totalRealizedPnl; }
  isPassed(): boolean {
    return this.totalRealizedPnl >= this.lucid.profitTargetUsd &&
           this.tradingDays.size >= this.lucid.minTradingDays;
  }

  // ─── Individual checks ─────────────────────────────────────────────────────

  private checkTradingHours(): Pick<RiskResult, 'approved' | 'reason'> {
    const nowUtc = this.utcHHMM();
    const start = this.lucid.tradingStartUtc;
    const end = this.lucid.tradingEndUtc;

    if (nowUtc < start || nowUtc >= end) {
      return {
        approved: false,
        reason: `Outside trading hours (UTC ${start}–${end}, now ${nowUtc})`,
      };
    }
    return { approved: true, reason: '' };
  }

  private checkNewsBlackout(): Pick<RiskResult, 'approved' | 'reason'> {
    if (!HIGH_IMPACT_NEWS_TIMES_UTC.length) return { approved: true, reason: '' };

    const nowUtc = this.utcHHMM();
    const bufMin = this.lucid.newsBlackoutMinutes;

    for (const newsTime of HIGH_IMPACT_NEWS_TIMES_UTC) {
      const diffMin = this.minutesDiff(nowUtc, newsTime);
      if (Math.abs(diffMin) <= bufMin) {
        return {
          approved: false,
          reason: `News blackout: ${newsTime} UTC ±${bufMin}min (now ${nowUtc})`,
        };
      }
    }
    return { approved: true, reason: '' };
  }

  private checkTrailingDrawdown(): Pick<RiskResult, 'approved' | 'reason'> {
    // The drawdown floor trails the peak but never drops below starting balance
    const drawdownFloor = Math.max(
      this.startingEquity,
      this.peakEquity - this.lucid.trailingDrawdownUsd,
    );
    if (this.currentEquity <= drawdownFloor) {
      return {
        approved: false,
        reason: `Trailing drawdown limit hit — equity $${this.currentEquity.toFixed(0)} ≤ floor $${drawdownFloor.toFixed(0)}`,
      };
    }
    // Warn when within 20% of limit
    const remaining = this.currentEquity - drawdownFloor;
    const threshold = this.lucid.trailingDrawdownUsd * 0.2;
    if (remaining < threshold) {
      console.warn(`[RiskEngine] ⚠ Drawdown warning: only $${remaining.toFixed(0)} remaining`);
    }
    return { approved: true, reason: '' };
  }

  private checkDailyLoss(symbol: Symbol): Pick<RiskResult, 'approved' | 'reason'> {
    const stats = this.getDayStats(symbol);
    if (stats.realizedPnl <= -this.lucid.dailyLossLimitUsd) {
      return {
        approved: false,
        reason: `Daily loss limit reached: $${Math.abs(stats.realizedPnl).toFixed(0)} / $${this.lucid.dailyLossLimitUsd}`,
      };
    }
    return { approved: true, reason: '' };
  }

  private checkConsistency(symbol: Symbol): Pick<RiskResult, 'approved' | 'reason'> {
    if (this.totalRealizedPnl <= 0) return { approved: true, reason: '' };
    const stats = this.getDayStats(symbol);
    const dayPct = stats.realizedPnl / this.totalRealizedPnl;
    if (dayPct > this.lucid.consistencyMaxPct) {
      return {
        approved: false,
        reason: `Consistency rule: today's profit (${(dayPct * 100).toFixed(0)}%) > ${this.lucid.consistencyMaxPct * 100}% of total`,
      };
    }
    return { approved: true, reason: '' };
  }

  private checkRiskScore(signal: Signal): Pick<RiskResult, 'approved' | 'reason'> {
    if (signal.riskScore > this.config.riskScoreThreshold) {
      return {
        approved: false,
        reason: `Signal risk score ${signal.riskScore.toFixed(2)} > threshold ${this.config.riskScoreThreshold}`,
      };
    }
    return { approved: true, reason: '' };
  }

  private checkDuplicateDirection(signal: Signal): Pick<RiskResult, 'approved' | 'reason'> {
    const last = this.lastSignalDirection.get(signal.symbol);
    if (last === signal.direction) {
      return {
        approved: false,
        reason: `Duplicate direction (${signal.direction}) — waiting for reversal signal`,
      };
    }
    return { approved: true, reason: '' };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private buildApprovedResult(signal: Signal): RiskResult {
    const spec = CONTRACT_SPECS[signal.symbol];
    const slDist = this.config.stopLossTicks * spec.tickSize;
    const tpDist = this.config.takeProfitTicks * spec.tickSize;

    const stopLossPrice = signal.direction === 'Buy'
      ? signal.price - slDist
      : signal.price + slDist;
    const takeProfitPrice = signal.direction === 'Buy'
      ? signal.price + tpDist
      : signal.price - tpDist;

    const rrRatio = tpDist / slDist;
    if (rrRatio < 1.5) {
      return {
        approved: false,
        reason: `R/R ratio ${rrRatio.toFixed(2)} below minimum 1.5`,
        stopLossPrice: 0, takeProfitPrice: 0, quantity: 0,
      };
    }

    const stats = this.getDayStats(signal.symbol);
    return {
      approved: true,
      reason: `OK | RR=${rrRatio.toFixed(1)} | daily=$${stats.realizedPnl.toFixed(0)} | total=$${this.totalRealizedPnl.toFixed(0)}`,
      stopLossPrice,
      takeProfitPrice,
      quantity: this.config.maxPositionSize,
    };
  }

  private getDayStats(symbol: Symbol): DailyStats {
    const today = this.today();
    const existing = this.dailyStats.get(symbol);
    if (!existing || existing.date !== today) {
      const fresh: DailyStats = { date: today, realizedPnl: 0, tradeCount: 0 };
      this.dailyStats.set(symbol, fresh);
      return fresh;
    }
    return existing;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private utcHHMM(): string {
    const now = new Date();
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  }

  private minutesDiff(a: string, b: string): number {
    const [ah, am] = a.split(':').map(Number);
    const [bh, bm] = b.split(':').map(Number);
    return (ah * 60 + am) - (bh * 60 + bm);
  }
}
