import { Connection, PublicKey } from "@solana/web3.js";
import { HELIUS_RPC } from "../config.js";
import type { Filter, FilterResult } from "../types.js";

const connection = new Connection(HELIUS_RPC, "confirmed");

/**
 * Cheap creator heuristics from wallet age / activity.
 * A brand-new wallet that deployed a token minutes after being funded is a
 * classic serial-rugger pattern. Real creator intelligence (linked wallets,
 * past rugs) comes later — record everything now, analyse later.
 */
export const creatorFilter: Filter = async (launch) => {
  const evidence: string[] = [];

  // Insufficient data is not a pass. Creator resolution has been reliable in
  // practice (non-null on every recorded token), so failing closed here costs
  // nothing real.
  if (!launch.creator) {
    return {
      name: "creator",
      passed: false,
      hardBlock: false,
      score: 0,
      evidence: ["Creator unknown — cannot evaluate"],
      insufficientData: true,
    };
  }

  const sigs = await lookupWithRetry(launch.creator);

  // A failed lookup is an infrastructure fault, not a property of the token.
  // Vetoing on it would let a flaky RPC silently zero the alert rate, so this
  // one case stays exempt from the strict rule — but it is marked so the
  // effect stays measurable rather than invisible.
  if (sigs === null) {
    return {
      name: "creator",
      passed: true,
      hardBlock: false,
      score: 40,
      evidence: ["Creator lookup failed after retry — not counted against the token"],
      insufficientData: true,
    };
  }

  const count = sigs.length;
  const oldest = sigs[sigs.length - 1]?.blockTime ?? null;
  const ageMinutes = oldest ? (Date.now() / 1000 - oldest) / 60 : null;

  evidence.push(`Creator has ${count}${count === 25 ? "+" : ""} recent transactions`);
  if (ageMinutes !== null) evidence.push(`Oldest visible activity ~${ageMinutes.toFixed(0)} min ago`);

  const freshThrowaway = count < 5 || (ageMinutes !== null && ageMinutes < 60);
  if (freshThrowaway) evidence.push("Looks like a fresh throwaway wallet — common rug pattern");

  return {
    name: "creator",
    passed: true,
    hardBlock: false,
    score: freshThrowaway ? 20 : 70,
    evidence,
  } satisfies FilterResult;
};

async function lookupWithRetry(creator: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await connection.getSignaturesForAddress(new PublicKey(creator), { limit: 25 });
    } catch {
      if (attempt === 1) return null;
    }
  }
  return null;
}
