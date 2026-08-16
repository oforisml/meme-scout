import { PublicKey } from "@solana/web3.js";

/**
 * PumpSwap swap decoding.
 *
 * Post-graduation trading. These events arrive on the PumpSwap log
 * subscription we already hold, so every swap costs zero RPC — the same
 * property that made pump.fun CreateEvent decoding worth doing.
 *
 * This is the data H1 is stated in. The hypothesis is about "unique-buyer
 * growth without wash signatures", which needs the wallet behind each trade;
 * a price feed cannot answer it.
 *
 * Field offsets were derived empirically from live traffic, not from a
 * vendored IDL, and verified against 13,249 consecutive live events with zero
 * decode failures. Event length varies (417-480 bytes seen) because trailing
 * fee fields differ between versions, so only the fixed prefix is read.
 */

const PROGRAM_DATA_PREFIX = "Program data:";

/** sha256("event:BuyEvent") / ("event:SellEvent"), first 8 bytes. */
const BUY = "67f4521f2cf57777";
const SELL = "3e2f370aa503dc2a";

/** Fixed-prefix offsets, confirmed against live traffic. */
const OFF_TIMESTAMP = 8;
const OFF_BASE_AMOUNT = 16; // token side, 6dp
const OFF_QUOTE_AMOUNT = 64; // SOL side, 9dp — the amount actually transacted
const OFF_POOL = 120;
const OFF_USER = 152;
const MIN_LEN = OFF_USER + 32;

/** Sanity ceiling on either raw leg (1e15 = 1M SOL, or 1e9 whole tokens). */
const MAX_RAW = 1e18;

export interface PumpSwapTrade {
  pool: string;
  wallet: string;
  side: "buy" | "sell";
  /**
   * RAW positional amounts. Which one is SOL depends on how the pool was
   * created — pools exist in both orientations — so this decoder deliberately
   * does not guess. Resolve with `denominate()` once the pair is known.
   */
  baseAmountRaw: bigint;
  quoteAmountRaw: bigint;
  chainTs: number | null; // unix ms
}

/**
 * Split the positional amounts into SOL and token, given which side our token
 * sits on. SOL has 9 decimals, the memecoin 6.
 */
export function denominate(
  t: PumpSwapTrade,
  mintIsBase: boolean
): { solAmount: number; tokenAmount: number } {
  const tokenRaw = mintIsBase ? t.baseAmountRaw : t.quoteAmountRaw;
  const solRaw = mintIsBase ? t.quoteAmountRaw : t.baseAmountRaw;
  return { solAmount: Number(solRaw) / 1e9, tokenAmount: Number(tokenRaw) / 1e6 };
}

let decodeFailures = 0;
let anomalies = 0;
export function pumpSwapDecodeFailures(): number {
  return decodeFailures;
}
/** Structurally valid but implausible values — a layout drift smoke alarm. */
export function pumpSwapAnomalies(): number {
  return anomalies;
}

/**
 * sha256("event:CreatePoolEvent") — emitted when a pump.fun curve completes and
 * its liquidity migrates to PumpSwap.
 *
 * Migration transactions mention BOTH programs, so this event arrives on the
 * pump.fun stream too — verified against 112 stored rows. That is what lets us
 * drop the PumpSwap subscription (88% of the credit bill) without losing
 * graduation detection.
 */
const CREATE_POOL = "b1310cd2a076a774";

export function hasPumpSwapCreatePool(logs: string[]): boolean {
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    try {
      const buf = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length).trim(), "base64");
      if (buf.length >= 8 && buf.subarray(0, 8).toString("hex") === CREATE_POOL) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** All swap events in one notification's logs. Usually zero or one. */
export function decodeSwaps(logs: string[]): PumpSwapTrade[] {
  const out: PumpSwapTrade[] = [];

  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;

    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length).trim(), "base64");
    } catch {
      continue;
    }
    if (buf.length < MIN_LEN) continue;

    const disc = buf.subarray(0, 8).toString("hex");
    const side = disc === BUY ? "buy" : disc === SELL ? "sell" : null;
    if (!side) continue;

    try {
      const baseAmountRaw = buf.readBigUInt64LE(OFF_BASE_AMOUNT);
      const quoteAmountRaw = buf.readBigUInt64LE(OFF_QUOTE_AMOUNT);
      // Whichever side is SOL, neither leg of a memecoin swap is astronomical.
      // A spike here is how we would learn the layout moved.
      if (Number(baseAmountRaw) > MAX_RAW || Number(quoteAmountRaw) > MAX_RAW) {
        anomalies++;
        continue;
      }
      const seconds = Number(buf.readBigInt64LE(OFF_TIMESTAMP));
      out.push({
        pool: new PublicKey(buf.subarray(OFF_POOL, OFF_POOL + 32)).toBase58(),
        wallet: new PublicKey(buf.subarray(OFF_USER, OFF_USER + 32)).toBase58(),
        side,
        baseAmountRaw,
        quoteAmountRaw,
        chainTs: seconds > 0 ? seconds * 1000 : null,
      });
    } catch {
      decodeFailures++;
    }
  }
  return out;
}
