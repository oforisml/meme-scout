import { strategy } from "../strategy.js";
import type { Filter } from "../types.js";

export const liquidityFilter: Filter = async (_launch, snapshot) => {
  const evidence: string[] = [];

  if (snapshot.liquidityUsd === null) {
    evidence.push("Liquidity unknown — treat with caution, not a hard block yet");
    return { name: "liquidity", passed: true, hardBlock: false, score: 40, evidence };
  }

  const enough = snapshot.liquidityUsd >= strategy.thresholds.minLiquidityUsd;
  evidence.push(
    `Liquidity $${snapshot.liquidityUsd.toFixed(0)} vs minimum $${strategy.thresholds.minLiquidityUsd}`
  );

  const burned = snapshot.lpBurnedPct ?? 0;
  if (burned >= 95) evidence.push(`LP ${burned.toFixed(0)}% burned — cannot be pulled`);
  else if (snapshot.lpBurnedPct !== null) evidence.push(`Only ${burned.toFixed(0)}% of LP burned — rug risk`);

  const score = !enough ? 0 : burned >= 95 ? 100 : 50;
  return { name: "liquidity", passed: enough, hardBlock: !enough, score, evidence };
};
