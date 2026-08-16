import { strategy } from "../strategy.js";
import type { Filter } from "../types.js";

export const holdersFilter: Filter = async (_launch, snapshot) => {
  const evidence: string[] = [];
  let score = 50;
  let passed = true;

  if (snapshot.top10HolderPct !== null) {
    evidence.push(`Top 10 holders own ${snapshot.top10HolderPct.toFixed(1)}% of supply`);
    if (snapshot.top10HolderPct > strategy.thresholds.maxTop10HolderPct) {
      passed = false;
      score = 10;
      evidence.push(`Exceeds ${strategy.thresholds.maxTop10HolderPct}% concentration threshold`);
    } else {
      score = 100 - snapshot.top10HolderPct;
    }
  } else {
    evidence.push("Holder concentration unknown");
  }

  if (snapshot.holderCount !== null) {
    evidence.push(`${snapshot.holderCount} holders`);
    if (snapshot.holderCount < strategy.thresholds.minHolders) passed = false;
  }

  // Concentration is a strong warning but not an automatic hard block:
  // very young tokens are always concentrated. The score reflects it.
  return { name: "holders", passed, hardBlock: false, score, evidence };
};
