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

// Pipeline config
export interface PipelineConfig {
  symbols: Symbol[];
  barIntervalSeconds: number;  // e.g. 60 = 1-minute bars
  maxDailyLossUsd: number;
  stopLossTicks: number;
  takeProfitTicks: number;
  maxPositionSize: number;     // contracts per side
  riskScoreThreshold: number;  // reject signals above this
}

export const DEFAULT_CONFIG: PipelineConfig = {
  symbols: ['MES', 'MNQ'],
  barIntervalSeconds: 60,
  maxDailyLossUsd: 100,
  stopLossTicks: 10,
  takeProfitTicks: 20,
  maxPositionSize: 1,
  riskScoreThreshold: 0.6,
};
