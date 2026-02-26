// Tradovate WebSocket market data feed
// Subscribes to 1-minute bars for MES and MNQ (demo environment)
// Emits Bar events to registered listeners

import { EventEmitter } from 'events';
import { Bar, Symbol } from './types.js';

const DEMO_MD_URL = 'wss://md.tradovateapi.com/v1/websocket';

type BarListener = (bar: Bar) => void;

interface QuoteEvent {
  e: string;          // event type
  d: QuoteData[];
}

interface QuoteData {
  contractId: number;
  entries: {
    Bid?: { price: number; size: number };
    Ask?: { price: number; size: number };
    Trade?: { price: number; size: number };
  };
}

// Minimal OHLCV accumulator for building 1-min bars from ticks
class BarAccumulator {
  private open: number | null = null;
  private high = -Infinity;
  private low = Infinity;
  private close = 0;
  private volume = 0;
  private barStart = 0;

  constructor(
    private readonly symbol: Symbol,
    private readonly intervalMs: number,
    private readonly onBar: BarListener,
  ) {
    this.barStart = this.currentBarStart();
  }

  private currentBarStart(): number {
    const now = Date.now();
    return now - (now % this.intervalMs);
  }

  tick(price: number, size: number): void {
    const barStart = this.currentBarStart();

    // New bar period started — emit previous bar and reset
    if (barStart > this.barStart && this.open !== null) {
      this.onBar({
        symbol: this.symbol,
        timestamp: this.barStart,
        open: this.open,
        high: this.high,
        low: this.low,
        close: this.close,
        volume: this.volume,
      });
      this.open = null;
      this.high = -Infinity;
      this.low = Infinity;
      this.volume = 0;
      this.barStart = barStart;
    }

    if (this.open === null) this.open = price;
    if (price > this.high) this.high = price;
    if (price < this.low) this.low = price;
    this.close = price;
    this.volume += size;
  }
}

export class MarketDataFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private accumulators = new Map<number, BarAccumulator>();
  private contractIdToSymbol = new Map<number, Symbol>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly accessToken: string,
    private readonly symbolContracts: Map<Symbol, number>, // symbol → contractId
    private readonly intervalMs = 60_000,
  ) {
    super();
    for (const [symbol, contractId] of symbolContracts) {
      this.contractIdToSymbol.set(contractId, symbol);
      this.accumulators.set(
        contractId,
        new BarAccumulator(symbol, intervalMs, (bar) => this.emit('bar', bar)),
      );
    }
  }

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect(): void {
    const ws = new WebSocket(`${DEMO_MD_URL}?token=${this.accessToken}`);
    this.ws = ws;

    ws.onopen = () => {
      console.log('[MarketData] WebSocket connected');
      this.subscribeAll();
    };

    ws.onmessage = (event) => {
      this.handleMessage(event.data as string);
    };

    ws.onerror = (err) => {
      console.error('[MarketData] WebSocket error:', err);
    };

    ws.onclose = (event) => {
      console.warn(`[MarketData] WebSocket closed (code ${event.code})`);
      if (this.running) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5_000);
      }
    };
  }

  private subscribeAll(): void {
    for (const contractId of this.symbolContracts.values()) {
      const msg = JSON.stringify({
        url: 'md/subscribeQuote',
        body: { contractId },
      });
      this.ws?.send(msg);
      console.log(`[MarketData] Subscribed to contractId=${contractId}`);
    }
  }

  private handleMessage(raw: string): void {
    // Tradovate WebSocket sends multi-frame messages separated by '\n'
    const frames = raw.split('\n').filter(Boolean);
    for (const frame of frames) {
      try {
        const msg = JSON.parse(frame) as QuoteEvent;
        if (msg.e === 'md' && Array.isArray(msg.d)) {
          for (const quote of msg.d) {
            const trade = quote.entries?.Trade;
            if (trade && this.accumulators.has(quote.contractId)) {
              this.accumulators.get(quote.contractId)!.tick(trade.price, trade.size);
            }
          }
        }
      } catch {
        // Heartbeat frames are not JSON — ignore
      }
    }
  }
}
