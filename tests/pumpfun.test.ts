import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCreateEvent } from "../src/ingest/pumpfun.js";

/**
 * Fixtures are real log lines captured from mainnet, not synthesised — the
 * whole point of this decoder is that it matches what pump.fun actually emits.
 */

// A genuine token creation.
const CREATE_LOG =
  "Program data: G3KpTd7rY3YRAAAAQ1JFQVRPUiBDQSBJTiBCSU8GAAAATEFZT09PQAAAAGh0dHBzOi8vbWV0YS51eGVudG8uaW8vZGF0YS9lMDIxZTYyYy04OTMzLTQzMWUtYWNmOC1iNjI0YjkzZGJjMTdKP9ZAtdd1JmdxXOCCfJLqbBxRGxfm43Y2ltvkrYonL1pORA6jTVltxMffYQMXSGZCjcnvZrgAog3ONEtSkCszw/2KvDjqDbrQ71o78pNem7/Yyt1G5V1jNGitDHj/QSfD/Yq8OOoNutDvWjvyk16bv9jK3UblXWM0aK0MeP9BJ6fqgWoAAAAAABDYR+PPAwAArCP8BgAAAAB4xftR0QIAAIDGpH6NAwAG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/AABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArCP8BgAAAA==";

// A trade on an already-existing token. This is the case the old substring
// heuristic mistook for a launch: 28% of captured "pump.fun launches".
const TRADE_LOG =
  "Program data: m6do3NVs8wOj6oFqAAAAAOdw0LH86P/2RJUzVfA1ZGGoNP8ySsr2LTEzwG8HzR2/ycrQq+vkWPhGqEPQtEy14RXeInRqfZZaQ9zA3ZrYf2vcDIpA8Nm06EfDbhe/R3FVvxmERD20QQ90dtoAmEGQ8CiuFRoQ1RxHmYJkbTSF2lPNOlR2i/hlb3pSZwissCvA3AyKQPDZtOhHw24Xv0dxVb8ZhEQ9tEEPdHbaAJhBkPA=";

test("decodes a real CreateEvent", () => {
  const r = decodeCreateEvent([CREATE_LOG]);
  assert.ok(r, "expected a decoded launch");
  assert.equal(r.mint, "5zqdPMTRL6Vi1yV8FByN6Co3AZaarEcGpmQDEGf7pump");
  assert.equal(r.name, "CREATOR CA IN BIO");
  assert.equal(r.symbol, "LAYOOO");
  assert.match(r.uri, /^https:\/\//);
});

test("decodes creator and on-chain timestamp", () => {
  const r = decodeCreateEvent([CREATE_LOG]);
  assert.ok(r);
  assert.match(r.creator, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.ok(r.chainTs !== null, "chainTs is what makes observation latency measurable");
  // Sanity: a plausible epoch-ms value, not seconds and not microseconds.
  assert.ok(r.chainTs > 1_600_000_000_000 && r.chainTs < 4_000_000_000_000);
});

test("a trade is not a launch", () => {
  // The whole reason the ingest heuristic changed.
  assert.equal(decodeCreateEvent([TRADE_LOG]), null);
});

test("logs with no program data are not a launch", () => {
  assert.equal(decodeCreateEvent(["Program log: Instruction: CreateIdempotent"]), null);
  assert.equal(decodeCreateEvent([]), null);
});

test("finds the CreateEvent among unrelated log lines", () => {
  const r = decodeCreateEvent([
    "Program log: Instruction: Create",
    TRADE_LOG,
    CREATE_LOG,
    "Program log: success",
  ]);
  assert.ok(r);
  assert.equal(r.mint, "5zqdPMTRL6Vi1yV8FByN6Co3AZaarEcGpmQDEGf7pump");
});

test("a truncated CreateEvent returns null rather than throwing", () => {
  const raw = Buffer.from(CREATE_LOG.slice("Program data:".length).trim(), "base64");
  const truncated = "Program data: " + raw.subarray(0, 40).toString("base64");
  assert.equal(decodeCreateEvent([truncated]), null);
});

test("garbage base64 does not throw", () => {
  assert.equal(decodeCreateEvent(["Program data: !!!!not base64!!!!"]), null);
});
