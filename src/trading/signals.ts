// Signal generator — EMA crossover (9/21) + RSI(14) filter
// Strategy:
//   BUY  when EMA9 crosses above EMA21 AND RSI < 65 (not overbought)
//   SELL when EMA9 crosses below EMA21 AND RSI > 35 (not oversold)
// Risk score increases with RSI extremes and weak crossover margin

import { randomUUID } from 'crypto';
import { Bar, Indicators, Signal, Symbol } from './types.js';

const EMA_FAST = 9;
const EMA_SLOW = 21;
const RSI_PERIOD = 14;
const MIN_BARS = RSI_PERIOD + EMA_SLOW + 1; // minimum history needed

// Exponential moving average multiplier
function emaMultiplier(period: number): number {
  return 2 / (period + 1);
}

function computeEMA(values: number[], period: number): number[] {
  const k = emaMultiplier(period);
  const emas: number[] = [];
  // Seed with SMA of first `period` values
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  emas.push(seed);
  for (let i = period; i < values.length; i++) {
    emas.push(values[i] * k + emas[emas.length - 1] * (1 - k));
  }
  return emas;
}

function computeRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50; // neutral fallback

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gains += delta;
    else losses += Math.abs(delta);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function riskScore(rsi: number, crossoverMargin: number): number {
  // RSI extremes increase risk
  const rsiRisk = rsi > 80 || rsi < 20 ? 0.8 :
                  rsi > 70 || rsi < 30 ? 0.5 : 0.2;
  // Weak crossover (small margin) increases risk
  const marginRisk = Math.max(0, 1 - Math.abs(crossoverMargin) * 100);
  return Math.min(1, (rsiRisk + marginRisk) / 2);
}

export class SignalGenerator {
  // Per-symbol bar history (closes only for efficiency)
  private readonly closes = new Map<Symbol, number[]>();
  private readonly allBars = new Map<Symbol, Bar[]>();

  onBar(bar: Bar): Signal | null {
    // Accumulate history
    if (!this.closes.has(bar.symbol)) {
      this.closes.set(bar.symbol, []);
      this.allBars.set(bar.symbol, []);
    }
    this.closes.get(bar.symbol)!.push(bar.close);
    this.allBars.get(bar.symbol)!.push(bar);

    const closes = this.closes.get(bar.symbol)!;

    // Need enough bars for all indicators
    if (closes.length < MIN_BARS) {
      console.log(`[Signals] ${bar.symbol}: warming up (${closes.length}/${MIN_BARS} bars)`);
      return null;
    }

    // Compute EMAs on full close series
    const emaFastSeries = computeEMA(closes, EMA_FAST);
    const emaSlowSeries = computeEMA(closes.slice(EMA_SLOW - EMA_FAST), EMA_SLOW);

    const ema9 = emaFastSeries[emaFastSeries.length - 1];
    const ema21 = emaSlowSeries[emaSlowSeries.length - 1];
    const prevEma9 = emaFastSeries[emaFastSeries.length - 2];
    const prevEma21 = emaSlowSeries[emaSlowSeries.length - 2];

    const rsi14 = computeRSI(closes, RSI_PERIOD);

    const indicators: Indicators = { ema9, ema21, rsi14, prevEma9, prevEma21 };

    // Crossover detection
    const crossedAbove = prevEma9 <= prevEma21 && ema9 > ema21;
    const crossedBelow = prevEma9 >= prevEma21 && ema9 < ema21;

    let direction: 'Buy' | 'Sell' | null = null;
    let reason = '';

    if (crossedAbove && rsi14 < 65) {
      direction = 'Buy';
      reason = `EMA9 crossed above EMA21 (RSI=${rsi14.toFixed(1)})`;
    } else if (crossedBelow && rsi14 > 35) {
      direction = 'Sell';
      reason = `EMA9 crossed below EMA21 (RSI=${rsi14.toFixed(1)})`;
    }

    if (!direction) return null;

    const crossoverMargin = ema9 - ema21;
    const confidence = Math.min(1, Math.abs(crossoverMargin) * 50 + 0.5);
    const risk = riskScore(rsi14, crossoverMargin);

    const signal: Signal = {
      id: randomUUID(),
      symbol: bar.symbol,
      direction,
      confidence,
      price: bar.close,
      indicators,
      riskScore: risk,
      timestamp: bar.timestamp,
      reason,
    };

    console.log(
      `[Signals] ${bar.symbol} ${direction} signal | confidence=${confidence.toFixed(2)} ` +
      `risk=${risk.toFixed(2)} | ${reason}`
    );

    return signal;
  }
}
