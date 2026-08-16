import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const Schedule = z.array(z.object({ untilSec: z.number(), everySec: z.number() }));

const Strategy = z.object({
  version: z.number(),
  thresholds: z.object({
    minLiquidityUsd: z.number(),
    maxTop10HolderPct: z.number(),
    minHolders: z.number(),
    bundledSupplyHardBlockPct: z.number(),
  }),
  ingestion: z.object({
    fullPipelineSources: z.array(z.string()),
    rawOnlySources: z.array(z.string()),
  }),
  snapshots: z.object({
    schedule: Schedule,
    /** Token ages (seconds) at which the metered chain-state read runs. */
    chainStateAtSec: z.array(z.number()),
    /** Token ages (seconds) at which the metered DAS holder read runs. */
    holdersAtSec: z.array(z.number()),
  }),
  swaps: z.object({
    bucketSec: z.number(),
    pumpswapRawWindowSec: z.number(),
    pumpfunRawWindowSlots: z.number(),
    maxRawPerToken: z.number(),
  }),
  alerts: z.object({ cooldownMinutes: z.number() }),
});

const path = join(dirname(fileURLToPath(import.meta.url)), "strategy.config.json");
const rawText = readFileSync(path, "utf8");

export const strategy = Strategy.parse(JSON.parse(rawText));

/** Hash of the exact config text — stored on every assessment (auditability). */
export const strategyHash = createHash("sha256").update(rawText).digest("hex").slice(0, 16);
