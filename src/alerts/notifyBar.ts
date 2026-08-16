import { strategy } from "../strategy.js";
import type { TokenSnapshot } from "../types.js";

/**
 * Whether a passing candidate is worth interrupting the operator for.
 *
 * Deliberately separate from the pass/fail thresholds. Passing decides what the
 * DATASET records — every pass gets an alerts row and FR-A6 cost quotes — while
 * this decides only what reaches Telegram.
 *
 * Collapsing the two would be the obvious way to quieten the channel and the
 * wrong one: alert volume is also the execution-cost sampling rate, so raising
 * the pass bar to send fewer messages would cut the cost dataset by the same
 * factor, and it would cut it precisely at the marginal candidates that reveal
 * where the liquidity cliff sits.
 *
 * A channel that fires 17 times an hour is a channel you learn to ignore, which
 * is worse than no alerting at all — see the same argument in FR-G2's daily
 * ping.
 */
export interface NotifyVerdict {
  notify: boolean;
  /** Why it was held back — logged, so a silent channel is explicable. */
  reason: string;
}

export function meetsNotifyBar(snapshot: TokenSnapshot): NotifyVerdict {
  const bar = strategy.alerts.notify;
  const held: string[] = [];

  if (snapshot.liquidityUsd === null || snapshot.liquidityUsd < bar.minLiquidityUsd) {
    held.push(`liquidity ${fmt(snapshot.liquidityUsd)} < ${bar.minLiquidityUsd}`);
  }
  if (snapshot.top10HolderPct === null || snapshot.top10HolderPct > bar.maxTop10HolderPct) {
    held.push(`top10 ${fmt(snapshot.top10HolderPct)}% > ${bar.maxTop10HolderPct}%`);
  }
  if (snapshot.holderCount === null || snapshot.holderCount < bar.minHolders) {
    held.push(`holders ${fmt(snapshot.holderCount)} < ${bar.minHolders}`);
  }

  return held.length === 0
    ? { notify: true, reason: "meets notify bar" }
    : { notify: false, reason: held.join("; ") };
}

function fmt(v: number | null): string {
  return v === null ? "unknown" : Math.round(v).toString();
}
