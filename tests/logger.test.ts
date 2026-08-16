import assert from "node:assert/strict";
import { test } from "node:test";

// Set the secrets BEFORE importing, since the scrubber snapshots them at load.
process.env.HELIUS_API_KEY = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
process.env.TELEGRAM_BOT_TOKEN = "9876543210:AAbbCCddEEffGGhh";
process.env.WEB_PASSWORD = "hunter2hunter2";
const KEY = process.env.HELIUS_API_KEY;

const { scrub, scrubText } = await import("../src/logger.js");

test("a key embedded in a URL is removed", () => {
  // The actual leak shape: the Helius key lives inside the RPC and websocket
  // URLs, so any error quoting the URL it failed on carries the key with it.
  const url = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
  const out = scrubText(url);
  assert.ok(!out.includes(KEY), "the key must not survive");
  assert.match(out, /«redacted»/);
  assert.match(out, /helius-rpc\.com/, "the useful part of the message should remain");
});

test("a key inside an Error message and stack is removed", () => {
  const err = new Error(`connect failed: https://x/?api-key=${KEY}`);
  const out = scrub(err) as { message: string; stack?: string; type: string };
  assert.equal(out.type, "Error");
  assert.ok(!out.message.includes(KEY));
  assert.ok(!(out.stack ?? "").includes(KEY));
});

test("a key nested deep in a logged object is removed", () => {
  const payload = { req: { headers: { url: `wss://h/?api-key=${KEY}` } }, tries: [1, `k=${KEY}`] };
  assert.ok(!JSON.stringify(scrub(payload)).includes(KEY));
});

test("every configured secret is covered, not just the Helius key", () => {
  assert.ok(!scrubText(`bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`).includes("AAbbCCdd"));
  assert.ok(!scrubText("password=hunter2hunter2").includes("hunter2hunter2"));
});

test("ordinary log content is untouched", () => {
  const msg = "graduation linked to its recorded launch";
  assert.equal(scrubText(msg), msg);
  assert.deepEqual(scrub({ mint: "abc", n: 5, ok: true }), { mint: "abc", n: 5, ok: true });
});

test("short or empty secrets are ignored so logs do not become asterisks", () => {
  // An empty JUPITER_API_KEY must not cause every string to be mangled.
  assert.equal(scrubText("a normal sentence"), "a normal sentence");
});

test("a key in err.cause is removed but the cause is kept", () => {
  // The real shape of a failed fetch: undici reports a bare "fetch failed"
  // and puts the URL — the thing holding the key — in a NON-ENUMERABLE
  // `cause`, so an Object.entries walk would miss it entirely.
  const err = new Error("fetch failed", { cause: new Error(`connect ECONNREFUSED https://h/?api-key=${KEY}`) });
  const out = scrub(err) as { cause: { message: string } };
  assert.ok(out.cause, "cause must survive — dropping it would make the log useless for debugging");
  assert.ok(!out.cause.message.includes(KEY));
  assert.match(out.cause.message, /ECONNREFUSED/, "the diagnostic part must remain");
});

test("own properties of an error are scrubbed too", () => {
  // web3.js hangs `code` and `data` off its RPC errors.
  const err = Object.assign(new Error("rpc failed"), { code: -32000, data: `endpoint=${KEY}` });
  const out = scrub(err) as { code: number; data: string };
  assert.equal(out.code, -32000);
  assert.ok(!out.data.includes(KEY));
});

test("the depth limit fails CLOSED — no key escapes by being nested deeply", () => {
  let deep: unknown = `https://h/?api-key=${KEY}`;
  for (let i = 0; i < 40; i++) deep = { nest: deep };
  assert.ok(!JSON.stringify(scrub(deep)).includes(KEY), "depth must never be a way past the scrub");
});

test("scrubbing survives a cycle", () => {
  const a: Record<string, unknown> = { name: `k=${KEY}` };
  a.self = a;
  let out: unknown;
  assert.doesNotThrow(() => { out = scrub(a); });
  assert.ok(!JSON.stringify(out).includes(KEY));
});
