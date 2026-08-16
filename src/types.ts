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

/** Snapshot of on-chain state at a moment in time. Everything is timestamped. */
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
}

export interface FilterResult {
  name: string;
  passed: boolean;
  hardBlock: boolean; // hard blocks stop the pipeline immediately
  score: number; // 0..100 contribution
  evidence: string[];
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
