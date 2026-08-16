import { logger } from "./logger.js";

/**
 * SOL/USD price cache. Refreshes at most once per minute via Jupiter's
 * public price API; serves the last known value in between (and on failure).
 * Every USD computation in the system should go through this.
 */
const JUP_PRICE_URL =
  "https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112";

let cached: { price: number; fetchedAt: number } | null = null;
const TTL_MS = 60_000;

export async function solUsd(): Promise<number | null> {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.price;
  try {
    const res = await fetch(JUP_PRICE_URL);
    const json: any = await res.json();
    const price = Number(
      json?.["So11111111111111111111111111111111111111112"]?.usdPrice ??
      json?.data?.["So11111111111111111111111111111111111111112"]?.price
    );
    if (Number.isFinite(price) && price > 0) {
      cached = { price, fetchedAt: Date.now() };
      return price;
    }
  } catch (err) {
    logger.warn({ err }, "SOL price fetch failed — serving stale value if any");
  }
  return cached?.price ?? null;
}
