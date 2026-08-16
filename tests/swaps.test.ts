import assert from "node:assert/strict";
import { test } from "node:test";
import { SwapAggregator, type AggSwap } from "../src/recorder/swaps.js";

const T0 = 1_800_000_000_000; // aligned to a minute boundary
const MIN = 60_000;
const buy = (wallet: string, at: number, sol = 1): AggSwap => ({ wallet, side: "buy", solAmount: sol, at });
const sell = (wallet: string, at: number, sol = 1): AggSwap => ({ wallet, side: "sell", solAmount: sol, at });

test("counts trades, sides and volume within a bucket", () => {
  const a = new SwapAggregator();
  a.add("M", buy("alice", T0, 2));
  a.add("M", sell("bob", T0 + 1000, 3));
  const b = a.flush("M")!;
  assert.equal(b.trades, 2);
  assert.equal(b.buys, 1);
  assert.equal(b.sells, 1);
  assert.equal(b.solIn, 2);
  assert.equal(b.solOut, 3);
});

test("a wallet buying twice in one minute is one distinct buyer", () => {
  const a = new SwapAggregator();
  a.add("M", buy("alice", T0));
  a.add("M", buy("alice", T0 + 5000));
  const b = a.flush("M")!;
  assert.equal(b.trades, 2);
  assert.equal(b.distinctBuyers, 1);
  assert.equal(b.newBuyers, 1);
});

test("new_buyers counts only wallets never seen before for this mint", () => {
  const a = new SwapAggregator();
  a.add("M", buy("alice", T0));
  a.add("M", buy("bob", T0));
  const first = a.add("M", buy("carol", T0 + MIN))!; // crosses into minute 2
  assert.equal(first.newBuyers, 2, "alice and bob are both new in minute 1");
  assert.equal(first.cumulativeBuyers, 2);

  const second = a.flush("M")!;
  assert.equal(second.newBuyers, 1, "only carol is new in minute 2");
  assert.equal(second.cumulativeBuyers, 3);
});

test("organic growth: new_buyers stays positive as fresh wallets arrive", () => {
  const a = new SwapAggregator();
  const series: number[] = [];
  let w = 0;
  for (let m = 0; m < 4; m++) {
    for (let i = 0; i < 5; i++) a.add("M", buy("w" + w++, T0 + m * MIN + i * 1000));
    const done = a.add("M", buy("boundary" + m, T0 + (m + 1) * MIN));
    if (done) series.push(done.newBuyers);
  }
  assert.deepEqual(series, [5, 6, 6, 6], "each minute brings genuinely new wallets");
});

test("wash pattern: the same wallets recycling drive new_buyers to zero", () => {
  // This is the distinction H1 rests on — volume identical, signal opposite.
  const a = new SwapAggregator();
  const wallets = ["w1", "w2", "w3"];
  const series: number[] = [];
  for (let m = 0; m < 4; m++) {
    for (const w of wallets) a.add("M", buy(w, T0 + m * MIN + 1000));
    const done = a.add("M", buy(wallets[0], T0 + (m + 1) * MIN));
    if (done) series.push(done.newBuyers);
  }
  assert.deepEqual(series, [3, 0, 0, 0], "after minute 1 nothing is new despite constant volume");
});

test("buyers_who_also_sold flags round-tripping within a bucket", () => {
  const a = new SwapAggregator();
  a.add("M", buy("washer", T0));
  a.add("M", sell("washer", T0 + 2000));
  a.add("M", buy("genuine", T0 + 3000));
  const b = a.flush("M")!;
  assert.equal(b.distinctBuyers, 2);
  assert.equal(b.buyersWhoAlsoSold, 1);
});

test("cumulative_buyers never decreases", () => {
  const a = new SwapAggregator();
  const seen: number[] = [];
  for (let m = 0; m < 5; m++) {
    a.add("M", buy("w" + m, T0 + m * MIN + 500));
    a.add("M", buy("repeat", T0 + m * MIN + 600));
    const done = a.add("M", buy("w" + m, T0 + (m + 1) * MIN));
    if (done) seen.push(done.cumulativeBuyers);
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] >= seen[i - 1], `cumulative went backwards: ${seen}`);
  }
});

test("mints are tracked independently", () => {
  const a = new SwapAggregator();
  a.add("A", buy("alice", T0));
  a.add("B", buy("alice", T0));
  const ba = a.flush("A")!;
  const bb = a.flush("B")!;
  assert.equal(ba.newBuyers, 1);
  assert.equal(bb.newBuyers, 1, "alice is new to B even though she bought A");
});

test("flush on an idle mint yields nothing", () => {
  // A dying token must not emit endless empty buckets.
  const a = new SwapAggregator();
  a.add("M", buy("alice", T0));
  assert.ok(a.flush("M"));
  assert.equal(a.flush("M"), null);
});

test("forget releases state", () => {
  const a = new SwapAggregator();
  a.add("M", buy("alice", T0));
  assert.equal(a.size, 1);
  a.forget("M");
  assert.equal(a.size, 0);
});

// ---- pool orientation ------------------------------------------------------
import { denominate, type PumpSwapTrade } from "../src/ingest/pumpswap.js";

const trade = (base: bigint, quote: bigint): PumpSwapTrade => ({
  pool: "P", wallet: "W", side: "buy", baseAmountRaw: base, quoteAmountRaw: quote, chainTs: null,
});

test("denominate: normal pool (memecoin base, WSOL quote)", () => {
  // 1.5M tokens (6dp) for 0.25 SOL (9dp)
  const r = denominate(trade(1_500_000_000_000n, 250_000_000n), true);
  assert.equal(r.tokenAmount, 1_500_000);
  assert.equal(r.solAmount, 0.25);
});

test("denominate: inverted pool (WSOL base, memecoin quote)", () => {
  // Same trade, pair created the other way round.
  const r = denominate(trade(250_000_000n, 1_500_000_000_000n), false);
  assert.equal(r.tokenAmount, 1_500_000);
  assert.equal(r.solAmount, 0.25);
});

test("assuming the wrong orientation produces absurd SOL", () => {
  // This is the live bug: an inverted pool read as normal reported 31,772
  // "SOL" on a fresh memecoin. The regression guard is that the two
  // orientations must NOT agree.
  const t = trade(250_000_000n, 1_500_000_000_000n);
  assert.equal(denominate(t, false).solAmount, 0.25);
  assert.equal(denominate(t, true).solAmount, 1500);
  assert.notEqual(denominate(t, true).solAmount, denominate(t, false).solAmount);
});
