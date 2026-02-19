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
        const msgs: any[] = JSON.parse(raw.toString());

        for (const msg of msgs) {
          // Handle last_trade_price events
          if (msg.event_type === "last_trade_price" && msg.asset_id && msg.price) {
            const price = parseFloat(msg.price);
            if (!isNaN(price)) {
              onPrice(msg.asset_id, price);
            }
          }

          // Handle price_change events
          if (msg.event_type === "price_change" && msg.asset_id && msg.price) {
            const price = parseFloat(msg.price);
            if (!isNaN(price)) {
              onPrice(msg.asset_id, price);
            }
          }

          // Handle book snapshot — extract best prices
          if (msg.event_type === "book" && msg.asset_id) {
            const bestAsk = msg.asks?.[0];
            const bestBid = msg.bids?.[0];
            // Use midpoint or best ask as indicative price
            if (bestAsk?.price) {
              const price = parseFloat(bestAsk.price);
              if (!isNaN(price)) {
                onPrice(msg.asset_id, price);
              }
            } else if (bestBid?.price) {
              const price = parseFloat(bestBid.price);
              if (!isNaN(price)) {
                onPrice(msg.asset_id, price);
              }
            }
          }
        }
      } catch {
        // Messages may not always be JSON arrays
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
