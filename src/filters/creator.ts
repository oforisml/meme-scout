import { Connection, PublicKey } from "@solana/web3.js";
import { HELIUS_RPC } from "../config.js";
import type { Filter } from "../types.js";

const connection = new Connection(HELIUS_RPC, "confirmed");

/**
 * Cheap creator heuristics from wallet age / activity.
 * A brand-new wallet that deployed a token minutes after being funded is a
 * classic serial-rugger pattern. Real creator intelligence (linked wallets,
 * past rugs) comes later — record everything now, analyse later.
 */
export const creatorFilter: Filter = async (launch) => {
  const evidence: string[] = [];
  if (!launch.creator) {
    return { name: "creator", passed: true, hardBlock: false, score: 40, evidence: ["Creator unknown"] };
  }

  try {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(launch.creator), { limit: 25 });
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
    };
  } catch {
    return { name: "creator", passed: true, hardBlock: false, score: 40, evidence: ["Creator lookup failed"] };
  }
};
