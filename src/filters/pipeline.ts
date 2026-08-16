import type { Assessment, Filter, TokenLaunch, TokenSnapshot } from "../types.js";
import { creatorFilter } from "./creator.js";
import { holdersFilter } from "./holders.js";
import { liquidityFilter } from "./liquidity.js";
import { mintAuthorityFilter } from "./mintAuthority.js";

// Ordered cheapest/most-decisive first. A hard block stops the pipeline.
const FILTERS: Filter[] = [mintAuthorityFilter, liquidityFilter, holdersFilter, creatorFilter];

export async function runPipeline(launch: TokenLaunch, snapshot: TokenSnapshot): Promise<Assessment> {
  const results = [];
  let blocked = false;

  for (const filter of FILTERS) {
    const result = await filter(launch, snapshot);
    results.push(result);
    if (result.hardBlock) {
      blocked = true;
      break;
    }
  }

  const totalScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const passed = !blocked && results.every((r) => r.passed);

  return { mint: launch.mint, assessedAt: Date.now(), passed, totalScore, results };
}
