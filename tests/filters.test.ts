import assert from "node:assert/strict";
import { test } from "node:test";
import { holdersFilter } from "../src/filters/holders.js";
import { liquidityFilter } from "../src/filters/liquidity.js";
import { mintAuthorityFilter } from "../src/filters/mintAuthority.js";
import { runPipeline } from "../src/filters/pipeline.js";
import { strategy, strategyHash } from "../src/strategy.js";
import type { TokenLaunch, TokenSnapshot } from "../src/types.js";

const launch: TokenLaunch = {
  mint: "TESTMINT", pool: null, creator: null, source: "pumpswap",
  kind: "graduation", signature: "sig", slot: 1, observedAt: Date.now(),
};

function snap(overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    mint: "TESTMINT", takenAt: Date.now(), priceUsd: null, liquidityUsd: null,
    holderCount: null, top10HolderPct: null, mintAuthorityActive: false,
    freezeAuthorityActive: false, lpBurnedPct: null, ...overrides,
  };
}

// ---- mint authority --------------------------------------------------------
test("active mint authority hard-blocks", async () => {
  const r = await mintAuthorityFilter(launch, snap({ mintAuthorityActive: true }));
  assert.equal(r.hardBlock, true);
  assert.equal(r.passed, false);
});

test("active freeze authority hard-blocks", async () => {
  const r = await mintAuthorityFilter(launch, snap({ freezeAuthorityActive: true }));
  assert.equal(r.hardBlock, true);
});

test("revoked authorities pass with full score", async () => {
  const r = await mintAuthorityFilter(launch, snap());
  assert.equal(r.passed, true);
  assert.equal(r.score, 100);
});

test("unknown authority state does not hard-block", async () => {
  const r = await mintAuthorityFilter(launch, snap({ mintAuthorityActive: null, freezeAuthorityActive: null }));
  assert.equal(r.hardBlock, false);
  assert.match(r.evidence.join(" "), /unknown/i);
});

// ---- liquidity --------------------------------------------------------------
test("liquidity below minimum hard-blocks", async () => {
  const r = await liquidityFilter(launch, snap({ liquidityUsd: strategy.thresholds.minLiquidityUsd - 1 }));
  assert.equal(r.hardBlock, true);
});

test("null liquidity degrades gracefully (passes, reduced score)", async () => {
  const r = await liquidityFilter(launch, snap({ liquidityUsd: null }));
  assert.equal(r.passed, true);
  assert.ok(r.score < 100);
});

test("burned LP scores higher than unburned", async () => {
  const burned = await liquidityFilter(launch, snap({ liquidityUsd: 50_000, lpBurnedPct: 100 }));
  const held = await liquidityFilter(launch, snap({ liquidityUsd: 50_000, lpBurnedPct: 0 }));
  assert.ok(burned.score > held.score);
});

// ---- holders -----------------------------------------------------------------
test("excess top-10 concentration fails without hard block", async () => {
  const r = await holdersFilter(launch, snap({ top10HolderPct: strategy.thresholds.maxTop10HolderPct + 10 }));
  assert.equal(r.passed, false);
  assert.equal(r.hardBlock, false);
});

test("holder count below minimum fails", async () => {
  const r = await holdersFilter(launch, snap({ top10HolderPct: 20, holderCount: strategy.thresholds.minHolders - 1 }));
  assert.equal(r.passed, false);
});

// ---- pipeline ------------------------------------------------------------------
test("pipeline short-circuits on hard block (later filters do not run)", async () => {
  const a = await runPipeline(launch, snap({ freezeAuthorityActive: true }));
  assert.equal(a.passed, false);
  assert.equal(a.results.length, 1);
  assert.equal(a.results[0].name, "mint-authority");
});

test("clean snapshot passes full pipeline (creator null skips RPC)", async () => {
  const a = await runPipeline(launch, snap({ liquidityUsd: 50_000, top10HolderPct: 20, holderCount: 200, lpBurnedPct: 100 }));
  assert.equal(a.passed, true);
  assert.equal(a.results.length, 4);
});

// ---- strategy config -------------------------------------------------------------
test("strategy hash is stable and 16 hex chars", () => {
  assert.match(strategyHash, /^[0-9a-f]{16}$/);
});
