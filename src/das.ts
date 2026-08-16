import { HELIUS_RPC } from "./config.js";
import { logger } from "./logger.js";

/**
 * Helius DAS access.
 *
 * `getTokenAccounts` is the only practical way to count holders, but note two
 * things. First, the parameter object is passed bare, NOT wrapped in an array
 * — array-wrapping returns `-32602 invalid type: map, expected a string`.
 * Second, it counts token *accounts*, and the threshold we compare against
 * (`minHolders`) is about people, so we also return the distinct owner count.
 *
 * DAS is rate limited far more tightly than plain RPC on the free tier (2/s
 * against 10/s), which is why the recorder only calls this at a few fixed
 * ages rather than on every snapshot tick.
 */

const PAGE_LIMIT = 1000;
/** Fresh meme coins have tens to hundreds of holders; this is a runaway guard. */
const MAX_PAGES = 3;

export interface HolderStats {
  tokenAccounts: number;
  uniqueOwners: number;
  truncated: boolean;
}

export async function holderStats(mint: string): Promise<HolderStats | null> {
  const owners = new Set<string>();
  let accounts = 0;
  let cursor: string | undefined;
  let pages = 0;

  try {
    do {
      const res = await fetch(HELIUS_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "holder-stats",
          method: "getTokenAccounts",
          params: { mint, limit: PAGE_LIMIT, options: { showZeroBalance: false }, ...(cursor ? { cursor } : {}) },
        }),
      });
      const json: any = await res.json();
      if (json.error) throw new Error(json.error.message ?? "DAS error");

      const page = json.result?.token_accounts ?? [];
      accounts += page.length;
      for (const account of page) if (account.owner) owners.add(account.owner);

      cursor = page.length === PAGE_LIMIT ? json.result?.cursor : undefined;
      pages++;
    } while (cursor && pages < MAX_PAGES);

    return { tokenAccounts: accounts, uniqueOwners: owners.size, truncated: Boolean(cursor) };
  } catch (err) {
    logger.warn({ err, mint }, "DAS holder lookup failed");
    return null;
  }
}
