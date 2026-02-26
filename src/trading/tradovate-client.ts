// Tradovate REST API client — demo environment
// Credentials via environment variables (never hardcoded)
// Demo base URL: https://demo.tradovateapi.com/v1

import { TradovateAuthResponse, TradovateContract, Direction, Symbol } from './types.js';

const DEMO_BASE_URL = 'https://demo.tradovateapi.com/v1';
const LIVE_BASE_URL = 'https://live.tradovateapi.com/v1';

export interface TradovateCredentials {
  username: string;
  password: string;
  appId: string;
  appVersion: string;
  cid: number;
  sec: string;
}

export interface PlaceOrderRequest {
  accountSpec: string;
  accountId: number;
  action: Direction;
  symbol: string;
  orderQty: number;
  orderType: 'Market' | 'Limit' | 'Stop';
  price?: number;
  stopPrice?: number;
  isAutomated: boolean;
}

export interface TradovateOrderResponse {
  orderId: number;
  orderStatus: string;
}

export class TradovateClient {
  private baseUrl: string;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;
  private userId: number | null = null;

  constructor(private readonly useLive = false) {
    this.baseUrl = useLive ? LIVE_BASE_URL : DEMO_BASE_URL;
  }

  static fromEnv(useLive = false): TradovateClient {
    return new TradovateClient(useLive);
  }

  private getCredentials(): TradovateCredentials {
    const { env } = process;
    const missing: string[] = [];

    if (!env.TRADOVATE_USERNAME) missing.push('TRADOVATE_USERNAME');
    if (!env.TRADOVATE_PASSWORD) missing.push('TRADOVATE_PASSWORD');
    if (!env.TRADOVATE_APP_ID) missing.push('TRADOVATE_APP_ID');
    if (!env.TRADOVATE_CID) missing.push('TRADOVATE_CID');
    if (!env.TRADOVATE_SEC) missing.push('TRADOVATE_SEC');

    if (missing.length > 0) {
      throw new Error(`Missing environment variables: ${missing.join(', ')}`);
    }

    return {
      username: env.TRADOVATE_USERNAME!,
      password: env.TRADOVATE_PASSWORD!,
      appId: env.TRADOVATE_APP_ID!,
      appVersion: env.TRADOVATE_APP_VERSION ?? '1.0.0',
      cid: parseInt(env.TRADOVATE_CID!, 10),
      sec: env.TRADOVATE_SEC!,
    };
  }

  private isTokenValid(): boolean {
    if (!this.accessToken || !this.tokenExpiry) return false;
    // Refresh 60s before expiry
    return this.tokenExpiry.getTime() - Date.now() > 60_000;
  }

  async authenticate(): Promise<void> {
    if (this.isTokenValid()) return;

    const creds = this.getCredentials();
    const response = await fetch(`${this.baseUrl}/auth/accesstokenrequest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: creds.username,
        password: creds.password,
        appId: creds.appId,
        appVersion: creds.appVersion,
        cid: creds.cid,
        sec: creds.sec,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Tradovate auth failed (${response.status}): ${text}`);
    }

    const data = await response.json() as TradovateAuthResponse;

    if (!data.accessToken) {
      throw new Error('No accessToken in auth response — check credentials');
    }

    this.accessToken = data.accessToken;
    this.tokenExpiry = new Date(data.expirationTime);
    this.userId = data.userId;

    console.log(`[TradovateClient] Authenticated as ${data.name} (userId: ${data.userId})`);
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    await this.authenticate();

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
        ...(options.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Tradovate API error ${response.status} at ${path}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async findContract(symbol: Symbol): Promise<TradovateContract> {
    const contracts = await this.request<TradovateContract[]>(
      `/contract/find?name=${symbol}`
    );
    const contract = contracts[0];
    if (!contract) throw new Error(`Contract not found for symbol: ${symbol}`);
    return contract;
  }

  async getAccountId(): Promise<number> {
    const accounts = await this.request<Array<{ id: number; name: string }>>(
      '/account/list'
    );
    if (!accounts.length) throw new Error('No accounts found');
    return accounts[0].id;
  }

  async getPositions(): Promise<Array<{ contractId: number; netPos: number }>> {
    return this.request('/position/list');
  }

  async placeOrder(req: PlaceOrderRequest): Promise<TradovateOrderResponse> {
    return this.request('/order/placeorder', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async cancelOrder(orderId: number): Promise<void> {
    await this.request(`/order/cancelorder`, {
      method: 'POST',
      body: JSON.stringify({ orderId }),
    });
  }

  getUserId(): number {
    if (!this.userId) throw new Error('Not authenticated');
    return this.userId;
  }

  getMode(): string {
    return this.useLive ? 'LIVE' : 'DEMO';
  }
}
