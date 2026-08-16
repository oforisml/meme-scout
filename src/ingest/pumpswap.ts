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

/** Sanity ceiling. A single memecoin swap is never a million SOL. */
const MAX_LAMPORTS = 1e15;

export interface PumpSwapTrade {
  pool: string;
  wallet: string;
  side: "buy" | "sell";
  solAmount: number; // SOL
  tokenAmount: number; // whole tokens (6dp)
  chainTs: number | null; // unix ms
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
      const rawQuote = buf.readBigUInt64LE(OFF_QUOTE_AMOUNT);
      if (Number(rawQuote) > MAX_LAMPORTS) {
        // Don't store it, but don't fail silently either: a spike here is how
        // we'd learn the layout moved.
        anomalies++;
        continue;
      }
      const seconds = Number(buf.readBigInt64LE(OFF_TIMESTAMP));
      out.push({
        pool: new PublicKey(buf.subarray(OFF_POOL, OFF_POOL + 32)).toBase58(),
        wallet: new PublicKey(buf.subarray(OFF_USER, OFF_USER + 32)).toBase58(),
        side,
        solAmount: Number(rawQuote) / 1e9,
        tokenAmount: Number(buf.readBigUInt64LE(OFF_BASE_AMOUNT)) / 1e6,
        chainTs: seconds > 0 ? seconds * 1000 : null,
      });
    } catch {
      decodeFailures++;
    }
  }
  return out;
}
