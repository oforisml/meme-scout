import { strategy } from "../strategy.js";
import type { Filter } from "../types.js";

export const liquidityFilter: Filter = async (_launch, snapshot) => {
  const evidence: string[] = [];

  // Insufficient data is not a pass. Liquidity is now really wired, so a null
  // here means the price source had no route for this mint — which for a
  // freshly graduated token usually means there is nothing to trade against.
  if (snapshot.liquidityUsd === null) {
    evidence.push("Liquidity unknown — no route found, cannot evaluate");
    return {
      name: "liquidity",
      passed: false,
      hardBlock: false,
      score: 0,
      evidence,
      insufficientData: true,
    };
  }

  const enough = snapshot.liquidityUsd >= strategy.thresholds.minLiquidityUsd;
  evidence.push(
    `Liquidity $${snapshot.liquidityUsd.toFixed(0)} vs minimum $${strategy.thresholds.minLiquidityUsd}`
  );

  // LP burn is a secondary signal: it shapes the score but never vetoes on its
  // own, and an unknown value is reported as unknown rather than silently
  // treated as "0% burned".
  const burned = snapshot.lpBurnedPct;
  if (burned === null) evidence.push("LP burn state unknown");
  else if (burned >= 95) evidence.push(`LP ${burned.toFixed(0)}% burned — cannot be pulled`);
  else evidence.push(`Only ${burned.toFixed(0)}% of LP burned — rug risk`);

  const score = !enough ? 0 : burned !== null && burned >= 95 ? 100 : 50;
  return { name: "liquidity", passed: enough, hardBlock: !enough, score, evidence };
};
