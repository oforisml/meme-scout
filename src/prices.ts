import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Market data (USD price + pooled liquidity) from Jupiter's price API.
 *
 * This is the cheapest honest source we have for two of the four fields the
 * recorder needs: one request covers up to 50 mints and costs no Helius
 * credits at all, which matters because the RPC budget is the binding
 * constraint on the whole recorder (see docs/DECISIONS.md).
 *
 * Verified against live traffic: brand-new mints ARE indexed — a sample of
 * the 10 most recently observed tokens, aged 0.8 to 6.6 minutes, returned
 * price and liquidity for all 10.
 */

const WSOL = "So11111111111111111111111111111111111111112";

/** Jupiter caps a single price request at 50 ids. */
const MAX_IDS_PER_REQUEST = 50;

/**
 * lite-api needs no key but carries a deprecation notice dated 2025-12-31;
 * both hosts still answer keyless today. Setting JUPITER_API_KEY moves us to
 * the keyed host before the free one goes away.
 */
const PRICE_HOST = config.JUPITER_API_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag";

export interface MarketData {
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** When this was fetched — a carried-forward value must not look fresh. */
  fetchedAt: number;
}

const cache = new Map<string, MarketData>();

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchBatch(mints: string[]): Promise<void> {
  const url = `${PRICE_HOST}/price/v3?ids=${mints.join(",")}`;
  const headers: Record<string, string> = config.JUPITER_API_KEY
    ? { "x-api-key": config.JUPITER_API_KEY }
    : {};

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`jupiter price ${res.status}`);
  const json: any = await res.json();

  // v3 returns {mint: {...}}; older shapes nested it under `data`.
  const body = json?.data ?? json;
  const fetchedAt = Date.now();

  for (const mint of mints) {
    const entry = body?.[mint];
    if (!entry) continue; // absent means Jupiter has no route yet — leave it unknown
    const priceUsd = Number(entry.usdPrice ?? entry.price);
    const liquidityUsd = Number(entry.liquidity);
    cache.set(mint, {
      priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null,
      liquidityUsd: Number.isFinite(liquidityUsd) ? liquidityUsd : null,
      fetchedAt,
    });
  }
}

/**
 * Refresh a whole set of mints in as few requests as possible. The recorder
 * sweeps its tracked set with this so that per-token snapshot cadence is
 * decoupled from HTTP request rate.
 */
export async function refreshMarketData(mints: string[]): Promise<void> {
  if (mints.length === 0) return;
  for (const batch of chunk([...new Set(mints)], MAX_IDS_PER_REQUEST)) {
    try {
      await fetchBatch(batch);
    } catch (err) {
      logger.warn({ err, count: batch.length }, "jupiter price batch failed — serving stale values");
    }
  }
}

/**
 * Read market data for one mint. Uses the sweep cache when it is fresh enough,
 * otherwise fetches immediately — the first snapshot of a brand-new token
 * happens before the sweeper has ever seen it.
 */
export async function marketData(mint: string, maxAgeMs = 30_000): Promise<MarketData | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.fetchedAt < maxAgeMs) return hit;

  try {
    await fetchBatch([mint]);
  } catch (err) {
    logger.warn({ err, mint }, "jupiter price fetch failed — serving stale value if any");
  }
  return cache.get(mint) ?? null;
}

/** SOL/USD, via the same cache. Used for any SOL-denominated conversion. */
export async function solUsd(): Promise<number | null> {
  const data = await marketData(WSOL, 60_000);
  return data?.priceUsd ?? null;
}
