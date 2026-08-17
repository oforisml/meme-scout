import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const Env = z.object({
  HELIUS_API_KEY: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
  DB_PATH: z.string().default("./data/meme-scout.db"),
  // Optional. Jupiter's keyless lite-api still answers, but carries a
  // deprecation notice dated 2025-12-31; a free key from portal.jup.ag moves
  // us to the keyed host (60 req/min) before that bites.
  JUPITER_API_KEY: z.string().optional().default(""),
  // rclone remote for FR-G1 dataset backups, e.g. "b2:meme-scout-backups".
  // Empty means backups are not configured, which the staleness check treats
  // as DISABLED rather than failing — otherwise a fresh clone alerts forever.
  BACKUP_RCLONE_REMOTE: z.string().optional().default(""),
  /**
   * Ingest scope, sized to your Helius plan. free | developer | business |
   * custom. Anything but "custom" overrides the venue toggles in
   * strategy.config.json. See src/ingest/profile.ts for the measured cost of
   * each venue — the full set is ~71M credits/month against a 1M free tier.
   */
  INGEST_PROFILE: z.enum(["free", "developer", "business", "custom"]).default("developer"),
  /** Monthly credit allowance to stay under. Free 1M, Developer 10M, Business 100M. */
  HELIUS_MONTHLY_CREDITS: z.coerce.number().default(1_000_000),
  /**
   * Hard ceiling on GB streamed per UTC day — a backstop independent of the
   * credit arithmetic, which rests on an unverified 20-credits/MB rate. If
   * that rate is wrong the credit guard under-counts; this one cannot, because
   * bytes are measured directly. Default 2 GB ≈ the free tier's 1.67 GB/day
   * with a little slack. Set 0 to disable (not advised).
   */
  MAX_STREAM_GB_PER_DAY: z.coerce.number().default(2),
  /**
   * Credits Helius charges per MB of websocket traffic.
   *
   * Documented as 20 (2 credits per 0.1 MB) and NOT verified against their own
   * usage figures — the admin usage API rejects an ordinary RPC key. Bounded
   * empirically on 2026-08-16: 316 minutes of streaming at a measured
   * 118 GB/day exhausted a 1M allowance that already had prior usage on it, so
   * the true rate is at most ~38.6 and the documented 20 is consistent.
   * Correct it here once `helius usage --json` or the dashboard shows the real
   * number; nothing else needs changing.
   */
  CREDITS_PER_MB: z.coerce.number().default(20),
});

export const config = Env.parse(process.env);

export const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
export const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;

// Program IDs we watch for new pools / launches / graduations
export const PROGRAMS = {
  RAYDIUM_AMM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  PUMP_FUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  // Since 2025-03-20 pump.fun tokens graduate to PumpSwap, NOT Raydium.
  PUMPSWAP: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  // LetsBonk launches run on Raydium LaunchLab. Verified 2026-08-16 against
  // Raydium's published program addresses and against live traffic (observed
  // launches resolve to `…bonk` vanity mints) — open decision #8 is closed.
  RAYDIUM_LAUNCHLAB: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
} as const;

/** Call at startup (not import time) so pure unit tests can import modules. */
export function assertRuntimeConfig(): void {
  assertNotMigrated();
  if (!config.HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY is required — copy .env.example to .env and set it");
  }
}

/**
 * Refuse to start against a dataset that has been handed to another host.
 *
 * The recorder holds the only write handle. After `scripts/migrate-host.sh`
 * both machines hold a complete, writable copy, and starting both would give
 * two datasets diverging from a common ancestor — with no way to reconcile
 * them and no way to tell afterwards which rows came from where. For a Phase 3
 * verdict that is unrecoverable, so it is prevented by construction rather
 * than by the operator remembering which laptop is the live one.
 *
 * Checked here rather than in db.ts because db.ts is also imported by tooling
 * that only reads, and a read on a sealed host is harmless.
 */
export function assertNotMigrated(): void {
  const marker = join(dirname(config.DB_PATH), ".migrated-to");
  if (!existsSync(marker)) return;
  const target = readFileSync(marker, "utf8").trim().split("\n")[0];
  throw new Error(
    `This dataset was migrated to ${target}. Starting a second recorder against it ` +
      `would fork the dataset. If that host is genuinely gone, delete ${marker} first.`
  );
}

/**
 * Separate from assertRuntimeConfig on purpose: a backup job has no reason to
 * require a Helius key, and the recorder has no reason to require a backup
 * remote. Neither should be able to block the other from starting.
 */
export function assertBackupConfig(): void {
  if (!config.BACKUP_RCLONE_REMOTE) {
    throw new Error("BACKUP_RCLONE_REMOTE is required for backups — see docs/RUNBOOK.md");
  }
}
