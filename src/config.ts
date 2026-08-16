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
