import type { Filter } from "../types.js";

/**
 * On Solana the closest thing to an EVM "honeypot check" is authority state:
 * - active mint authority  -> creator can print supply into your position
 * - active freeze authority -> creator can freeze YOUR token account (you cannot sell)
 * Both are hard blocks.
 */
export const mintAuthorityFilter: Filter = async (_launch, snapshot) => {
  const evidence: string[] = [];
  let hardBlock = false;

  if (snapshot.mintAuthorityActive === true) {
    hardBlock = true;
    evidence.push("Mint authority is still active — supply can be inflated at will");
  } else if (snapshot.mintAuthorityActive === false) {
    evidence.push("Mint authority revoked");
  } else {
    evidence.push("Mint authority state unknown (RPC gap)");
  }

  if (snapshot.freezeAuthorityActive === true) {
    hardBlock = true;
    evidence.push("Freeze authority is active — your token account can be frozen (cannot sell)");
  } else if (snapshot.freezeAuthorityActive === false) {
    evidence.push("Freeze authority revoked");
  }

  return {
    name: "mint-authority",
    passed: !hardBlock,
    hardBlock,
    score: hardBlock ? 0 : 100,
    evidence,
  };
};
