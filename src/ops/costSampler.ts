import { dueHorizons, saveQuote, type QuoteRow } from "../db/db.js";
import { logger } from "../logger.js";
import { WSOL, getQuote, type Quote } from "../quotes.js";
import { strategy } from "../strategy.js";

/**
 * FR-A6 execution-cost sampling.
 *
 * At alert time we price the standard trade; at each exit horizon we re-price
 * that same position. FR-B3 models exit cost as entry impact x2 — these
 * horizon rows are what let Phase 3 test that assumption instead of inheriting
 * it, which matters because memecoin liquidity decays fast and the x2 model
 * errs optimistic in exactly the direction that encourages trading.
 */

function row(
  alertId: number,
  mint: string,
  side: "buy" | "sell",
  horizonMin: number,
  inMint: string,
  outMint: string,
  q: Quote
): QuoteRow {
  return {
    alertId,
    mint,
    side,
    horizonMin,
    inMint,
    outMint,
    inAmount: q.ok ? q.inAmount : null,
    outAmount: q.ok ? q.outAmount : null,
    priceImpactPct: q.ok ? q.priceImpactPct : null,
    route: q.ok ? q.route : null,
    slippageBps: q.ok ? q.slippageBps : null,
    latencyMs: q.latencyMs,
    ok: q.ok,
    error: q.ok ? null : q.error,
    observedAt: Date.now(),
  };
}

/**
 * Price the standard buy, then price selling straight back out.
 *
 * The t=0 sell is a REFERENCE POINT, not an observed exit cost: it hits the
 * same pool state in the other direction and so mirrors the entry impact by
 * construction. It captures pool asymmetry and the fee leg; real exit cost
 * comes from the horizon sweep.
 */
export interface EntryCost {
  buy: Quote;
  sell: Quote | null;
}

/** Fetch only — the alert id does not exist until the alert is inserted. */
export async function fetchEntryCost(mint: string): Promise<EntryCost> {
  const lamports = Math.round(strategy.quotes.sizeSol * 1e9).toString();
  const buy = await getQuote(WSOL, mint, lamports, strategy.quotes.slippageBps);
  const sell = buy.ok
    ? await getQuote(mint, WSOL, buy.outAmount, strategy.quotes.slippageBps)
    : null;
  return { buy, sell };
}

/** Persist once the alert row exists and its id is known. */
export function persistEntryCost(alertId: number, mint: string, cost: EntryCost): void {
  saveQuote(row(alertId, mint, "buy", 0, WSOL, mint, cost.buy));
  if (cost.sell) saveQuote(row(alertId, mint, "sell", 0, mint, WSOL, cost.sell));
}

/**
 * Re-price alerted positions whose exit horizon has come due.
 *
 * Driven off the alerts table rather than in-memory timers: horizons run to
 * 240 min, far longer than the process usually goes between restarts, and
 * this way a restart loses nothing. Tokens here have normally left the
 * 30-minute tracking window entirely — that is expected, not an error, and
 * the sweep deliberately does not scope itself to tracked mints.
 */
export async function sweepHorizonCosts(now = Date.now()): Promise<number> {
  const due = dueHorizons(strategy.quotes.exitHorizonsMin, now, strategy.quotes.maxPerSweep);
  let done = 0;
  for (const d of due) {
    const sell = await getQuote(d.mint, WSOL, d.tokenAmount, strategy.quotes.slippageBps);
    saveQuote(row(d.alertId, d.mint, "sell", d.horizonMin, d.mint, WSOL, sell));
    done++;
    if (sell.ok) {
      logger.debug(
        { mint: d.mint, horizonMin: d.horizonMin, impactPct: sell.priceImpactPct.toFixed(2) },
        "exit cost sampled"
      );
    }
  }
  return done;
}
