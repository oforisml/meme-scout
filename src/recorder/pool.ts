import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { PROGRAMS } from "../config.js";

/**
 * Pool identification.
 *
 * Two of the four market fields need the pool address, and until now it was
 * never captured — `tokens.pool` was null for every row ever written. The
 * address is recoverable from the launch transaction the recorder already
 * fetches, so this costs no extra RPC.
 *
 * We deliberately do NOT read the pool out of a fixed account index. Across
 * real graduation transactions the PumpSwap CreatePool instruction carries 18
 * accounts and the position of the base mint is not stable — in half the
 * sampled transactions index 3 held WSOL rather than the token, because the
 * transaction touched two different mints. Instead we identify the pool
 * structurally: the pool is the account that both (a) owns a token account
 * for our mint in this transaction, and (b) appears in a PumpSwap
 * instruction. That test uses only data already present in the parsed
 * transaction.
 */

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const PUMPSWAP = new PublicKey(PROGRAMS.PUMPSWAP);

/** The associated token account address for (owner, mint). */
export function deriveAta(owner: string, mint: string): string {
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM
  );
  return ata.toBase58();
}

/**
 * PumpSwap's LP mint is a PDA of the pool, so it can be derived offline.
 * Deriving it and finding a real mint on chain also confirms that whatever we
 * think is the pool actually is one.
 */
export function deriveLpMint(pool: string): string {
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), new PublicKey(pool).toBuffer()],
    PUMPSWAP
  );
  return lpMint.toBase58();
}

/** Every account key touched by an instruction belonging to `programId`. */
function accountsTouchedByProgram(tx: ParsedTransactionWithMeta, programId: string): Set<string> {
  const all = [
    ...(tx.transaction.message.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
  ];
  const touched = new Set<string>();
  for (const ix of all as any[]) {
    if (ix.programId?.toString() !== programId) continue;
    for (const acc of ix.accounts ?? []) touched.add(acc.toString());
    // Parsed instructions expose named accounts rather than a positional list.
    for (const value of Object.values(ix.parsed?.info ?? {})) {
      if (typeof value === "string") touched.add(value);
    }
  }
  return touched;
}

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * PumpSwap `Pool` account layout, the part we need:
 * 8 discriminator | 1 bump | 2 index | 32 creator | 32 base_mint | 32 quote_mint
 *
 * Orientation is not fixed. Most pools are (memecoin base / WSOL quote), but
 * some are created the other way round, and the swap events report amounts
 * positionally as (base, quote). Assuming the common case silently reports a
 * token amount as if it were SOL — observed live at 31,772 "SOL" on a fresh
 * memecoin before this was caught.
 */
export function parsePoolMints(data: Buffer): { baseMint: string; quoteMint: string } | null {
  if (data.length < 107) return null;
  try {
    return {
      baseMint: new PublicKey(data.subarray(43, 75)).toBase58(),
      quoteMint: new PublicKey(data.subarray(75, 107)).toBase58(),
    };
  } catch {
    return null;
  }
}

/** SPL Mint: ...4 + 32 authority, then supply as u64 at offset 36. */
export function parseMintSupply(data: Buffer): bigint | null {
  if (data.length < 44) return null;
  return data.readBigUInt64LE(36);
}

/** Flat list of account keys, including any pulled in via lookup tables. */
function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  return (tx.transaction.message.accountKeys ?? []).map((k: any) =>
    (k.pubkey ?? k).toString()
  );
}

/**
 * Find the AMM pool that holds `mint` in this transaction.
 *
 * Returns the pool address and its base vault (the token account holding the
 * mint). The vault matters because it is normally the single largest holder
 * of a freshly graduated token — counting it as a "holder" makes every token
 * look ~100% concentrated. On a real sample, excluding it moved one token's
 * top-10 concentration from 87.5% to 27.7%.
 *
 * The vault is taken from the transaction's own token balances rather than
 * derived, because not every pool's vault is the canonical associated token
 * account — a derived address silently failed to match on real traffic.
 * `deriveAta` remains the fallback for that case.
 */
export interface PoolCandidate {
  pool: string;
  baseVault: string;
}

export function extractPoolCandidates(
  tx: ParsedTransactionWithMeta,
  mint: string,
  programId: string = PROGRAMS.PUMPSWAP
): PoolCandidate[] {
  const touched = accountsTouchedByProgram(tx, programId);
  if (touched.size === 0) return [];

  const keys = accountKeys(tx);
  const balances = [
    ...(tx.meta?.postTokenBalances ?? []),
    ...(tx.meta?.preTokenBalances ?? []),
  ].filter((b) => b.mint === mint && b.owner);

  const seen = new Set<string>();
  const candidates: PoolCandidate[] = [];
  for (const balance of balances) {
    const owner = balance.owner as string;
    if (!touched.has(owner) || seen.has(owner)) continue;
    seen.add(owner);
    candidates.push({ pool: owner, baseVault: keys[balance.accountIndex] ?? deriveAta(owner, mint) });
  }
  return candidates;
}

/**
 * Share of supply held by the ten largest holders, EXCLUDING the pool's own
 * vault.
 *
 * The vault is normally the single largest account of a freshly graduated
 * token, so counting it reports ~100% concentration for nearly everything. On
 * live samples, excluding it moved one token from 87.5% to 27.7%.
 *
 * Returns null when the vault is unknown, because an unadjusted figure is not
 * merely imprecise — it is reliably wrong in one direction.
 */
export function concentrationPct(
  accounts: { address: string; amount: string | number }[],
  supply: number,
  baseVault: string | null
): number | null {
  if (!baseVault || supply <= 0 || accounts.length === 0) return null;
  const circulating = accounts.filter((a) => a.address !== baseVault);
  const top10 = circulating.slice(0, 10).reduce((sum, a) => sum + Number(a.amount), 0);
  return (top10 / supply) * 100;
}

/** Back-compat single-answer form; prefer validating candidates against the LP mint. */
export function extractPool(
  tx: ParsedTransactionWithMeta,
  mint: string,
  programId: string = PROGRAMS.PUMPSWAP
): PoolCandidate | null {
  return extractPoolCandidates(tx, mint, programId)[0] ?? null;
}
