// Tradovate trading pipeline — shared types
// Instruments: MES (Micro E-mini S&P 500), MNQ (Micro E-mini Nasdaq-100)

export type Symbol = 'MES' | 'MNQ';
export type Direction = 'Buy' | 'Sell';
export type OrderType = 'Market' | 'Limit' | 'Stop';
export type OrderStatus = 'Working' | 'Completed' | 'Cancelled' | 'Failed';

// Contract specs for micro futures
export const CONTRACT_SPECS: Record<Symbol, ContractSpec> = {
  MES: {
    symbol: 'MES',
    name: 'Micro E-mini S&P 500',
    tickSize: 0.25,
    tickValue: 1.25,   // $1.25 per tick
    multiplier: 5,     // $5 per point
  },
  MNQ: {
    symbol: 'MNQ',
    name: 'Micro E-mini Nasdaq-100',
    tickSize: 0.25,
    tickValue: 0.50,   // $0.50 per tick
    multiplier: 2,     // $2 per point
  },
};

export interface ContractSpec {
  symbol: Symbol;
  name: string;
  tickSize: number;
  tickValue: number;
  multiplier: number;
}

// Raw price bar from market data feed
export interface Bar {
  symbol: Symbol;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Computed technical indicators
export interface Indicators {
  ema9: number;
  ema21: number;
  rsi14: number;
  prevEma9: number;
  prevEma21: number;
}

// Trading signal produced by signal generator
export interface Signal {
  id: string;
  symbol: Symbol;
  direction: Direction;
  confidence: number;   // 0–1
  price: number;
  indicators: Indicators;
  riskScore: number;    // 0–1, higher = riskier
  timestamp: number;
  reason: string;
}

// Risk validation result
export interface RiskResult {
  approved: boolean;
  reason: string;
  stopLossPrice: number;
  takeProfitPrice: number;
  quantity: number;
}

// Placed order record
export interface Order {
  id: string;
  signalId: string;
  symbol: Symbol;
  direction: Direction;
  orderType: OrderType;
  quantity: number;
  price?: number;
  stopLoss: number;
  takeProfit: number;
  status: OrderStatus;
  tradovateOrderId?: number;
  filledPrice?: number;
  timestamp: number;
  auditLog: string[];
}

// Tradovate API auth response
export interface TradovateAuthResponse {
  accessToken: string;
  expirationTime: string;
  userId: number;
  userStatus: string;
  name: string;
}

// Tradovate contract lookup
export interface TradovateContract {
  id: number;
  name: string;
  contractMaturityId: number;
}

// Lucid Trading prop firm rules (LucidFlex $25K evaluation)
// Source: lucidtrading.com — verify against your dashboard before going live.
export interface LucidConfig {
  accountSizeUsd: number;           // 25000
  trailingDrawdownUsd: number;      // $1,000 EOD trailing max loss (from peak EOD balance)
  profitTargetUsd: number;          // $1,500 to pass evaluation
  consistencyMaxPct: number;        // 0.50 — best single day ≤ 50% of total realised profit
  maxContracts: number;             // 20 micros / 2 minis for $25K
  newsBlackoutMinutes: number;      // 0 — news trading fully allowed
  tradingStartUtc: string;          // '23:00' = 18:00 ET (CME Globex reopen, overnight session)
  tradingEndUtc: string;            // '21:45' = 16:45 ET (must be flat — Lucid EOD cut-off)
  allowOvernightPositions: boolean; // false — flat before 16:45 ET each day
}

export const LUCID_25K_FLEX: LucidConfig = {
  accountSizeUsd: 25_000,
  trailingDrawdownUsd: 1_000,   // EOD trailing drawdown — no intraday enforcement by Lucid
  profitTargetUsd: 1_500,
  consistencyMaxPct: 0.50,      // best day ≤ 50% of total profit
  maxContracts: 20,             // 20 micros / 2 minis
  newsBlackoutMinutes: 0,       // news trading allowed
  tradingStartUtc: '23:00',     // 18:00 ET (overnight Globex session)
  tradingEndUtc: '21:45',       // 16:45 ET (Lucid EOD flat requirement)
  allowOvernightPositions: false,
};

// High-impact news event times UTC (update weekly from forexfactory.com)
// Format: 'HH:MM' on known high-impact days
export const HIGH_IMPACT_NEWS_TIMES_UTC: string[] = [
  // Add current week's FOMC, NFP, CPI times here, e.g.:
  // '13:30', '18:00', '19:00'
];

// Pipeline config
export interface PipelineConfig {
  symbols: Symbol[];
  barIntervalSeconds: number;
  stopLossTicks: number;
  takeProfitTicks: number;
  maxPositionSize: number;    // keep ≤ lucid.maxContracts
  riskScoreThreshold: number;
  lucid: LucidConfig;
}

export const DEFAULT_CONFIG: PipelineConfig = {
  symbols: ['MES', 'MNQ'],
  barIntervalSeconds: 60,
  stopLossTicks: 10,
  takeProfitTicks: 20,
  maxPositionSize: 1,         // conservative — within 20-micro limit
  riskScoreThreshold: 0.6,
  lucid: LUCID_25K_FLEX,
};
