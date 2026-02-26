// Risk engine — Lucid Trading LucidFlex $25K evaluation compliance
// Rules enforced:
//   1. EOD trailing drawdown ($1,000 from peak EOD balance — no daily loss limit)
//   2. Profit target tracker ($1,500 to pass)
//   3. Consistency rule (best single day ≤ 50% of total realised profit)
//   4. Trading hours gate (overnight Globex session, flat by 16:45 ET / 21:45 UTC)
//   5. Signal risk score threshold
//   6. Duplicate direction prevention
// NOT enforced (LucidFlex allows):
//   - Daily loss limit (none)
//   - News blackout (news trading allowed)
//   - Minimum trading days (none)

import {
  CONTRACT_SPECS,
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
  private dailyTotalPnl = 0;    // sum across all symbols today (resets each day)
  private currentDay = '';      // tracks YYYY-MM-DD for daily reset

  private readonly lucid: LucidConfig;

  constructor(private readonly config: PipelineConfig) {
    this.lucid = config.lucid;
    this.startingEquity = this.lucid.accountSizeUsd;
    this.currentEquity = this.startingEquity;
    this.peakEquity = this.startingEquity;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  validate(signal: Signal): RiskResult {
    this.maybeResetDay();
    const checks = [
      this.checkTradingHours(),
      this.checkTrailingDrawdown(),
      this.checkConsistency(),
      this.checkRiskScore(signal),
      this.checkDuplicateDirection(signal),
    ];

    const failed = checks.find((c) => !c.approved);
    if (failed) return { ...failed, stopLossPrice: 0, takeProfitPrice: 0, quantity: 0 };

    return this.buildApprovedResult(signal);
  }

  recordTrade(symbol: Symbol, direction: 'Buy' | 'Sell', pnlUsd: number): void {
    this.maybeResetDay();
    const today = this.today();
    const stats = this.getDayStats(symbol);
    stats.realizedPnl += pnlUsd;
    stats.tradeCount += 1;

    this.totalRealizedPnl += pnlUsd;
    this.dailyTotalPnl += pnlUsd;
    this.currentEquity += pnlUsd;
    this.tradingDays.add(today);
    this.lastSignalDirection.set(symbol, direction);

    // EOD trailing drawdown: Lucid updates peak based on EOD balance.
    // We update conservatively on every fill to protect the account intraday.
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
    const bestDayPct = this.totalRealizedPnl > 0
      ? (this.dailyTotalPnl / this.totalRealizedPnl * 100).toFixed(0)
      : '0';

    console.log(`\n╔══ LucidFlex Evaluation Status ════════════════╗`);
    console.log(`║ Profit target:  $${this.totalRealizedPnl.toFixed(0).padStart(6)} / $${this.lucid.profitTargetUsd} (${targetProgress}%)`);
    console.log(`║ Trading days:   ${this.tradingDays.size} (geen minimum vereist)`);
    console.log(`║ Consistency:    today ${bestDayPct}% of total (max ${this.lucid.consistencyMaxPct * 100}%)`);
    console.log(`║ Trailing DD:    $${drawdownUsed.toFixed(0).padStart(6)} used / $${this.lucid.trailingDrawdownUsd} max (EOD)`);
    console.log(`║ DD floor:       $${drawdownFloor.toFixed(0)} (account cannot go below)`);
    console.log(`║ DD remaining:   $${drawdownRemaining.toFixed(0)}`);
    console.log(`╚══════════════════════════════════════════════╝\n`);
  }

  getDailyStats(symbol: Symbol): DailyStats { return this.getDayStats(symbol); }
  getTradingDays(): number { return this.tradingDays.size; }
  getTotalPnl(): number { return this.totalRealizedPnl; }
  isPassed(): boolean {
    // LucidFlex: only profit target required (no min trading days)
    return this.totalRealizedPnl >= this.lucid.profitTargetUsd;
  }

  // ─── Individual checks ─────────────────────────────────────────────────────

  private checkTradingHours(): Pick<RiskResult, 'approved' | 'reason'> {
    const nowUtc = this.utcHHMM();
    const start = this.lucid.tradingStartUtc;  // '23:00' ET open
    const end = this.lucid.tradingEndUtc;      // '21:45' ET close

    // Overnight session: start > end means the window wraps midnight.
    // Blocked window is end..start (21:45–23:00 UTC = Lucid EOD + CME maintenance).
    const inWindow = start > end
      ? nowUtc >= start || nowUtc < end   // overnight: open at 23:00, close at 21:45
      : nowUtc >= start && nowUtc < end;  // same-day window (fallback)

    if (!inWindow) {
      return {
        approved: false,
        reason: `Outside trading hours — must be flat by ${end} UTC (16:45 ET). Now ${nowUtc} UTC.`,
      };
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

  private checkConsistency(): Pick<RiskResult, 'approved' | 'reason'> {
    // LucidFlex: best single day ≤ 50% of total realised profit
    // Only triggers once total P&L is positive to avoid division oddities.
    if (this.totalRealizedPnl <= 0) return { approved: true, reason: '' };
    const dayPct = this.dailyTotalPnl / this.totalRealizedPnl;
    if (dayPct > this.lucid.consistencyMaxPct) {
      return {
        approved: false,
        reason: `Consistency rule: today $${this.dailyTotalPnl.toFixed(0)} is ${(dayPct * 100).toFixed(0)}% of total — max ${this.lucid.consistencyMaxPct * 100}%`,
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

  // Reset daily P&L counter when the calendar day changes
  private maybeResetDay(): void {
    const today = this.today();
    if (today !== this.currentDay) {
      this.dailyTotalPnl = 0;
      this.currentDay = today;
    }
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private utcHHMM(): string {
    const now = new Date();
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  }

}
