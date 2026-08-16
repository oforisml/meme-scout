import type { Assessment, Filter, TokenLaunch, TokenSnapshot } from "../types.js";
import { creatorFilter } from "./creator.js";
import { holdersFilter } from "./holders.js";
import { liquidityFilter } from "./liquidity.js";
import { mintAuthorityFilter } from "./mintAuthority.js";

// Ordered cheapest/most-decisive first. A hard block stops the pipeline.
const FILTERS: Filter[] = [mintAuthorityFilter, liquidityFilter, holdersFilter, creatorFilter];

export async function runPipeline(
  launch: TokenLaunch,
  snapshot: TokenSnapshot,
  /** Injectable so tests can exercise the pipeline without network-backed filters. */
  filters: Filter[] = FILTERS
): Promise<Assessment> {
  const results = [];
  let blocked = false;

  for (const filter of filters) {
    const result = await filter(launch, snapshot);
    results.push(result);
    if (result.hardBlock) {
      blocked = true;
      break;
    }
  }

  // Filters that could not evaluate are left out of the score entirely. Giving
  // them a middling number implies a judgement that was never made — that is
  // how a token with no liquidity data and no holder data used to alert at
  // "53/100".
  const scored = results.filter((r) => !r.insufficientData);
  const totalScore = scored.length > 0 ? scored.reduce((sum, r) => sum + r.score, 0) / scored.length : 0;
  const passed = !blocked && results.every((r) => r.passed);

  return { mint: launch.mint, assessedAt: Date.now(), passed, totalScore, results };
}
