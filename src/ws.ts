import WebSocket from "ws";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export type PriceCallback = (tokenId: string, price: number) => void;

export function connectMarketWs(
  assetIds: string[],
  onPrice: PriceCallback
): { close: () => void } {
  let ws: WebSocket;
  let alive = true;
  let pingInterval: ReturnType<typeof setInterval>;

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.on("open", () => {
      console.log("[WS] Connected");
      const sub = {
        assets_ids: assetIds,
        type: "market",
      };
      ws.send(JSON.stringify(sub));
      console.log("[WS] Subscribed to", assetIds);

      // Keep alive with pings
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 30_000);
    });

    ws.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        const msgs: any[] = Array.isArray(parsed) ? parsed : [parsed];

        for (const msg of msgs) {
          // Handle price_changes wrapper: {price_changes: [{asset_id, price, best_bid, best_ask, ...}]}
          if (Array.isArray(msg.price_changes)) {
            for (const pc of msg.price_changes) {
              const price = parseFloat(pc.best_bid ?? pc.price);
              if (pc.asset_id && !isNaN(price)) {
                onPrice(pc.asset_id, price);
              }
            }
            continue;
          }

          // Handle last_trade_price events
          if (msg.event_type === "last_trade_price" && msg.asset_id && msg.price) {
            const price = parseFloat(msg.price);
            if (!isNaN(price)) {
              onPrice(msg.asset_id, price);
            }
          }

          // Handle book snapshot — extract best bid price (no event_type field in actual snapshots)
          if (msg.asset_id && (msg.bids || msg.asks)) {
            const bestBid = msg.bids?.[0];
            if (bestBid?.price) {
              const price = parseFloat(bestBid.price);
              if (!isNaN(price)) {
                onPrice(msg.asset_id, price);
              }
            }
          }
        }
      } catch {
        // Ignore non-JSON or malformed messages
      }
    });

    ws.on("close", () => {
      clearInterval(pingInterval);
      if (alive) {
        console.log("[WS] Disconnected, reconnecting in 2s...");
        setTimeout(connect, 2000);
      }
    });

    ws.on("error", (err) => {
      console.error("[WS] Error:", err.message);
    });
  }

  connect();

  return {
    close() {
      alive = false;
      clearInterval(pingInterval);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}
