/**
 * Read-only probe of every external data source the recorder depends on.
 *
 * API response shapes drift, and a wrong assumption here reintroduces exactly
 * the nulls this phase exists to remove. Run this against real mints from the
 * live database BEFORE trusting recorder changes:
 *
 *   npx tsx scripts/probe.ts
 *
 * It writes nothing and takes a handful of RPC calls.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { HELIUS_RPC } from "../src/config.js";
import { db } from "../src/db/db.js";
import { holderStats } from "../src/das.js";
import { deriveLpMint, extractPool } from "../src/recorder/pool.js";
import { marketData, refreshMarketData } from "../src/prices.js";

const connection = new Connection(HELIUS_RPC, "confirmed");
const SAMPLE = Number(process.argv[2] ?? 3);

const rows = db
  .prepare(`SELECT mint, first_signature, source FROM tokens ORDER BY observed_at DESC LIMIT ?`)
  .all(SAMPLE) as { mint: string; first_signature: string; source: string }[];

if (rows.length === 0) {
  console.log("No tokens recorded yet — run the recorder first.");
  process.exit(0);
}

console.log(`\n=== 1. Jupiter price v3 (batched, ${rows.length} mints) ===`);
await refreshMarketData(rows.map((r) => r.mint));
for (const row of rows) {
  const data = await marketData(row.mint);
  console.log(
    `  ${row.mint.slice(0, 10)}…  price=${data?.priceUsd ?? "NULL"}  liquidity=${
      data?.liquidityUsd === null || data?.liquidityUsd === undefined
        ? "NULL"
        : "$" + Math.round(data.liquidityUsd).toLocaleString()
    }`
  );
}

for (const row of rows) {
  console.log(`\n=== ${row.mint.slice(0, 10)}… (${row.source}) ===`);

  const tx = await connection.getParsedTransaction(row.first_signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) {
    console.log("  tx not available (may have been pruned)");
    continue;
  }

  const found = extractPool(tx, row.mint);
  console.log(`  pool        : ${found?.pool ?? "NOT FOUND"}`);
  console.log(`  base vault  : ${found?.baseVault ?? "-"}`);

  if (found) {
    const lpMint = deriveLpMint(found.pool);
    const supply = await connection.getTokenSupply(new PublicKey(lpMint)).catch(() => null);
    console.log(
      `  lp mint     : ${lpMint} ${
        supply ? `(exists, supply ${supply.value.uiAmountString}) -> pool address CONFIRMED` : "(no such mint)"
      }`
    );
  }

  const [mintInfo, largest] = await Promise.all([
    connection.getParsedAccountInfo(new PublicKey(row.mint)),
    connection.getTokenLargestAccounts(new PublicKey(row.mint)).catch(() => null),
  ]);
  const info: any = (mintInfo.value?.data as any)?.parsed?.info;
  const supply = Number(info?.supply ?? 0);

  if (largest?.value?.length && supply > 0) {
    const raw = largest.value.slice(0, 10).reduce((sum, a) => sum + Number(a.amount), 0);
    const excluded = largest.value
      .filter((a) => a.address.toBase58() !== found?.baseVault)
      .slice(0, 10)
      .reduce((sum, a) => sum + Number(a.amount), 0);
    console.log(`  top10 raw   : ${((raw / supply) * 100).toFixed(2)}%  <- inflated by the pool vault`);
    console.log(`  top10 net   : ${((excluded / supply) * 100).toFixed(2)}%  <- vault excluded`);
  }

  const holders = await holderStats(row.mint);
  console.log(
    `  holders     : ${holders ? `${holders.tokenAccounts} accounts / ${holders.uniqueOwners} owners` : "NULL"}`
  );
}

console.log("");
