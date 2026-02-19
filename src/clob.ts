import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const TICK_SIZE = "0.01";
const MIN_SHARES = 5;
const FILL_POLL_INTERVAL = 2000; // 2s between fill checks
const MAX_FILL_POLLS = 130;      // 2s × 130 = ~4.3 min (window is 5 min)

let client: ClobClient | null = null;
let walletAddress: string = "";

export interface FillResult {
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
    const funderAddress = process.env.FUNDER_ADDRESS;
    const sigType = funderAddress ? 1 : 0; // 1 = POLY_PROXY, 0 = EOA

    // First pass: create client with signer to derive API creds
    const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, undefined, sigType, funderAddress);
    console.log("[CLOB] Deriving API credentials...");
    const creds = await tempClient.createOrDeriveApiKey();

    // Second pass: create client with signer + creds for authenticated requests
    client = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds, sigType, funderAddress);
    console.log(`[CLOB] Client initialized for ${walletAddress}`);
    if (funderAddress) {
      console.log(`[CLOB] Using funder (proxy wallet): ${funderAddress}`);
    }
    return true;
  } catch (err) {
    console.error("[CLOB] Failed to initialize client:", err);
    return false;
  }
}

export function getWalletAddress(): string {
  return walletAddress;
}

export async function placeOrder(
  tokenId: string,
  price: number,
  size: number
): Promise<{ orderId: string } | null> {
  if (!client) {
    console.error("[CLOB] Client not initialized");
    return null;
  }

  try {
    const shares = Math.floor((size / price) * 100) / 100;

    if (shares < MIN_SHARES) {
      console.error(`[CLOB] Order too small: ${shares} shares (minimum ${MIN_SHARES}). Increase --size to at least $${(MIN_SHARES * price).toFixed(2)}`);
      return null;
    }

    console.log(`[CLOB] Placing limit buy @ $${price.toFixed(2)}, ${shares} shares ($${(shares * price).toFixed(2)})...`);
    const signed = await client.createOrder(
      { tokenID: tokenId, price, size: shares, side: Side.BUY },
      { tickSize: TICK_SIZE }
    );
    const resp = await client.postOrder(signed, OrderType.GTC);

    if (!resp.orderID) {
      console.error("[CLOB] Order failed:", resp);
      return null;
    }

    console.log(`[CLOB] Order placed: ${resp.orderID}`);
    return { orderId: resp.orderID };
  } catch (err) {
    console.error("[CLOB] Error placing order:", err);
    return null;
  }
}

export async function waitForOrderFill(
  orderId: string,
  abortSignal?: AbortSignal
): Promise<FillResult | null> {
  if (!client) return null;

  for (let i = 0; i < MAX_FILL_POLLS; i++) {
    if (abortSignal?.aborted) {
      console.log("[CLOB] Fill polling aborted, cancelling order...");
      await cancelAllOrders([orderId]);
      return null;
    }

    try {
      const order = await client.getOrder(orderId);

      const matched = parseFloat(order.size_matched);
      if (!isNaN(matched) && matched > 0) {
        console.log(`[CLOB] Order filled!`);
        return {
          fillPrice: parseFloat(order.price),
          fillSize: matched,
        };
      }

      if (order.status === "CANCELLED") {
        console.log("[CLOB] Order cancelled externally");
        return null;
      }
    } catch (err) {
      console.error("[CLOB] Error polling fill status:", err);
    }

    await sleep(FILL_POLL_INTERVAL);
  }

  console.log("[CLOB] Fill polling timed out, cancelling order...");
  await cancelAllOrders([orderId]);
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
