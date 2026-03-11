/**
 * Standalone Aster DEX WebSocket Client
 * No NestJS dependencies - pure TypeScript
 */

import WebSocket from 'ws';

export interface WebSocketMessage {
  event: string;
  data: any;
  timestamp: number;
}

export interface TickerUpdate {
  e: string;      // Event type
  E: number;      // Event time
  s: string;      // Symbol
  p: string;      // Price change
  P: string;      // Price change percent
  w: string;      // Weighted average price
  c: string;      // Last price
  Q: string;      // Last quantity
  o: string;      // Open price
  h: string;      // High price
  l: string;      // Low price
  v: string;      // Total traded base asset volume
  q: string;      // Total traded quote asset volume
  O: number;      // Statistics open time
  C: number;      // Statistics close time
  n: number;      // Total number of trades
}

export interface DepthUpdate {
  e: string;      // Event type
  E: number;      // Event time
  T: number;      // Transaction time
  s: string;      // Symbol
  U: number;      // First update ID in event
  u: number;      // Final update ID in event
  pu: number;     // Final update ID in last stream
  b: [string, string][];  // Bids to update
  a: [string, string][];  // Asks to update
}

export interface MarkPriceUpdate {
  e: string;      // Event type
  E: number;      // Event time
  s: string;      // Symbol
  p: string;      // Mark price
  i: string;      // Index price
  P: string;      // Estimated Settle Price (only on settlement time)
  r: string;      // Funding rate
  T: number;      // Next funding time
}

// ==================== User Data Stream Types ====================

export interface OrderUpdate {
  e: 'ORDER_TRADE_UPDATE';
  E: number;      // Event time
  T: number;      // Transaction time
  o: {
    s: string;    // Symbol
    c: string;    // Client order ID
    S: string;    // Side (BUY/SELL)
    o: string;    // Order type
    f: string;    // Time in force
    q: string;    // Original quantity
    p: string;    // Original price
    ap: string;   // Average price
    sp: string;   // Stop price
    x: string;    // Execution type (NEW, TRADE, CANCELED, EXPIRED, etc.)
    X: string;    // Order status (NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED)
    i: number;    // Order ID
    l: string;    // Order last filled quantity
    z: string;    // Order filled accumulated quantity
    L: string;    // Last filled price
    N: string;    // Commission asset
    n: string;    // Commission
    T: number;    // Order trade time
    t: number;    // Trade ID
    rp: string;   // Realized profit
    ps: string;   // Position side
    cp: boolean;  // Is close position
    pP: boolean;  // Ignore
    si: number;   // Ignore
    ss: number;   // Ignore
  };
}

export interface AccountUpdate {
  e: 'ACCOUNT_UPDATE';
  E: number;      // Event time
  T: number;      // Transaction time
  a: {
    m: string;    // Event reason (ORDER, FUNDING_FEE, WITHDRAW, etc.)
    B: Array<{    // Balance updates
      a: string;  // Asset
      wb: string; // Wallet balance
      cw: string; // Cross wallet balance
      bc: string; // Balance change
    }>;
    P: Array<{    // Position updates
      s: string;  // Symbol
      pa: string; // Position amount
      ep: string; // Entry price
      up: string; // Unrealized PnL
      mt: string; // Margin type
      iw: string; // Isolated wallet
      ps: string; // Position side
    }>;
  };
}

export interface MarginCallUpdate {
  e: 'MARGIN_CALL';
  E: number;
  cw: string;     // Cross wallet balance
  p: Array<{      // Position info
    s: string;
    ps: string;
    pa: string;
    mt: string;
    iw: string;
    mp: string;
    up: string;
    mm: string;
  }>;
}

export interface ListenKeyExpiredUpdate {
  e: 'listenKeyExpired';
  E: number;
}

export type UserDataUpdate = OrderUpdate | AccountUpdate | MarginCallUpdate | ListenKeyExpiredUpdate;

export class AsterWebSocket {
  private ws: WebSocket | null = null;
  private readonly baseURL: string;
  private subscriptions: Set<string> = new Set();
  private isConnected: boolean = false;
  private messageHandlers: Map<string, (data: any) => void> = new Map();
  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;

  constructor(baseURL: string = 'wss://fstream.asterdex.com/ws') {
    this.baseURL = baseURL;
  }

  /**
   * Connect to WebSocket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      try {
        this.ws = new WebSocket(this.baseURL);

        this.ws.on('open', () => {
          console.log('[WebSocket] Connected to Aster');
          this.isConnected = true;
          this.startPing();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          console.log(`[WebSocket] Closed: ${code} - ${reason.toString()}`);
          this.isConnected = false;
          this.cleanup();
        });

        this.ws.on('error', (error: Error) => {
          console.error('[WebSocket] Error:', error.message);
          reject(error);
        });

        this.ws.on('pong', () => {
          // Connection alive
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.subscriptions.clear();
    this.messageHandlers.clear();
  }

  /**
   * Subscribe to streams
   */
  subscribe(streams: string[]): void {
    if (!this.isConnected || !this.ws) {
      console.warn('[WebSocket] Cannot subscribe: not connected');
      return;
    }

    const message = {
      method: 'SUBSCRIBE',
      params: streams,
      id: Date.now(),
    };

    this.ws.send(JSON.stringify(message));
    streams.forEach(s => this.subscriptions.add(s));
  }

  /**
   * Unsubscribe from streams
   */
  unsubscribe(streams: string[]): void {
    if (!this.isConnected || !this.ws) {
      return;
    }

    const message = {
      method: 'UNSUBSCRIBE',
      params: streams,
      id: Date.now(),
    };

    this.ws.send(JSON.stringify(message));
    streams.forEach(s => this.subscriptions.delete(s));
  }

  /**
   * Subscribe to ticker updates for a symbol
   */
  subscribeTicker(symbol: string, handler?: (data: TickerUpdate) => void): void {
    const streamName = `${symbol.toLowerCase()}@ticker`;
    this.subscribe([streamName]);
    if (handler) {
      this.messageHandlers.set(streamName, handler);
    }
  }

  /**
   * Subscribe to orderbook depth updates
   */
  subscribeDepth(symbol: string, levels: number = 20, handler?: (data: DepthUpdate) => void): void {
    const streamName = `${symbol.toLowerCase()}@depth${levels}`;
    this.subscribe([streamName]);
    if (handler) {
      this.messageHandlers.set(streamName, handler);
    }
  }

  /**
   * Subscribe to mark price updates for all symbols
   */
  subscribeAllMarkPrices(handler?: (data: MarkPriceUpdate[]) => void): void {
    const streamName = '!markPrice@arr';
    this.subscribe([streamName]);
    if (handler) {
      this.messageHandlers.set(streamName, handler);
    }
  }

  /**
   * Subscribe to mark price for a specific symbol
   */
  subscribeMarkPrice(symbol: string, handler?: (data: MarkPriceUpdate) => void): void {
    const streamName = `${symbol.toLowerCase()}@markPrice`;
    this.subscribe([streamName]);
    if (handler) {
      this.messageHandlers.set(streamName, handler);
    }
  }

  /**
   * Stream data for a duration and collect messages
   */
  async streamForDuration(
    streams: string[],
    durationMs: number
  ): Promise<any[]> {
    await this.connect();

    return new Promise((resolve) => {
      const messages: any[] = [];

      const tempHandler = (data: any) => {
        messages.push(data);
      };

      // Subscribe to all streams
      this.subscribe(streams);
      streams.forEach(s => this.messageHandlers.set(s, tempHandler));

      // Stop after duration
      setTimeout(() => {
        streams.forEach(s => {
          this.messageHandlers.delete(s);
          this.unsubscribe([s]);
        });
        resolve(messages);
      }, durationMs);
    });
  }

  /**
   * Check if connected
   */
  isWebSocketConnected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  // ==================== User Data Stream Methods ====================

  private userDataWs: WebSocket | null = null;
  private userDataHandlers: Map<string, (data: UserDataUpdate) => void> = new Map();
  private listenKeyKeepAlive: NodeJS.Timeout | null = null;

  /**
   * Connect to user data stream with a listenKey
   * The listenKey should be obtained from createListenKey() on the trading client
   */
  async connectUserDataStream(
    listenKey: string,
    onUpdate?: (data: UserDataUpdate) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const userDataURL = `wss://fstream.asterdex.com/ws/${listenKey}`;

      try {
        this.userDataWs = new WebSocket(userDataURL);

        this.userDataWs.on('open', () => {
          console.log('[WebSocket] Connected to User Data Stream');
          if (onUpdate) {
            this.userDataHandlers.set('default', onUpdate);
          }
          resolve();
        });

        this.userDataWs.on('message', (data: WebSocket.Data) => {
          this.handleUserDataMessage(data);
        });

        this.userDataWs.on('close', (code: number, reason: Buffer) => {
          console.log(`[WebSocket] User Data Stream closed: ${code} - ${reason.toString()}`);
          this.cleanupUserDataStream();
        });

        this.userDataWs.on('error', (error: Error) => {
          console.error('[WebSocket] User Data Stream error:', error.message);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Register handler for specific event types
   */
  onOrderUpdate(handler: (data: OrderUpdate) => void): void {
    this.userDataHandlers.set('ORDER_TRADE_UPDATE', handler as any);
  }

  onAccountUpdate(handler: (data: AccountUpdate) => void): void {
    this.userDataHandlers.set('ACCOUNT_UPDATE', handler as any);
  }

  onMarginCall(handler: (data: MarginCallUpdate) => void): void {
    this.userDataHandlers.set('MARGIN_CALL', handler as any);
  }

  onListenKeyExpired(handler: (data: ListenKeyExpiredUpdate) => void): void {
    this.userDataHandlers.set('listenKeyExpired', handler as any);
  }

  /**
   * Disconnect user data stream
   */
  disconnectUserDataStream(): void {
    this.cleanupUserDataStream();
    if (this.userDataWs) {
      this.userDataWs.close();
      this.userDataWs = null;
    }
    this.userDataHandlers.clear();
  }

  /**
   * Check if user data stream is connected
   */
  isUserDataStreamConnected(): boolean {
    return this.userDataWs?.readyState === WebSocket.OPEN;
  }

  /**
   * Collect user data events for a duration
   * Useful for MCP tool to gather recent events
   */
  async collectUserDataEvents(
    listenKey: string,
    durationMs: number
  ): Promise<UserDataUpdate[]> {
    const events: UserDataUpdate[] = [];

    await this.connectUserDataStream(listenKey, (event) => {
      events.push(event);
    });

    return new Promise((resolve) => {
      setTimeout(() => {
        this.disconnectUserDataStream();
        resolve(events);
      }, durationMs);
    });
  }

  private handleUserDataMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as UserDataUpdate;

      // Call specific handler if registered
      const specificHandler = this.userDataHandlers.get(message.e);
      if (specificHandler) {
        specificHandler(message);
      }

      // Also call default handler
      const defaultHandler = this.userDataHandlers.get('default');
      if (defaultHandler) {
        defaultHandler(message);
      }
    } catch (error) {
      console.error('[WebSocket] Error parsing user data message:', error);
    }
  }

  private cleanupUserDataStream(): void {
    if (this.listenKeyKeepAlive) {
      clearInterval(this.listenKeyKeepAlive);
      this.listenKeyKeepAlive = null;
    }
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());

      // Skip subscription responses
      if (message.result !== undefined || message.id !== undefined) {
        return;
      }

      // Handle stream data
      if (message.stream && message.data) {
        const handler = this.messageHandlers.get(message.stream);
        if (handler) {
          handler(message.data);
        }
      } else if (message.e) {
        // Direct event (no stream wrapper)
        // Try to find matching handler
        for (const [, handler] of this.messageHandlers) {
          handler(message);
        }
      }
    } catch (error) {
      console.error('[WebSocket] Error parsing message:', error);
    }
  }

  private startPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    // Ping every 5 minutes to keep connection alive
    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws) {
        this.ws.ping();
      }
    }, 5 * 60 * 1000);
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }
}
