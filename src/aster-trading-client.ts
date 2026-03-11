/**
 * Standalone Aster DEX Trading Client
 * Supports authenticated trading with HMAC SHA256 signatures
 * No NestJS dependencies - pure TypeScript for MCP server use
 */

import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

export interface AsterTradingCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface TradingResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

export interface OrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_MARKET' | 'TAKE_PROFIT' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET';
  quantity?: string;
  price?: string;
  stopPrice?: string;
  callbackRate?: string; // For trailing stop (0.1-5%)
  reduceOnly?: boolean;
  closePosition?: boolean;
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX'; // GTX = Post Only (maker only)
  newClientOrderId?: string;
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
  priceProtect?: boolean;
  activationPrice?: string; // For trailing stop
  positionSide?: 'BOTH' | 'LONG' | 'SHORT'; // For hedge mode
}

export interface BatchOrderParams {
  orders: OrderParams[];
}

export interface LatencyResult {
  requestTime: number;
  responseTime: number;
  roundTripMs: number;
  serverTime?: number;
  clockDrift?: number;
}

export interface Position {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  positionSide: string;
}

export interface TradeSetup {
  symbol: string;
  side: 'LONG' | 'SHORT';
  usdAmount: number;
  leverage: number;
  stopLossPercent: number;
  takeProfitPercent?: number;
  trailingCallbackPercent?: number; // 1-5% for trailing stop
  useTrailingTP?: boolean;
}

export class AsterTradingClient {
  private readonly httpClient: AxiosInstance;
  private readonly baseURL: string;
  private credentials: AsterTradingCredentials | null = null;

  constructor(baseURL: string = 'https://fapi.asterdex.com') {
    this.baseURL = baseURL;
    this.httpClient = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Aster-MCP-Trading/1.0',
      },
    });
  }

  /**
   * Set API credentials for authenticated endpoints
   */
  setCredentials(apiKey: string, apiSecret: string): void {
    this.credentials = { apiKey, apiSecret };
  }

  /**
   * Check if credentials are configured
   */
  hasCredentials(): boolean {
    return !!(this.credentials?.apiKey && this.credentials?.apiSecret);
  }

  /**
   * Create HMAC SHA256 signature
   */
  private sign(queryString: string): string {
    if (!this.credentials?.apiSecret) {
      throw new Error('API credentials not configured');
    }
    return crypto
      .createHmac('sha256', this.credentials.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  /**
   * Make authenticated GET request
   */
  private async authGet<T>(endpoint: string, params: Record<string, any> = {}): Promise<TradingResponse<T>> {
    if (!this.credentials) {
      return { success: false, error: 'API credentials not configured', timestamp: Date.now() };
    }

    try {
      const allParams = {
        ...params,
        timestamp: Date.now(),
        recvWindow: 50000,
      };

      const qs = new URLSearchParams(allParams as any).toString();
      const signature = this.sign(qs);
      const url = `${this.baseURL}${endpoint}?${qs}&signature=${signature}`;

      const response = await axios.get(url, {
        headers: {
          'X-MBX-APIKEY': this.credentials.apiKey,
          'User-Agent': 'Aster-MCP-Trading/1.0',
        },
        timeout: 30000,
      });

      return { success: true, data: response.data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Make authenticated POST request
   */
  private async authPost<T>(endpoint: string, params: Record<string, any> = {}): Promise<TradingResponse<T>> {
    if (!this.credentials) {
      return { success: false, error: 'API credentials not configured', timestamp: Date.now() };
    }

    try {
      const allParams = {
        ...params,
        timestamp: Date.now(),
        recvWindow: 50000,
      };

      const qs = new URLSearchParams(allParams as any).toString();
      const signature = this.sign(qs);
      const body = `${qs}&signature=${signature}`;
      const url = `${this.baseURL}${endpoint}`;

      const response = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-MBX-APIKEY': this.credentials.apiKey,
          'User-Agent': 'Aster-MCP-Trading/1.0',
        },
        timeout: 30000,
      });

      return { success: true, data: response.data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Make authenticated DELETE request
   */
  private async authDelete<T>(endpoint: string, params: Record<string, any> = {}): Promise<TradingResponse<T>> {
    if (!this.credentials) {
      return { success: false, error: 'API credentials not configured', timestamp: Date.now() };
    }

    try {
      const allParams = {
        ...params,
        timestamp: Date.now(),
        recvWindow: 50000,
      };

      const qs = new URLSearchParams(allParams as any).toString();
      const signature = this.sign(qs);
      const url = `${this.baseURL}${endpoint}?${qs}&signature=${signature}`;

      const response = await axios.delete(url, {
        headers: {
          'X-MBX-APIKEY': this.credentials.apiKey,
          'User-Agent': 'Aster-MCP-Trading/1.0',
        },
        timeout: 30000,
      });

      return { success: true, data: response.data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  // ==================== Account Methods ====================

  /**
   * Get account balance
   */
  async getBalance(): Promise<TradingResponse<any>> {
    return this.authGet('/fapi/v2/balance');
  }

  /**
   * Get account info with positions
   */
  async getAccount(): Promise<TradingResponse<any>> {
    return this.authGet('/fapi/v2/account');
  }

  /**
   * Get positions
   */
  async getPositions(symbol?: string): Promise<TradingResponse<Position[]>> {
    const params: any = {};
    if (symbol) params.symbol = symbol.toUpperCase();
    return this.authGet('/fapi/v2/positionRisk', params);
  }

  /**
   * Set leverage for a symbol
   */
  async setLeverage(symbol: string, leverage: number): Promise<TradingResponse<any>> {
    return this.authPost('/fapi/v1/leverage', {
      symbol: symbol.toUpperCase(),
      leverage,
    });
  }

  /**
   * Get current leverage
   */
  async getLeverage(symbol: string): Promise<TradingResponse<number>> {
    const posResponse = await this.getPositions(symbol);
    if (posResponse.success && posResponse.data && posResponse.data.length > 0) {
      return { success: true, data: parseInt(posResponse.data[0].leverage), timestamp: Date.now() };
    }
    return { success: false, error: 'Could not get leverage', timestamp: Date.now() };
  }

  /**
   * Get ADL (Auto-Deleveraging) quantile/risk level
   * Returns risk level 1-5 for each position (5 = highest risk of ADL)
   */
  async getAdlQuantile(symbol?: string): Promise<TradingResponse<any>> {
    const params: any = {};
    if (symbol) params.symbol = symbol.toUpperCase();
    return this.authGet('/fapi/v1/adlQuantile', params);
  }

  /**
   * Get forced liquidation orders (liquidation history)
   * Shows positions that were liquidated
   */
  async getForceOrders(symbol?: string, limit: number = 50): Promise<TradingResponse<any>> {
    const params: any = { limit };
    if (symbol) params.symbol = symbol.toUpperCase();
    // autoCloseType: LIQUIDATION or ADL
    return this.authGet('/fapi/v1/forceOrders', params);
  }

  /**
   * Get income/PnL history
   * incomeType: REALIZED_PNL, FUNDING_FEE, COMMISSION, TRANSFER, etc.
   */
  async getIncomeHistory(
    symbol?: string,
    incomeType?: string,
    limit: number = 100,
    startTime?: number,
    endTime?: number
  ): Promise<TradingResponse<any>> {
    const params: any = { limit };
    if (symbol) params.symbol = symbol.toUpperCase();
    if (incomeType) params.incomeType = incomeType;
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;
    return this.authGet('/fapi/v1/income', params);
  }

  /**
   * Get leverage brackets (max leverage by notional)
   */
  async getLeverageBrackets(symbol?: string): Promise<TradingResponse<any>> {
    const params: any = {};
    if (symbol) params.symbol = symbol.toUpperCase();
    return this.authGet('/fapi/v1/leverageBracket', params);
  }

  // ==================== Order Methods ====================

  /**
   * Place a new order
   */
  async placeOrder(params: OrderParams): Promise<TradingResponse<any>> {
    const orderParams: any = {
      symbol: params.symbol.toUpperCase(),
      side: params.side,
      type: params.type,
    };

    if (params.quantity) orderParams.quantity = params.quantity;
    if (params.price) orderParams.price = params.price;
    if (params.stopPrice) orderParams.stopPrice = params.stopPrice;
    if (params.callbackRate) orderParams.callbackRate = params.callbackRate;
    if (params.activationPrice) orderParams.activationPrice = params.activationPrice;
    if (params.reduceOnly !== undefined) orderParams.reduceOnly = params.reduceOnly;
    if (params.closePosition !== undefined) orderParams.closePosition = params.closePosition;
    if (params.timeInForce) orderParams.timeInForce = params.timeInForce;
    if (params.newClientOrderId) orderParams.newClientOrderId = params.newClientOrderId;
    if (params.workingType) orderParams.workingType = params.workingType;
    if (params.priceProtect !== undefined) orderParams.priceProtect = params.priceProtect;
    if (params.positionSide) orderParams.positionSide = params.positionSide;

    return this.authPost('/fapi/v1/order', orderParams);
  }

  /**
   * Place market order
   */
  async placeMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string,
    reduceOnly: boolean = false
  ): Promise<TradingResponse<any>> {
    return this.placeOrder({
      symbol,
      side,
      type: 'MARKET',
      quantity,
      reduceOnly,
    });
  }

  /**
   * Place limit order
   */
  async placeLimitOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string,
    price: string,
    timeInForce: 'GTC' | 'IOC' | 'FOK' = 'GTC'
  ): Promise<TradingResponse<any>> {
    return this.placeOrder({
      symbol,
      side,
      type: 'LIMIT',
      quantity,
      price,
      timeInForce,
    });
  }

  /**
   * Place stop loss order
   */
  async placeStopLoss(
    symbol: string,
    side: 'BUY' | 'SELL',
    stopPrice: string,
    closePosition: boolean = true
  ): Promise<TradingResponse<any>> {
    return this.placeOrder({
      symbol,
      side,
      type: 'STOP_MARKET',
      stopPrice,
      closePosition,
      workingType: 'CONTRACT_PRICE',
    });
  }

  /**
   * Place take profit order
   */
  async placeTakeProfit(
    symbol: string,
    side: 'BUY' | 'SELL',
    stopPrice: string,
    closePosition: boolean = true
  ): Promise<TradingResponse<any>> {
    return this.placeOrder({
      symbol,
      side,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice,
      closePosition,
      workingType: 'CONTRACT_PRICE',
    });
  }

  /**
   * Place trailing stop order
   * callbackRate: 1-5 (percentage)
   * activationPrice: optional price at which trailing stop activates
   */
  async placeTrailingStop(
    symbol: string,
    side: 'BUY' | 'SELL',
    callbackRate: number,
    activationPrice?: string,
    closePosition: boolean = true
  ): Promise<TradingResponse<any>> {
    // Validate callback rate (1-5%)
    if (callbackRate < 0.1 || callbackRate > 5) {
      return {
        success: false,
        error: 'Callback rate must be between 0.1 and 5 percent',
        timestamp: Date.now(),
      };
    }

    const params: OrderParams = {
      symbol,
      side,
      type: 'TRAILING_STOP_MARKET',
      callbackRate: callbackRate.toString(),
      closePosition,
      workingType: 'CONTRACT_PRICE',
    };

    if (activationPrice) {
      params.activationPrice = activationPrice;
    }

    return this.placeOrder(params);
  }

  /**
   * Cancel an order
   */
  async cancelOrder(symbol: string, orderId: string): Promise<TradingResponse<any>> {
    return this.authDelete('/fapi/v1/order', {
      symbol: symbol.toUpperCase(),
      orderId,
    });
  }

  /**
   * Cancel all open orders for a symbol
   */
  async cancelAllOrders(symbol: string): Promise<TradingResponse<any>> {
    return this.authDelete('/fapi/v1/allOpenOrders', {
      symbol: symbol.toUpperCase(),
    });
  }

  /**
   * Get open orders
   */
  async getOpenOrders(symbol?: string): Promise<TradingResponse<any[]>> {
    const params: any = {};
    if (symbol) params.symbol = symbol.toUpperCase();
    return this.authGet('/fapi/v1/openOrders', params);
  }

  /**
   * Get order status
   */
  async getOrder(symbol: string, orderId: string): Promise<TradingResponse<any>> {
    return this.authGet('/fapi/v1/order', {
      symbol: symbol.toUpperCase(),
      orderId,
    });
  }

  // ==================== High-Level Trading Methods ====================

  /**
   * Get current market price
   */
  async getCurrentPrice(symbol: string): Promise<TradingResponse<number>> {
    try {
      const response = await this.httpClient.get('/fapi/v1/ticker/price', {
        params: { symbol: symbol.toUpperCase() },
      });
      return { success: true, data: parseFloat(response.data.price), timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Open a position with stop loss and optional trailing take profit
   */
  async openPosition(setup: TradeSetup): Promise<TradingResponse<any>> {
    try {
      const { symbol, side, usdAmount, leverage, stopLossPercent, takeProfitPercent, trailingCallbackPercent, useTrailingTP } = setup;
      const results: any = { setup };

      // 1. Set leverage
      const leverageResp = await this.setLeverage(symbol, leverage);
      if (!leverageResp.success) {
        return { success: false, error: `Failed to set leverage: ${leverageResp.error}`, timestamp: Date.now() };
      }
      results.leverage = leverageResp;

      // 2. Get current price
      const priceResp = await this.getCurrentPrice(symbol);
      if (!priceResp.success || !priceResp.data) {
        return { success: false, error: `Failed to get price: ${priceResp.error}`, timestamp: Date.now() };
      }
      const currentPrice = priceResp.data;
      results.entryPrice = currentPrice;

      // 3. Calculate quantity
      const quantity = ((usdAmount * leverage) / currentPrice).toFixed(8);
      results.quantity = quantity;

      // 4. Place main market order
      const mainSide = side === 'LONG' ? 'BUY' : 'SELL';
      const mainOrderResp = await this.placeMarketOrder(symbol, mainSide, quantity);
      if (!mainOrderResp.success) {
        return { success: false, error: `Failed to open position: ${mainOrderResp.error}`, timestamp: Date.now() };
      }
      results.mainOrder = mainOrderResp;

      // 5. Calculate and place stop loss
      const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
      let slPrice: number;
      if (side === 'LONG') {
        slPrice = currentPrice * (1 - stopLossPercent / 100);
      } else {
        slPrice = currentPrice * (1 + stopLossPercent / 100);
      }

      const slResp = await this.placeStopLoss(symbol, closeSide, slPrice.toFixed(2));
      results.stopLoss = slResp;

      // 6. Place take profit (trailing or fixed)
      if (useTrailingTP && trailingCallbackPercent) {
        // Use trailing stop as take profit
        let activationPrice: number | undefined;
        if (takeProfitPercent) {
          // Activate trailing stop when price hits TP level
          if (side === 'LONG') {
            activationPrice = currentPrice * (1 + takeProfitPercent / 100);
          } else {
            activationPrice = currentPrice * (1 - takeProfitPercent / 100);
          }
        }

        const trailingResp = await this.placeTrailingStop(
          symbol,
          closeSide,
          trailingCallbackPercent,
          activationPrice?.toFixed(2)
        );
        results.trailingTakeProfit = trailingResp;
      } else if (takeProfitPercent) {
        // Use fixed take profit
        let tpPrice: number;
        if (side === 'LONG') {
          tpPrice = currentPrice * (1 + takeProfitPercent / 100);
        } else {
          tpPrice = currentPrice * (1 - takeProfitPercent / 100);
        }

        const tpResp = await this.placeTakeProfit(symbol, closeSide, tpPrice.toFixed(2));
        results.takeProfit = tpResp;
      }

      return { success: true, data: results, timestamp: Date.now() };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to open position', timestamp: Date.now() };
    }
  }

  /**
   * Close an existing position
   */
  async closePosition(symbol: string): Promise<TradingResponse<any>> {
    try {
      // 1. Cancel all open orders for the symbol
      await this.cancelAllOrders(symbol);

      // 2. Get current position
      const posResp = await this.getPositions(symbol);
      if (!posResp.success || !posResp.data || posResp.data.length === 0) {
        return { success: false, error: 'No position found', timestamp: Date.now() };
      }

      const position = posResp.data.find(p => p.symbol === symbol.toUpperCase());
      if (!position || parseFloat(position.positionAmt) === 0) {
        return { success: false, error: 'No open position found', timestamp: Date.now() };
      }

      // 3. Determine close side
      const positionAmt = parseFloat(position.positionAmt);
      const side = positionAmt > 0 ? 'SELL' : 'BUY';
      const quantity = Math.abs(positionAmt).toString();

      // 4. Place market order to close
      return this.placeMarketOrder(symbol, side, quantity, true);
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to close position', timestamp: Date.now() };
    }
  }

  /**
   * Modify stop loss for existing position
   */
  async modifyStopLoss(symbol: string, newStopPrice: string): Promise<TradingResponse<any>> {
    try {
      // Get current position to determine side
      const posResp = await this.getPositions(symbol);
      if (!posResp.success || !posResp.data || posResp.data.length === 0) {
        return { success: false, error: 'No position found', timestamp: Date.now() };
      }

      const position = posResp.data.find(p => p.symbol === symbol.toUpperCase());
      if (!position || parseFloat(position.positionAmt) === 0) {
        return { success: false, error: 'No open position found', timestamp: Date.now() };
      }

      // Cancel existing SL orders
      const ordersResp = await this.getOpenOrders(symbol);
      if (ordersResp.success && ordersResp.data) {
        for (const order of ordersResp.data) {
          if (order.type === 'STOP_MARKET') {
            await this.cancelOrder(symbol, order.orderId.toString());
          }
        }
      }

      // Place new stop loss
      const positionAmt = parseFloat(position.positionAmt);
      const side = positionAmt > 0 ? 'SELL' : 'BUY';
      return this.placeStopLoss(symbol, side, newStopPrice);
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to modify stop loss', timestamp: Date.now() };
    }
  }

  /**
   * Update trailing stop for existing position
   */
  async setTrailingStop(
    symbol: string,
    callbackRate: number,
    activationPrice?: string
  ): Promise<TradingResponse<any>> {
    try {
      // Get current position to determine side
      const posResp = await this.getPositions(symbol);
      if (!posResp.success || !posResp.data || posResp.data.length === 0) {
        return { success: false, error: 'No position found', timestamp: Date.now() };
      }

      const position = posResp.data.find(p => p.symbol === symbol.toUpperCase());
      if (!position || parseFloat(position.positionAmt) === 0) {
        return { success: false, error: 'No open position found', timestamp: Date.now() };
      }

      // Cancel existing TP orders (both regular and trailing)
      const ordersResp = await this.getOpenOrders(symbol);
      if (ordersResp.success && ordersResp.data) {
        for (const order of ordersResp.data) {
          if (order.type === 'TAKE_PROFIT_MARKET' || order.type === 'TRAILING_STOP_MARKET') {
            await this.cancelOrder(symbol, order.orderId.toString());
          }
        }
      }

      // Place new trailing stop
      const positionAmt = parseFloat(position.positionAmt);
      const side = positionAmt > 0 ? 'SELL' : 'BUY';
      return this.placeTrailingStop(symbol, side, callbackRate, activationPrice);
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to set trailing stop', timestamp: Date.now() };
    }
  }

  // ==================== Advanced Order Methods ====================

  /**
   * Place limit order with advanced options (GTX/Post-Only support)
   * GTX = Post Only - order will be rejected if it would take liquidity
   * Great for market making strategies to ensure maker rebates
   */
  async placeLimitOrderAdvanced(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string,
    price: string,
    options: {
      timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX';
      positionSide?: 'BOTH' | 'LONG' | 'SHORT';
      reduceOnly?: boolean;
      clientOrderId?: string;
    } = {}
  ): Promise<TradingResponse<any>> {
    const params: OrderParams = {
      symbol,
      side,
      type: 'LIMIT',
      quantity,
      price,
      timeInForce: options.timeInForce || 'GTC',
      positionSide: options.positionSide,
      reduceOnly: options.reduceOnly,
      newClientOrderId: options.clientOrderId,
    };
    return this.placeOrder(params);
  }

  /**
   * Place batch orders (up to 5 orders at once)
   * All orders are executed atomically - great for:
   * - Opening position with SL/TP in one call
   * - Grid orders
   * - Bracket orders
   */
  async placeBatchOrders(orders: OrderParams[]): Promise<TradingResponse<any[]>> {
    if (!this.credentials) {
      return { success: false, error: 'API credentials not configured', timestamp: Date.now() };
    }

    if (orders.length === 0) {
      return { success: false, error: 'No orders provided', timestamp: Date.now() };
    }

    if (orders.length > 5) {
      return { success: false, error: 'Maximum 5 orders per batch', timestamp: Date.now() };
    }

    try {
      // Format orders for batch endpoint
      const batchOrders = orders.map(order => {
        const formatted: any = {
          symbol: order.symbol.toUpperCase(),
          side: order.side,
          type: order.type,
        };

        if (order.quantity) formatted.quantity = order.quantity;
        if (order.price) formatted.price = order.price;
        if (order.stopPrice) formatted.stopPrice = order.stopPrice;
        if (order.callbackRate) formatted.callbackRate = order.callbackRate;
        if (order.activationPrice) formatted.activationPrice = order.activationPrice;
        if (order.reduceOnly !== undefined) formatted.reduceOnly = String(order.reduceOnly);
        if (order.closePosition !== undefined) formatted.closePosition = String(order.closePosition);
        if (order.timeInForce) formatted.timeInForce = order.timeInForce;
        if (order.newClientOrderId) formatted.newClientOrderId = order.newClientOrderId;
        if (order.workingType) formatted.workingType = order.workingType;
        if (order.priceProtect !== undefined) formatted.priceProtect = String(order.priceProtect);
        if (order.positionSide) formatted.positionSide = order.positionSide;

        return formatted;
      });

      const allParams: any = {
        batchOrders: JSON.stringify(batchOrders),
        timestamp: Date.now(),
        recvWindow: 50000,
      };

      const qs = new URLSearchParams(allParams).toString();
      const signature = this.sign(qs);
      const body = `${qs}&signature=${signature}`;

      const response = await axios.post(`${this.baseURL}/fapi/v1/batchOrders`, body, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-MBX-APIKEY': this.credentials.apiKey,
          'User-Agent': 'Aster-MCP-Trading/2.0',
        },
        timeout: 30000,
      });

      return { success: true, data: response.data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  // ==================== Latency & Performance Methods ====================

  /**
   * Test API latency - measures round-trip time to server
   * Useful for HFT strategies and understanding execution timing
   */
  async testLatency(): Promise<TradingResponse<LatencyResult>> {
    const requestTime = Date.now();

    try {
      const response = await axios.get(`${this.baseURL}/fapi/v1/time`, {
        timeout: 10000,
        headers: { 'User-Agent': 'Aster-MCP-Trading/2.0' },
      });

      const responseTime = Date.now();
      const serverTime = response.data.serverTime;

      const result: LatencyResult = {
        requestTime,
        responseTime,
        roundTripMs: responseTime - requestTime,
        serverTime,
        clockDrift: serverTime ? (requestTime - serverTime) : undefined,
      };

      return { success: true, data: result, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Run multiple latency tests and get statistics
   */
  async testLatencyMultiple(iterations: number = 5): Promise<TradingResponse<{
    results: LatencyResult[];
    stats: {
      min: number;
      max: number;
      avg: number;
      median: number;
      p95: number;
    };
  }>> {
    const results: LatencyResult[] = [];

    for (let i = 0; i < iterations; i++) {
      const result = await this.testLatency();
      if (result.success && result.data) {
        results.push(result.data);
      }
      // Small delay between tests
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (results.length === 0) {
      return { success: false, error: 'All latency tests failed', timestamp: Date.now() };
    }

    const latencies = results.map(r => r.roundTripMs).sort((a, b) => a - b);
    const stats = {
      min: latencies[0],
      max: latencies[latencies.length - 1],
      avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      median: latencies[Math.floor(latencies.length / 2)],
      p95: latencies[Math.floor(latencies.length * 0.95)] || latencies[latencies.length - 1],
    };

    return { success: true, data: { results, stats }, timestamp: Date.now() };
  }

  // ==================== Hedge Mode Methods ====================

  /**
   * Get current position mode (One-Way or Hedge)
   * Hedge mode allows simultaneous long and short positions
   */
  async getPositionMode(): Promise<TradingResponse<{ dualSidePosition: boolean }>> {
    return this.authGet('/fapi/v1/positionSide/dual');
  }

  /**
   * Set position mode (One-Way or Hedge)
   * WARNING: Cannot change mode while positions are open
   * @param hedgeMode - true for Hedge Mode, false for One-Way Mode
   */
  async setPositionMode(hedgeMode: boolean): Promise<TradingResponse<any>> {
    return this.authPost('/fapi/v1/positionSide/dual', {
      dualSidePosition: hedgeMode ? 'true' : 'false',
    });
  }

  // ==================== Auto-Cancel Countdown (Kill Switch) ====================

  /**
   * Set auto-cancel countdown - orders will be cancelled after countdown
   * This is a safety mechanism - if your bot crashes, orders get cancelled
   *
   * @param symbol - Trading pair
   * @param countdownMs - Countdown in milliseconds (0 to cancel, max ~24h)
   *
   * Usage:
   * - Call this periodically (heartbeat) to keep orders alive
   * - If bot crashes, orders auto-cancel after countdown expires
   * - Set to 0 to disable countdown
   */
  async setAutoCancelCountdown(symbol: string, countdownMs: number): Promise<TradingResponse<any>> {
    return this.authPost('/fapi/v1/countdownCancelAll', {
      symbol: symbol.toUpperCase(),
      countdownTime: countdownMs,
    });
  }

  /**
   * Cancel auto-cancel countdown (disable kill switch)
   */
  async cancelAutoCancelCountdown(symbol: string): Promise<TradingResponse<any>> {
    return this.setAutoCancelCountdown(symbol, 0);
  }

  // ==================== Market Making Helpers ====================

  /**
   * Place a two-sided spread (bid and ask)
   * Uses GTX (Post Only) to ensure maker rebates
   */
  async placeSpread(
    symbol: string,
    bidPrice: string,
    askPrice: string,
    quantity: string,
    positionSide?: 'BOTH' | 'LONG' | 'SHORT'
  ): Promise<TradingResponse<{ bidOrder: any; askOrder: any }>> {
    const bidOrder: OrderParams = {
      symbol,
      side: 'BUY',
      type: 'LIMIT',
      quantity,
      price: bidPrice,
      timeInForce: 'GTX', // Post Only
      positionSide,
    };

    const askOrder: OrderParams = {
      symbol,
      side: 'SELL',
      type: 'LIMIT',
      quantity,
      price: askPrice,
      timeInForce: 'GTX', // Post Only
      positionSide,
    };

    const result = await this.placeBatchOrders([bidOrder, askOrder]);

    if (result.success && result.data && result.data.length === 2) {
      return {
        success: true,
        data: {
          bidOrder: result.data[0],
          askOrder: result.data[1],
        },
        timestamp: Date.now(),
      };
    }

    return {
      success: false,
      error: result.error || 'Failed to place spread orders',
      timestamp: Date.now(),
    };
  }

  /**
   * Place grid orders for grid trading strategy
   * Creates multiple limit orders at specified price levels
   */
  async placeGridOrders(
    symbol: string,
    gridParams: {
      lowerPrice: number;
      upperPrice: number;
      gridCount: number; // Max 5 due to batch limit
      quantityPerGrid: string;
      side: 'BUY' | 'SELL' | 'BOTH';
    }
  ): Promise<TradingResponse<any[]>> {
    const { lowerPrice, upperPrice, gridCount, quantityPerGrid, side } = gridParams;

    if (gridCount > 5) {
      return { success: false, error: 'Max 5 grid levels per batch (API limit)', timestamp: Date.now() };
    }

    const priceStep = (upperPrice - lowerPrice) / (gridCount - 1);
    const orders: OrderParams[] = [];

    for (let i = 0; i < gridCount; i++) {
      const price = (lowerPrice + (priceStep * i)).toFixed(2);

      if (side === 'BUY' || side === 'BOTH') {
        orders.push({
          symbol,
          side: 'BUY',
          type: 'LIMIT',
          quantity: quantityPerGrid,
          price,
          timeInForce: 'GTC',
        });
      }

      if (side === 'SELL' || side === 'BOTH') {
        orders.push({
          symbol,
          side: 'SELL',
          type: 'LIMIT',
          quantity: quantityPerGrid,
          price,
          timeInForce: 'GTC',
        });
      }
    }

    // Split into batches of 5 if needed
    if (orders.length <= 5) {
      return this.placeBatchOrders(orders);
    }

    // For more than 5 orders, we need multiple batches
    const allResults: any[] = [];
    for (let i = 0; i < orders.length; i += 5) {
      const batch = orders.slice(i, i + 5);
      const result = await this.placeBatchOrders(batch);
      if (result.success && result.data) {
        allResults.push(...result.data);
      } else {
        return { success: false, error: `Batch ${Math.floor(i/5) + 1} failed: ${result.error}`, timestamp: Date.now() };
      }
    }

    return { success: true, data: allResults, timestamp: Date.now() };
  }

  // ==================== User Data Stream (ListenKey) ====================

  /**
   * Create a new listenKey for user data stream
   * ListenKey is valid for 60 minutes, use keepAlive to extend
   */
  async createListenKey(): Promise<TradingResponse<{ listenKey: string }>> {
    return this.authPost('/fapi/v1/listenKey');
  }

  /**
   * Keep alive a listenKey (extend validity by 60 minutes)
   * Should be called every 30 minutes
   */
  async keepAliveListenKey(listenKey: string): Promise<TradingResponse<any>> {
    return this.authPost('/fapi/v1/listenKey', { listenKey });
  }

  /**
   * Close/delete a listenKey
   */
  async deleteListenKey(listenKey: string): Promise<TradingResponse<any>> {
    return this.authDelete('/fapi/v1/listenKey', { listenKey });
  }

  private handleError(error: any): TradingResponse {
    const errorMessage =
      error.response?.data?.msg ||
      error.response?.data?.message ||
      error.message ||
      'Unknown error';

    return {
      success: false,
      error: errorMessage,
      timestamp: Date.now(),
    };
  }
}
