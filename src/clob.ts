import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const TICK_SIZE = "0.01";
const FILL_POLL_INTERVAL = 2000; // 2s between fill checks
const MAX_FILL_POLLS = 130;      // 2s × 130 = ~4.3 min (window is 5 min)

let client: ClobClient | null = null;
let walletAddress: string = "";

export interface DualOrderResult {
  upOrderId: string;
  downOrderId: string;
}

export interface FillResult {
  filledSide: "Up" | "Down";
  filledOrderId: string;
  cancelledOrderId: string;
  fillPrice: number;
  fillSize: number;
}

export async function initClobClient(): Promise<boolean> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("[CLOB] PRIVATE_KEY not set in .env");
    return false;
  }

  try {
    const wallet = new Wallet(privateKey);
    walletAddress = wallet.address;

    // First pass: create client with signer to derive API creds
    const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
    console.log("[CLOB] Deriving API credentials...");
    const creds = await tempClient.createOrDeriveApiKey();

    // Second pass: create client with signer + creds for authenticated requests
    client = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds);
    console.log(`[CLOB] Client initialized for ${walletAddress}`);
    return true;
  } catch (err) {
    console.error("[CLOB] Failed to initialize client:", err);
    return false;
  }
}

export function getWalletAddress(): string {
  return walletAddress;
}

export async function placeDualOrders(
  upTokenId: string,
  downTokenId: string,
  price: number,
  size: number
): Promise<DualOrderResult | null> {
  if (!client) {
    console.error("[CLOB] Client not initialized");
    return null;
  }

  try {
    // Place Up order
    console.log(`[CLOB] Placing Up limit buy @ $${price.toFixed(2)}, size=${size}...`);
    const upSigned = await client.createOrder(
      { tokenID: upTokenId, price, size, side: Side.BUY },
      { tickSize: TICK_SIZE }
    );
    const upResp = await client.postOrder(upSigned, OrderType.GTC);

    if (!upResp.orderID) {
      console.error("[CLOB] Up order failed:", upResp);
      return null;
    }

    console.log(`[CLOB] Up order placed: ${upResp.orderID}`);

    // Place Down order
    console.log(`[CLOB] Placing Down limit buy @ $${price.toFixed(2)}, size=${size}...`);
    const downSigned = await client.createOrder(
      { tokenID: downTokenId, price, size, side: Side.BUY },
      { tickSize: TICK_SIZE }
    );
    const downResp = await client.postOrder(downSigned, OrderType.GTC);

    if (!downResp.orderID) {
      console.error("[CLOB] Down order failed, cancelling Up order...");
      await cancelAllOrders([upResp.orderID]);
      return null;
    }

    console.log(`[CLOB] Down order placed: ${downResp.orderID}`);

    return {
      upOrderId: upResp.orderID,
      downOrderId: downResp.orderID,
    };
  } catch (err) {
    console.error("[CLOB] Error placing dual orders:", err);
    return null;
  }
}

export async function waitForFill(
  orders: DualOrderResult,
  upTokenId: string,
  downTokenId: string,
  abortSignal?: AbortSignal
): Promise<FillResult | null> {
  if (!client) return null;

  for (let i = 0; i < MAX_FILL_POLLS; i++) {
    if (abortSignal?.aborted) {
      console.log("[CLOB] Fill polling aborted, cancelling both orders...");
      await cancelAllOrders([orders.upOrderId, orders.downOrderId]);
      return null;
    }

    try {
      const [upOrder, downOrder] = await Promise.all([
        client.getOrder(orders.upOrderId),
        client.getOrder(orders.downOrderId),
      ]);

      // Check Up fill
      const upMatched = parseFloat(upOrder.size_matched);
      if (!isNaN(upMatched) && upMatched > 0) {
        console.log(`[CLOB] Up order filled! Cancelling Down order...`);
        await cancelAllOrders([orders.downOrderId]);
        return {
          filledSide: "Up",
          filledOrderId: orders.upOrderId,
          cancelledOrderId: orders.downOrderId,
          fillPrice: parseFloat(upOrder.price),
          fillSize: upMatched,
        };
      }

      // Check Down fill
      const downMatched = parseFloat(downOrder.size_matched);
      if (!isNaN(downMatched) && downMatched > 0) {
        console.log(`[CLOB] Down order filled! Cancelling Up order...`);
        await cancelAllOrders([orders.upOrderId]);
        return {
          filledSide: "Down",
          filledOrderId: orders.downOrderId,
          cancelledOrderId: orders.upOrderId,
          fillPrice: parseFloat(downOrder.price),
          fillSize: downMatched,
        };
      }

      // Check if orders were cancelled externally
      if (upOrder.status === "CANCELLED" && downOrder.status === "CANCELLED") {
        console.log("[CLOB] Both orders cancelled externally");
        return null;
      }
    } catch (err) {
      console.error("[CLOB] Error polling fill status:", err);
    }

    await sleep(FILL_POLL_INTERVAL);
  }

  // Timeout — cancel both
  console.log("[CLOB] Fill polling timed out, cancelling both orders...");
  await cancelAllOrders([orders.upOrderId, orders.downOrderId]);
  return null;
}

export async function cancelAllOrders(orderIds: string[]): Promise<void> {
  if (!client) return;

  for (const id of orderIds) {
    try {
      await client.cancelOrder({ orderID: id });
      console.log(`[CLOB] Cancelled order ${id}`);
    } catch (err) {
      // Order may already be filled/cancelled — not critical
      console.log(`[CLOB] Could not cancel order ${id} (may already be filled/cancelled)`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
