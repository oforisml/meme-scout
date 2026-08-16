export type LaunchSource = "raydium" | "pumpfun" | "pumpswap" | "launchlab";

/** A newly observed token launch, pool creation, or graduation. */
export interface TokenLaunch {
  mint: string;
  pool: string | null;
  creator: string | null;
  source: LaunchSource;
  /** launch = new token/pool; graduation = curve completed, moved to AMM */
  kind: "launch" | "graduation";
  signature: string;
  slot: number;
  observedAt: number; // unix ms — when WE saw it (point-in-time discipline)
}

/**
 * Snapshot of on-chain state at a moment in time. Everything is timestamped.
 *
 * Not every field is refreshed on every tick — price/liquidity are cheap and
 * move fast, chain state and holder counts are expensive and move slowly (see
 * the cadence marks in strategy.config.json). Slow fields are carried forward
 * between refreshes, and `chainStateAt` / `holderCountAt` record when each was
 * ACTUALLY observed. Point-in-time discipline: a carried-forward value must
 * never look fresher than it is.
 */
export interface TokenSnapshot {
  mint: string;
  takenAt: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  top10HolderPct: number | null;
  mintAuthorityActive: boolean | null;
  freezeAuthorityActive: boolean | null;
  lpBurnedPct: number | null;
  /** When the authority/concentration fields were last really read. */
  chainStateAt: number | null;
  /** When holderCount was last really read. */
  holderCountAt: number | null;
}

export interface FilterResult {
  name: string;
  passed: boolean;
  hardBlock: boolean; // hard blocks stop the pipeline immediately
  score: number; // 0..100 contribution
  evidence: string[];
  /**
   * True when the filter could not evaluate because its input was missing,
   * as opposed to evaluating and rejecting on the evidence. Insufficient data
   * is NOT a pass (see docs/DECISIONS.md), but Phase 3 must be able to tell
   * "we judged this and said no" from "we never knew".
   */
  insufficientData?: boolean;
}

export interface Assessment {
  mint: string;
  assessedAt: number;
  passed: boolean;
  totalScore: number;
  results: FilterResult[];
}

export interface Alert {
  mint: string;
  createdAt: number;
  severity: "info" | "high";
  title: string;
  body: string;
}

/** A filter takes a launch + latest snapshot and judges it. */
export type Filter = (
  launch: TokenLaunch,
  snapshot: TokenSnapshot
) => Promise<FilterResult>;
