import { PublicKey } from "@solana/web3.js";

/**
 * pump.fun CreateEvent decoding.
 *
 * pump.fun emits an Anchor event as a base64 `Program data:` log line on every
 * token creation, and we already receive those logs from the websocket. That
 * means the mint, the creator and the on-chain timestamp are available for
 * FREE — no RPC call, no transaction fetch.
 *
 * This matters twice over:
 *
 * 1. It is what lets the raw-only tier record a real, queryable launch instead
 *    of 7.5 KB of program logs with a null mint. Before this, `raw_events` was
 *    89% of the database and could not be joined to anything.
 * 2. Presence of a CreateEvent is a far better definition of "this is a launch"
 *    than the old substring test. `"Instruction: Create"` also matches
 *    `Instruction: CreateIdempotent`, which fires whenever an associated token
 *    account is created — i.e. on ordinary buys. 28% of what we captured as
 *    pump.fun launches were actually trades on existing tokens.
 *
 * Verified against 4118 stored events: 2990 CreateEvents decoded, 0 failures.
 */

const PROGRAM_DATA_PREFIX = "Program data:";

/**
 * sha256("event:CreateEvent"), first 8 bytes — the Anchor event discriminator.
 *
 * Only this one. `b1310cd2a076a774` looks create-shaped at a glance and was
 * briefly treated as a second variant, but its body begins with an i64 unix
 * timestamp rather than a length-prefixed name, so it is a different event
 * entirely. Accepting it produced 112 decode failures against the stored
 * corpus and zero extra launches.
 */
const CREATE_DISCRIMINATORS = new Set(["1b72a94ddeeb6376"]);

export interface PumpFunLaunch {
  mint: string;
  bondingCurve: string;
  /** Transaction signer that submitted the create. */
  user: string;
  /** Declared creator; usually equals `user` but not always. */
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  /** On-chain event time in unix ms. Distinct from when WE observed it. */
  chainTs: number | null;
}

/** Decode failures seen since start. A silent rise means the layout changed. */
let decodeFailures = 0;
export function pumpFunDecodeFailures(): number {
  return decodeFailures;
}

/**
 * Returns the decoded launch, or null when these logs are not a token
 * creation. Null is a normal, expected answer — it is how we tell a launch
 * from a trade.
 */
export function decodeCreateEvent(logs: string[]): PumpFunLaunch | null {
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;

    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length).trim(), "base64");
    } catch {
      continue;
    }
    if (buf.length < 8) continue;
    if (!CREATE_DISCRIMINATORS.has(buf.subarray(0, 8).toString("hex"))) continue;

    try {
      return decodeBody(buf);
    } catch {
      // A layout change must degrade to "not recognised", never crash the
      // listener — but it must not be silent either.
      decodeFailures++;
      return null;
    }
  }
  return null;
}

/**
 * Bonding-curve trades, before graduation. Needed for FR-H1's launch-window
 * capture, which is what bundle and sniper forensics are computed from later.
 *
 * sha256("event:TradeEvent"). Offsets verified against 2218 stored events:
 * zero invalid bools (both values present), zero implausible timestamps, zero
 * pubkey failures. Lengths vary 358-407, so read only the fixed prefix.
 */
const TRADE_DISCRIMINATOR = "bddb7fd34ee661ee";
const T_MINT = 8;
const T_SOL = 40;
const T_TOKEN = 48;
const T_IS_BUY = 56;
const T_USER = 57;
const T_TS = 89;
const T_MIN_LEN = T_TS + 8;
const MAX_LAMPORTS = 1e15;

export interface PumpFunTrade {
  mint: string;
  wallet: string;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  chainTs: number | null;
}

let tradeAnomalies = 0;
export function pumpFunTradeAnomalies(): number {
  return tradeAnomalies;
}

/** All bonding-curve trades in one notification's logs. */
export function decodeTrades(logs: string[]): PumpFunTrade[] {
  const out: PumpFunTrade[] = [];

  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;

    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length).trim(), "base64");
    } catch {
      continue;
    }
    if (buf.length < T_MIN_LEN) continue;
    if (buf.subarray(0, 8).toString("hex") !== TRADE_DISCRIMINATOR) continue;

    try {
      const flag = buf[T_IS_BUY];
      const rawSol = buf.readBigUInt64LE(T_SOL);
      if (flag > 1 || Number(rawSol) > MAX_LAMPORTS) {
        tradeAnomalies++;
        continue;
      }
      const seconds = Number(buf.readBigInt64LE(T_TS));
      out.push({
        mint: new PublicKey(buf.subarray(T_MINT, T_MINT + 32)).toBase58(),
        wallet: new PublicKey(buf.subarray(T_USER, T_USER + 32)).toBase58(),
        side: flag === 1 ? "buy" : "sell",
        solAmount: Number(rawSol) / 1e9,
        tokenAmount: Number(buf.readBigUInt64LE(T_TOKEN)) / 1e6,
        chainTs: seconds > 0 ? seconds * 1000 : null,
      });
    } catch {
      decodeFailures++;
    }
  }
  return out;
}

function decodeBody(buf: Buffer): PumpFunLaunch {
  let offset = 8; // discriminator

  const readString = (): string => {
    const len = buf.readUInt32LE(offset);
    offset += 4;
    if (len > buf.length - offset) throw new Error("string overruns buffer");
    const value = buf.subarray(offset, offset + len).toString("utf8");
    offset += len;
    return value;
  };

  const readPubkey = (): string => {
    if (offset + 32 > buf.length) throw new Error("pubkey overruns buffer");
    const key = new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return key;
  };

  const name = readString();
  const symbol = readString();
  const uri = readString();
  const mint = readPubkey();
  const bondingCurve = readPubkey();
  const user = readPubkey();

  // Everything past `user` is a later addition to the event. Treat it as
  // optional so an older or truncated layout still yields the useful fields.
  let creator = user;
  let chainTs: number | null = null;
  if (offset + 40 <= buf.length) {
    creator = readPubkey();
    const seconds = Number(buf.readBigInt64LE(offset));
    offset += 8;
    if (Number.isFinite(seconds) && seconds > 0) chainTs = seconds * 1000;
  }

  return { mint, bondingCurve, user, creator, name, symbol, uri, chainTs };
}
