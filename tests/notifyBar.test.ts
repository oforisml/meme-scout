import assert from "node:assert/strict";
import { test } from "node:test";
import { meetsNotifyBar } from "../src/alerts/notifyBar.js";
import { strategy } from "../src/strategy.js";
import type { TokenSnapshot } from "../src/types.js";

const bar = strategy.alerts.notify;

function snap(o: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    mint: "M", takenAt: Date.now(),
    priceUsd: 0.0001,
    liquidityUsd: bar.minLiquidityUsd + 1,
    holderCount: bar.minHolders + 1,
    top10HolderPct: bar.maxTop10HolderPct - 1,
    mintAuthorityActive: false, freezeAuthorityActive: false, lpBurnedPct: 100,
    chainStateAt: Date.now(), holderCountAt: Date.now(), ...o,
  };
}

test("a candidate clearing every notify threshold is delivered", () => {
  assert.equal(meetsNotifyBar(snap()).notify, true);
});

test("each threshold independently holds a candidate back", () => {
  assert.equal(meetsNotifyBar(snap({ liquidityUsd: bar.minLiquidityUsd - 1 })).notify, false);
  assert.equal(meetsNotifyBar(snap({ top10HolderPct: bar.maxTop10HolderPct + 1 })).notify, false);
  assert.equal(meetsNotifyBar(snap({ holderCount: bar.minHolders - 1 })).notify, false);
});

test("the reason names every failing threshold, so a silent channel is explicable", () => {
  const v = meetsNotifyBar(snap({ liquidityUsd: 1, top10HolderPct: 99, holderCount: 1 }));
  assert.equal(v.notify, false);
  assert.match(v.reason, /liquidity/);
  assert.match(v.reason, /top10/);
  assert.match(v.reason, /holders/);
});

test("unknown values hold a candidate back rather than letting it through", () => {
  // Same discipline as the filters: missing data is never a pass.
  assert.equal(meetsNotifyBar(snap({ liquidityUsd: null })).notify, false);
  assert.equal(meetsNotifyBar(snap({ holderCount: null })).notify, false);
  assert.equal(meetsNotifyBar(snap({ top10HolderPct: null })).notify, false);
});

test("the notify bar is strictly tighter than the pass bar", () => {
  // The whole point of the split: everything notified must also have passed,
  // or the two would be measuring different things and the dataset would no
  // longer contain a superset of what was delivered.
  assert.ok(bar.minLiquidityUsd >= strategy.thresholds.minLiquidityUsd);
  assert.ok(bar.maxTop10HolderPct <= strategy.thresholds.maxTop10HolderPct);
  assert.ok(bar.minHolders >= strategy.thresholds.minHolders);
});

test("a candidate that passes filters but misses the bar is still recordable", () => {
  // It must be a pass-level candidate (so it gets an alerts row and FR-A6
  // quotes) while being held back from Telegram. This is the case the split
  // exists to create.
  const marginal = snap({
    liquidityUsd: strategy.thresholds.minLiquidityUsd + 1,
    top10HolderPct: strategy.thresholds.maxTop10HolderPct - 1,
    holderCount: strategy.thresholds.minHolders + 1,
  });
  assert.equal(meetsNotifyBar(marginal).notify, false, "marginal candidates stay off Telegram");
});
