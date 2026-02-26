// Trade executor — places orders via Tradovate API + full audit log
// Brackets each trade with stop-loss and take-profit OSO orders

import { randomUUID } from 'crypto';
import { TradovateClient } from './tradovate-client.js';
import { Order, RiskResult, Signal, Symbol } from './types.js';

export class TradeExecutor {
  private readonly orders = new Map<string, Order>();

  constructor(
    private readonly client: TradovateClient,
    private readonly accountId: number,
  ) {}

  async execute(signal: Signal, risk: RiskResult): Promise<Order> {
    const order: Order = {
      id: randomUUID(),
      signalId: signal.id,
      symbol: signal.symbol,
      direction: signal.direction,
      orderType: 'Market',
      quantity: risk.quantity,
      stopLoss: risk.stopLossPrice,
      takeProfit: risk.takeProfitPrice,
      status: 'Working',
      timestamp: Date.now(),
      auditLog: [],
    };

    const log = (msg: string) => {
      const entry = `[${new Date().toISOString()}] ${msg}`;
      order.auditLog.push(entry);
      console.log(`[Executor] ${order.symbol}#${order.id.slice(0, 8)} | ${msg}`);
    };

    log(`Signal=${signal.id.slice(0, 8)} dir=${signal.direction} qty=${risk.quantity}`);
    log(`SL=${risk.stopLossPrice.toFixed(2)} TP=${risk.takeProfitPrice.toFixed(2)}`);
    log(`Mode=${this.client.getMode()}`);

    this.orders.set(order.id, order);

    try {
      // Find contract to get Tradovate's internal contract symbol name
      const contract = await this.client.findContract(signal.symbol);
      log(`Contract resolved: ${contract.name} (id=${contract.id})`);

      // Place entry market order
      const entryResponse = await this.client.placeOrder({
        accountSpec: String(this.accountId),
        accountId: this.accountId,
        action: signal.direction,
        symbol: contract.name,
        orderQty: risk.quantity,
        orderType: 'Market',
        isAutomated: true,
      });

      order.tradovateOrderId = entryResponse.orderId;
      log(`Entry order placed: Tradovate orderId=${entryResponse.orderId}`);

      // Place stop-loss order (bracket)
      const slAction = signal.direction === 'Buy' ? 'Sell' : 'Buy';
      await this.client.placeOrder({
        accountSpec: String(this.accountId),
        accountId: this.accountId,
        action: slAction,
        symbol: contract.name,
        orderQty: risk.quantity,
        orderType: 'Stop',
        stopPrice: risk.stopLossPrice,
        isAutomated: true,
      });
      log(`Stop-loss placed at ${risk.stopLossPrice.toFixed(2)}`);

      // Place take-profit limit order (bracket)
      await this.client.placeOrder({
        accountSpec: String(this.accountId),
        accountId: this.accountId,
        action: slAction,
        symbol: contract.name,
        orderQty: risk.quantity,
        orderType: 'Limit',
        price: risk.takeProfitPrice,
        isAutomated: true,
      });
      log(`Take-profit placed at ${risk.takeProfitPrice.toFixed(2)}`);

      order.status = 'Completed';
      log('All bracket orders submitted successfully');

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ERROR: ${msg}`);
      order.status = 'Failed';
    }

    return order;
  }

  getOrder(id: string): Order | undefined {
    return this.orders.get(id);
  }

  getAllOrders(): Order[] {
    return [...this.orders.values()];
  }

  getOrdersBySymbol(symbol: Symbol): Order[] {
    return [...this.orders.values()].filter((o) => o.symbol === symbol);
  }

  printAuditLog(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) { console.log('Order not found'); return; }
    console.log(`\n=== Audit Log: ${orderId} ===`);
    for (const entry of order.auditLog) console.log(entry);
    console.log('='.repeat(40));
  }
}
