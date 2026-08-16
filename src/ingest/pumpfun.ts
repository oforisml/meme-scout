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
