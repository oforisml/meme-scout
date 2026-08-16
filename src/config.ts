import "dotenv/config";
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
  if (!config.HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY is required — copy .env.example to .env and set it");
  }
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
