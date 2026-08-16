import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCost, parseQuote } from "../src/quotes.js";

/** Shape captured from a real live response. */
const real = {
  inputMint: "So11111111111111111111111111111111111111112",
  inAmount: "500000000",
  outputMint: "MEME",
  outAmount: "7228782499",
  priceImpactPct: "0.0026551034440757142444726085",
  slippageBps: 100,
  routePlan: [{ swapInfo: { label: "Pump.fun Amm" }, percent: 100 }],
};

test("priceImpactPct is converted from Jupiter's fraction to a true percent", () => {
  // The whole point: 0.00266 is 0.266%, not 0.00266%. Storing the raw value in
  // a column named _pct is the units trap that produced 31,772 "SOL" swaps.
  const q = parseQuote(real, 400);
  assert.ok(q.ok);
  assert.ok(Math.abs(q.priceImpactPct - 0.26551) < 0.0001);
});

test("a deep-liquidity quote reports near-zero impact", () => {
  // Calibration reference: SOL->USDC 0.5 SOL returned 0.0000126 live.
  const q = parseQuote({ ...real, priceImpactPct: "0.0000125580310535838" }, 300);
  assert.ok(q.ok);
  assert.ok(q.priceImpactPct < 0.01, `expected < 0.01%, got ${q.priceImpactPct}`);
});

test("a dead pool reports 100% and is kept, not discarded", () => {
  // Observed live. This is a finding about the token, not a parse error.
  const q = parseQuote({ ...real, priceImpactPct: "1" }, 400);
  assert.ok(q.ok);
  assert.equal(q.priceImpactPct, 100);
});

test("route labels are joined in order", () => {
  const q = parseQuote(
    { ...real, routePlan: [{ swapInfo: { label: "HumidiFi" } }, { swapInfo: { label: "TesseraV" } }] },
    100
  );
  assert.ok(q.ok);
  assert.equal(q.route, "HumidiFi>TesseraV");
});

test("failures are values, not exceptions — FR-A6 requires them stored", () => {
  for (const bad of [null, undefined, "nonsense", {}, { error: "no route found" }]) {
    const q = parseQuote(bad, 120);
    assert.equal(q.ok, false, `expected failure for ${JSON.stringify(bad)}`);
    assert.equal(q.latencyMs, 120, "latency must be recorded even on failure");
  }
});

test("an unparseable impact is a failure rather than a silent zero", () => {
  const q = parseQuote({ ...real, priceImpactPct: "abc" }, 100);
  assert.equal(q.ok, false);
});

test("the alert line flags an effectively dead pool", () => {
  const dead = parseQuote({ ...real, priceImpactPct: "1" }, 400);
  assert.match(formatCost(dead), /dead/i);
  const fine = parseQuote(real, 400);
  assert.doesNotMatch(formatCost(fine), /dead/i);
  assert.match(formatCost(fine), /0\.27%/);
});

test("a failed quote still renders a line for the alert", () => {
  assert.match(formatCost({ ok: false, error: "http 429", latencyMs: 50 }), /quote failed/);
});
