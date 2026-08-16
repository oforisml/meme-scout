import { JUPITER_HOST, jupiterHeaders } from "./jupiter.js";
import { logger, scrubText } from "./logger.js";

/**
 * Execution-cost sampling (FR-A6).
 *
 * Phase 3's whole question is whether alerts have positive expectancy NET OF
 * COSTS. Costs cannot be reconstructed afterwards: you cannot ask later what
 * 0.5 SOL would have cost at a moment that has passed, on a pool that no
 * longer exists. So the quote is recorded at the moment of the alert, and
 * again at exit horizons.
 *
 * Measured latency against the live endpoint is 371-458ms, well inside the
 * 2s FR-A6 acceptance criterion.
 */

export const WSOL = "So11111111111111111111111111111111111111112";

export interface QuoteOk {
  ok: true;
  inAmount: string;
  outAmount: string;
  /** TRUE PERCENT, not the fraction Jupiter returns. See parseQuote. */
  priceImpactPct: number;
  route: string;
  slippageBps: number;
  latencyMs: number;
}

export interface QuoteFailed {
  ok: false;
  error: string;
  latencyMs: number;
}

export type Quote = QuoteOk | QuoteFailed;

/**
 * Pure parser, so the units can be pinned down in a test rather than in
 * production.
 *
 * Jupiter reports `priceImpactPct` as a DECIMAL FRACTION despite the name:
 * calibrated against a deep pair, SOL->USDC at 0.5 SOL returns 0.0000126,
 * i.e. 0.00126%. Storing that raw in a column called `_pct` is exactly the
 * units trap that produced 31,772 "SOL" swap rows earlier. We convert once,
 * here, and the stored column then means what it says.
 *
 * A value of exactly 1 (=100%) is legitimate and means the pool is dead or
 * unroutable at this size. It is a finding, not an error — keep it.
 */
export function parseQuote(json: unknown, latencyMs: number): Quote {
  const j = json as Record<string, any> | null;
  if (!j || typeof j !== "object") return { ok: false, error: "non-object response", latencyMs };
  if (j.error) return { ok: false, error: String(j.error), latencyMs };

  const inAmount = j.inAmount;
  const outAmount = j.outAmount;
  if (typeof inAmount !== "string" || typeof outAmount !== "string") {
    return { ok: false, error: "missing inAmount/outAmount", latencyMs };
  }

  const fraction = Number(j.priceImpactPct);
  if (!Number.isFinite(fraction)) {
    return { ok: false, error: "unparseable priceImpactPct", latencyMs };
  }

  const route = Array.isArray(j.routePlan)
    ? j.routePlan.map((r: any) => r?.swapInfo?.label ?? "?").join(">")
    : "";

  return {
    ok: true,
    inAmount,
    outAmount,
    priceImpactPct: fraction * 100,
    route,
    slippageBps: Number(j.slippageBps) || 0,
    latencyMs,
  };
}

/** One quote. Failures are returned, never thrown — FR-A6 requires them stored. */
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps: number
): Promise<Quote> {
  const url =
    `${JUPITER_HOST}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountRaw}&slippageBps=${slippageBps}`;
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { headers: jupiterHeaders() });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, error: `http ${res.status}`, latencyMs };
    }
    return parseQuote(await res.json(), latencyMs);
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    logger.warn({ err, outputMint }, "jupiter quote failed");
    return { ok: false, error: scrubText(String(err)), latencyMs };
  }
}

/** Human-readable cost line for the alert body. */
export function formatCost(buy: Quote): string {
  if (!buy.ok) return `Execution cost: quote failed (${buy.error})`;
  const impact = buy.priceImpactPct;
  const flag = impact >= 50 ? "  ** pool is effectively dead **" : "";
  return `Execution: 0.5 SOL buy -> impact ${impact.toFixed(2)}% via ${buy.route || "?"}${flag}`;
}
