import { strategy } from "../strategy.js";
import type { Filter } from "../types.js";

export const holdersFilter: Filter = async (_launch, snapshot) => {
  const evidence: string[] = [];

  // Insufficient data is not a pass. Concentration is null when we could not
  // confirm the pool, because an unadjusted figure counts the pool's own vault
  // as a holder and reads ~100% for essentially every token.
  const missing: string[] = [];
  if (snapshot.top10HolderPct === null) missing.push("holder concentration");
  if (snapshot.holderCount === null) missing.push("holder count");
  if (missing.length > 0) {
    evidence.push(`Cannot evaluate — ${missing.join(" and ")} unknown`);
    return {
      name: "holders",
      passed: false,
      hardBlock: false,
      score: 0,
      evidence,
      insufficientData: true,
    };
  }

  const top10 = snapshot.top10HolderPct as number;
  const count = snapshot.holderCount as number;
  let passed = true;
  let score = 50;

  evidence.push(`Top 10 holders own ${top10.toFixed(1)}% of supply (pool vault excluded)`);
  if (top10 > strategy.thresholds.maxTop10HolderPct) {
    passed = false;
    score = 10;
    evidence.push(`Exceeds ${strategy.thresholds.maxTop10HolderPct}% concentration threshold`);
  } else {
    score = 100 - top10;
  }

  evidence.push(`${count} distinct holders`);
  if (count < strategy.thresholds.minHolders) {
    passed = false;
    evidence.push(`Below ${strategy.thresholds.minHolders} holder minimum`);
  }

  // Concentration is a strong warning but not an automatic hard block:
  // very young tokens are always concentrated. The score reflects it.
  return { name: "holders", passed, hardBlock: false, score, evidence };
};
