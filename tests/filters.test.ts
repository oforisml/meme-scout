import assert from "node:assert/strict";
import { test } from "node:test";
import { creatorFilter } from "../src/filters/creator.js";
import { holdersFilter } from "../src/filters/holders.js";
import { liquidityFilter } from "../src/filters/liquidity.js";
import { mintAuthorityFilter } from "../src/filters/mintAuthority.js";
import { runPipeline } from "../src/filters/pipeline.js";
import { concentrationPct, supportsPoolPipeline } from "../src/recorder/pool.js";
import { strategy, strategyHash } from "../src/strategy.js";
import type { Filter, TokenLaunch, TokenSnapshot } from "../src/types.js";

const launch: TokenLaunch = {
  mint: "TESTMINT", pool: null, creator: null, source: "pumpswap",
  kind: "graduation", signature: "sig", slot: 1, observedAt: Date.now(),
};

/** A snapshot with every field known and healthy; override to make it interesting. */
function snap(overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    mint: "TESTMINT", takenAt: Date.now(), priceUsd: 0.0001, liquidityUsd: 50_000,
    holderCount: 200, top10HolderPct: 20, mintAuthorityActive: false,
    freezeAuthorityActive: false, lpBurnedPct: 100, holderCountTruncated: false,
    chainStateAt: Date.now(), holderCountAt: Date.now(), ...overrides,
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

test("unknown authority state does not hard-block, but does not pass either", async () => {
  const r = await mintAuthorityFilter(launch, snap({ mintAuthorityActive: null, freezeAuthorityActive: null }));
  assert.equal(r.hardBlock, false);
  assert.equal(r.passed, false, "insufficient data must not read as safe");
  assert.equal(r.insufficientData, true);
  assert.match(r.evidence.join(" "), /unknown/i);
});

// ---- liquidity --------------------------------------------------------------
test("liquidity below minimum hard-blocks", async () => {
  const r = await liquidityFilter(launch, snap({ liquidityUsd: strategy.thresholds.minLiquidityUsd - 1 }));
  assert.equal(r.hardBlock, true);
});

test("null liquidity fails as insufficient data (does NOT degrade to a pass)", async () => {
  const r = await liquidityFilter(launch, snap({ liquidityUsd: null }));
  assert.equal(r.passed, false);
  assert.equal(r.insufficientData, true);
  assert.equal(r.score, 0);
});

test("burned LP scores higher than unburned", async () => {
  const burned = await liquidityFilter(launch, snap({ lpBurnedPct: 100 }));
  const held = await liquidityFilter(launch, snap({ lpBurnedPct: 0 }));
  assert.ok(burned.score > held.score);
});

test("unknown LP burn is reported as unknown, not as 0% burned", async () => {
  const r = await liquidityFilter(launch, snap({ lpBurnedPct: null }));
  assert.match(r.evidence.join(" "), /LP burn state unknown/);
  assert.doesNotMatch(r.evidence.join(" "), /0% of LP burned/);
});

// ---- holders -----------------------------------------------------------------
test("excess top-10 concentration fails without hard block", async () => {
  const r = await holdersFilter(launch, snap({ top10HolderPct: strategy.thresholds.maxTop10HolderPct + 10 }));
  assert.equal(r.passed, false);
  assert.equal(r.hardBlock, false);
});

test("holder count below minimum fails", async () => {
  const r = await holdersFilter(launch, snap({ holderCount: strategy.thresholds.minHolders - 1 }));
  assert.equal(r.passed, false);
});

test("unknown concentration fails as insufficient data", async () => {
  const r = await holdersFilter(launch, snap({ top10HolderPct: null }));
  assert.equal(r.passed, false);
  assert.equal(r.insufficientData, true);
});

test("unknown holder count fails as insufficient data", async () => {
  const r = await holdersFilter(launch, snap({ holderCount: null }));
  assert.equal(r.passed, false);
  assert.equal(r.insufficientData, true);
});

// ---- creator -------------------------------------------------------------------
test("unknown creator fails as insufficient data (no RPC needed)", async () => {
  const r = await creatorFilter({ ...launch, creator: null }, snap());
  assert.equal(r.passed, false);
  assert.equal(r.insufficientData, true);
});

// ---- pool vault exclusion --------------------------------------------------------
test("concentration excludes the pool vault", async () => {
  const accounts = [
    { address: "VAULT", amount: 800 },
    { address: "whale", amount: 100 },
    { address: "someone", amount: 50 },
  ];
  assert.equal(concentrationPct(accounts, 1000, "VAULT"), 15);
});

test("concentration counts the vault when it is not excluded", async () => {
  const accounts = [
    { address: "VAULT", amount: 800 },
    { address: "whale", amount: 100 },
  ];
  assert.equal(concentrationPct(accounts, 1000, "OTHER"), 90);
});

test("concentration is unknown when the pool could not be confirmed", async () => {
  const accounts = [{ address: "VAULT", amount: 800 }];
  assert.equal(concentrationPct(accounts, 1000, null), null);
});

// ---- pipeline ------------------------------------------------------------------
/** Stand-in for the creator filter, which would otherwise hit the network. */
const stubCreator: Filter = async () => ({
  name: "creator", passed: true, hardBlock: false, score: 70, evidence: ["stub"],
});
const OFFLINE_FILTERS: Filter[] = [mintAuthorityFilter, liquidityFilter, holdersFilter, stubCreator];

test("pipeline short-circuits on hard block (later filters do not run)", async () => {
  const a = await runPipeline(launch, snap({ freezeAuthorityActive: true }), OFFLINE_FILTERS);
  assert.equal(a.passed, false);
  assert.equal(a.results.length, 1);
  assert.equal(a.results[0].name, "mint-authority");
});

test("clean snapshot passes the full pipeline", async () => {
  const a = await runPipeline(launch, snap(), OFFLINE_FILTERS);
  assert.equal(a.passed, true);
  assert.equal(a.results.length, 4);
});

test("a snapshot with no market data no longer passes", async () => {
  const blind = snap({ liquidityUsd: null, holderCount: null, top10HolderPct: null, lpBurnedPct: null });
  const a = await runPipeline(launch, blind, OFFLINE_FILTERS);
  assert.equal(a.passed, false, "this is the exact case that used to alert at 53/100");
});

test("unevaluable filters are excluded from the score rather than averaged in", async () => {
  const blind = snap({ liquidityUsd: null, holderCount: null, top10HolderPct: null });
  const a = await runPipeline(launch, blind, OFFLINE_FILTERS);
  const scored = a.results.filter((r) => !r.insufficientData);
  const expected = scored.reduce((sum, r) => sum + r.score, 0) / scored.length;
  assert.equal(a.totalScore, expected);
});

// ---- strategy config -------------------------------------------------------------
test("strategy hash is stable and 16 hex chars", () => {
  assert.match(strategyHash, /^[0-9a-f]{16}$/);
});

test("chain state is read immediately; the holder read waits for DAS to index", () => {
  // Plain RPC is accurate straight away, so chain state starts at 0. DAS is
  // not: a freshly observed mint reported 2 holders at t=0 and 1404 ten
  // minutes later, so judging on a t=0 holder count would reject everything
  // for a spurious reason.
  assert.equal(strategy.snapshots.chainStateAtSec[0], 0);
  assert.ok(
    strategy.snapshots.holdersAtSec[0] >= 60,
    "holder reads must not start at t=0 — DAS has not indexed the mint yet"
  );
});

// ---- pool pipeline scope (2026-08-17) --------------------------------------

test("only PumpSwap is claimed as a supported pool venue", () => {
  // LaunchLab produced 0 pools from 35 launches. The cause is that the
  // pipeline is PumpSwap-shaped end to end — the program whose touched
  // accounts become candidates, the LP-mint seed, and the pool account
  // layout. This set is what stops us spending an RPC call per candidate to
  // rediscover that.
  assert.equal(supportsPoolPipeline("pumpswap"), true);
  assert.equal(supportsPoolPipeline("launchlab"), false);
  assert.equal(supportsPoolPipeline("raydium"), false);
  // pump.fun launches sit on a bonding curve and have no pool until they
  // graduate — at which point they arrive as source "pumpswap".
  assert.equal(supportsPoolPipeline("pumpfun"), false);
});
