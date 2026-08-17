import Database from "better-sqlite3";
import { readFileSync, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { installCrashHandlers, logger, scrubText } from "../logger.js";
import { strategy } from "../strategy.js";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * Local read-only dashboard.
 *
 * Two hard rules, both learned the hard way in this project:
 *
 * 1. Opens its OWN read-only connection. Importing src/db/db.ts would open a
 *    second READ-WRITE handle and run DDL against a database that must have
 *    exactly one writer (RUNBOOK, "DB locked").
 * 2. Binds to localhost by default. This exposes the whole research dataset
 *    and should not be reachable from the network without a deliberate choice.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT ?? 8787);
const HOST = process.env.WEB_HOST ?? "127.0.0.1";
const USER = process.env.WEB_USER ?? "scout";
const PASSWORD = process.env.WEB_PASSWORD ?? "";

const db = new Database(config.DB_PATH, { readonly: true, fileMustExist: true });

// ---- queries ---------------------------------------------------------------

const q = {
  counts: () => ({
    tokens: one(`SELECT COUNT(*) n FROM tokens`),
    launches: one(`SELECT COUNT(*) n FROM tokens WHERE source='pumpfun'`),
    graduated: one(`SELECT COUNT(*) n FROM tokens WHERE graduated_at IS NOT NULL`),
    snapshots: one(`SELECT COUNT(*) n FROM snapshots WHERE schema_version>=2`),
    assessments: one(`SELECT COUNT(*) n FROM assessments WHERE schema_version>=2`),
    passed: one(`SELECT COUNT(*) n FROM assessments WHERE schema_version>=2 AND passed=1`),
    alerts: one(`SELECT COUNT(*) n FROM alerts`),
    delivered: one(`SELECT COUNT(*) n FROM alerts WHERE notified=1`),
    swaps: one(`SELECT COUNT(*) n FROM swaps`),
    buckets: one(`SELECT COUNT(*) n FROM swap_buckets`),
    quotes: one(`SELECT COUNT(*) n FROM quotes`),
  }),

  freshness: () =>
    db
      .prepare(
        `SELECT
           (SELECT MAX(observed_at) FROM tokens)   AS lastToken,
           (SELECT MAX(taken_at)    FROM snapshots) AS lastSnapshot,
           (SELECT MAX(observed_at) FROM swaps)     AS lastSwap,
           (SELECT MAX(created_at)  FROM alerts)    AS lastAlert`
      )
      .get(),

  latency: () =>
    db
      .prepare(
        `SELECT AVG((observed_at - chain_ts)/1000.0) avgSec, COUNT(*) n
           FROM tokens WHERE chain_ts IS NOT NULL`
      )
      .get(),

  timeOnCurve: () =>
    db
      .prepare(
        `SELECT COUNT(*) n, AVG((graduated_at - observed_at)/60000.0) avgMin
           FROM tokens WHERE graduated_at IS NOT NULL AND graduated_at > observed_at + 1000`
      )
      .get(),

  /**
   * Recent judgements, each joined to the snapshot the decision was actually
   * made on (latest metered snapshot at or before the assessment).
   */
  candidates: (limit: number) =>
    db
      .prepare(
        `SELECT a.id, a.mint, a.assessed_at AS assessedAt, a.passed, a.total_score AS score,
                a.results_json AS resultsJson,
                t.name, t.symbol, t.source, t.graduated_at AS graduatedAt,
                s.liquidity_usd AS liquidity, s.holder_count AS holders,
                s.top10_holder_pct AS top10, s.lp_burned_pct AS lpBurned,
                (SELECT notified FROM alerts al
                  WHERE al.mint=a.mint AND al.created_at BETWEEN a.assessed_at-5000 AND a.assessed_at+120000
                  ORDER BY al.created_at LIMIT 1) AS notified,
                (SELECT price_impact_pct FROM quotes qq
                  JOIN alerts al2 ON al2.id=qq.alert_id
                  WHERE al2.mint=a.mint AND qq.side='buy' AND qq.horizon_min=0 AND qq.ok=1
                  ORDER BY qq.observed_at DESC LIMIT 1) AS entryImpactPct
           FROM assessments a
           LEFT JOIN tokens t ON t.mint=a.mint
           LEFT JOIN snapshots s
             ON s.id = (SELECT id FROM snapshots ss
                         WHERE ss.mint=a.mint AND ss.holder_count_at IS NOT NULL
                           AND ss.taken_at<=a.assessed_at
                         ORDER BY ss.taken_at DESC LIMIT 1)
          WHERE a.schema_version>=2
          ORDER BY a.assessed_at DESC
          LIMIT ?`
      )
      .all(limit),

  activity: (limit: number) =>
    db
      .prepare(
        `SELECT mint, name, symbol, source, kind, observed_at AS observedAt,
                graduated_at AS graduatedAt, chain_ts AS chainTs
           FROM tokens ORDER BY observed_at DESC LIMIT ?`
      )
      .all(limit),

  /** Entry cost and any measured exit costs, per alert. */
  costs: (limit: number) =>
    db
      .prepare(
        `SELECT al.mint, al.created_at AS alertedAt,
                MAX(CASE WHEN q.side='buy'  AND q.horizon_min=0 THEN q.price_impact_pct END) entryImpact,
                MAX(CASE WHEN q.side='sell' AND q.horizon_min=15 THEN q.price_impact_pct END) exit15,
                MAX(CASE WHEN q.side='sell' AND q.horizon_min=60 THEN q.price_impact_pct END) exit60,
                MAX(CASE WHEN q.side='buy'  AND q.horizon_min=0 THEN q.route END) route
           FROM alerts al JOIN quotes q ON q.alert_id=al.id
          GROUP BY al.id ORDER BY al.created_at DESC LIMIT ?`
      )
      .all(limit),

  /**
   * H1's series: unique-buyer growth per minute.
   *
   * Picks the mints with the LONGEST series rather than the most recent
   * buckets. Taking recent rows across all mints returns one or two points
   * each and draws a chart of nothing — which is exactly what it did before.
   */
  buyerGrowth: (series: number) =>
    db
      .prepare(
        `SELECT mint, bucket_start AS bucketStart, trades, buys, sells,
                sol_in AS solIn, distinct_buyers AS distinctBuyers,
                new_buyers AS newBuyers, cumulative_buyers AS cumulativeBuyers,
                buyers_who_also_sold AS alsoSold
           FROM swap_buckets
          WHERE mint IN (SELECT mint FROM swap_buckets
                          GROUP BY mint ORDER BY COUNT(*) DESC, MAX(cumulative_buyers) DESC
                          LIMIT ?)
          ORDER BY mint, bucket_start`
      )
      .all(series),

  rejectionReasons: () =>
    db
      .prepare(
        `SELECT json_extract(value,'$.name') AS filter,
                json_extract(value,'$.passed') AS passed,
                COALESCE(json_extract(value,'$.insufficientData'),0) AS insufficient,
                COUNT(*) n
           FROM assessments, json_each(results_json)
          WHERE schema_version>=2 GROUP BY 1,2,3 ORDER BY 1, 4 DESC`
      )
      .all(),

  credits: () =>
    db
      .prepare(
        `SELECT source, SUM(credits) credits, SUM(bytes) bytes
           FROM credit_usage WHERE day LIKE ? GROUP BY source ORDER BY 2 DESC`
      )
      .all(new Date().toISOString().slice(0, 7) + "%"),

  /**
   * Coverage over the last 24h. Every rate on this page is computed over the
   * period we were actually watching, so a page that hides the gaps invites
   * reading "nothing launched" off a window where we were simply blind.
   */
  coverage: (sinceMs: number) =>
    db
      .prepare(
        `SELECT opened_at AS openedAt, closed_at AS closedAt, events, venues, reason
           FROM ingest_windows
          WHERE COALESCE(closed_at, opened_at) >= ?
          ORDER BY opened_at`
      )
      .all(sinceMs),

  /**
   * FR-J1 meta gauge, newest first. AC2's venue-share-over-time series is
   * just this list read backwards.
   *
   * Guarded on the table existing: this handle is READ-ONLY, so it cannot run
   * the DDL itself, and a dashboard opened against a database written by an
   * older recorder must degrade to "no gauge yet" rather than 500.
   */
  meta: (limit: number) => {
    const present = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta_daily'`)
      .get();
    if (!present) return [];
    return (
      db.prepare(`SELECT * FROM meta_daily ORDER BY day DESC LIMIT ?`).all(limit) as any[]
    ).map((r) => ({
      day: r.day,
      coveredHours: r.covered_hours,
      launchRateByVenue: JSON.parse(r.launch_rate_by_venue),
      totalLaunchRate: r.total_launch_rate,
      venueShare: JSON.parse(r.venue_share),
      sameDayGradRatio: r.same_day_grad_ratio,
      cohortGradRate: r.cohort_grad_rate,
      pumpswapSolPerHour: r.pumpswap_sol_per_hour,
      solUsd: r.sol_usd,
      solTrendPct: r.sol_trend_pct,
      state: r.state,
      abstained: JSON.parse(r.abstained),
      reasons: JSON.parse(r.reasons),
      computedAt: r.computed_at,
    }));
  },
};

/**
 * A cheap fingerprint of "has anything changed".
 *
 * The dashboard and the recorder are separate processes, so SQLite update
 * hooks are not available — they only fire for the connection doing the
 * writing. Watching the file tells us SOMETHING changed; this says whether it
 * was anything the UI renders, so a WAL checkpoint does not masquerade as new
 * data.
 */
export function revision(): string {
  const r = db
    .prepare(
      `SELECT
         (SELECT COALESCE(MAX(rowid),0) FROM tokens)       AS t,
         (SELECT COALESCE(MAX(id),0)    FROM snapshots)    AS s,
         (SELECT COALESCE(MAX(id),0)    FROM assessments)  AS a,
         (SELECT COALESCE(MAX(id),0)    FROM alerts)       AS al,
         (SELECT COALESCE(MAX(id),0)    FROM swaps)        AS sw,
         (SELECT COALESCE(MAX(id),0)    FROM swap_buckets) AS b,
         (SELECT COALESCE(MAX(id),0)    FROM quotes)       AS q`
    )
    .get() as Record<string, number>;
  return Object.values(r).join(".");
}

function one(sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

// ---- http ------------------------------------------------------------------

const LOOPBACK = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";

function authorised(header: string | undefined): boolean {
  // No password on loopback is a convenience. Off loopback it is a data leak,
  // and startDashboard() refuses to start in that case rather than relying on
  // this check alone.
  if (!PASSWORD) return LOOPBACK;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const sep = decoded.indexOf(":");
  if (sep < 0) return false; // malformed header must be a 401, not a 500
  const u = decoded.slice(0, sep);
  const p = decoded.slice(sep + 1);
  // Length-independent compare is overkill for a localhost tool, but a plain
  // === on a secret is the kind of thing that gets copied somewhere it matters.
  return u === USER && p.length === PASSWORD.length && timingSafeEqual(p, PASSWORD);
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * What the system actually knows about a token.
 *
 * BUY here means "cleared every safety filter AND the stricter notify bar" —
 * the strongest signal the system currently produces. It is not a profitability
 * claim: no outcome data exists yet, which is what Phase 3 establishes. AVOID
 * is the firmer judgement of the two, since those failed a specific named check.
 */
export type Verdict = "BUY" | "MARGINAL" | "AVOID" | "UNKNOWN";

/**
 * The evidence line that explains a REJECTION.
 *
 * Evidence is an unstructured list mixing positives and negatives, so taking
 * the last entry is wrong: a token rejected for 69% concentration would report
 * "3000 distinct holders", and one rejected for missing liquidity would report
 * "Freeze authority revoked". Both were shown in the UI before this was fixed,
 * which is worse than showing nothing — it tells the operator the wrong reason.
 */
const FAILURE_PHRASE =
  /exceeds|below|vs minimum|still active|is active|cannot evaluate|unknown|no route|rug risk/i;

export function failingLine(r: { name: string; evidence: string[] }): string {
  return r.evidence.find((e) => FAILURE_PHRASE.test(e)) ?? `${r.name} failed`;
}

export function verdictFor(row: {
  passed: number;
  notified: number | null;
  resultsJson: string;
}): { verdict: Verdict; reason: string } {
  let results: { name: string; passed: boolean; insufficientData?: boolean; evidence: string[] }[] = [];
  try {
    results = JSON.parse(row.resultsJson);
  } catch {
    /* fall through to UNKNOWN */
  }

  if (row.passed === 1) {
    return row.notified === 1
      ? { verdict: "BUY", reason: "cleared every filter and the notify bar" }
      : { verdict: "MARGINAL", reason: "passed filters but below the notify bar" };
  }

  const blocking = results.filter((r) => !r.passed);
  if (blocking.length && blocking.every((r) => r.insufficientData)) {
    return { verdict: "UNKNOWN", reason: blocking.map((r) => r.name).join(", ") + ": no data" };
  }
  const onEvidence = blocking.filter((r) => !r.insufficientData);
  return { verdict: "AVOID", reason: onEvidence.map(failingLine).join(" · ") || "rejected" };
}

export function startDashboard(): void {
  const server = createServer((req, res) => {
    if (!authorised(req.headers.authorization)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="meme-scout"' });
      res.end("auth required");
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(join(HERE, "app.html"), "utf8"));
        return;
      }
      if (url.pathname === "/api/state") {
        const limit = Number(url.searchParams.get("limit") ?? 60);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            now: Date.now(),
            counts: q.counts(),
            freshness: q.freshness(),
            latency: q.latency(),
            timeOnCurve: q.timeOnCurve(),
            candidates: q.candidates(limit).map((c: any) => ({
              ...c,
              ...verdictFor(c),
              resultsJson: undefined, // decided server-side; the page renders the verdict
            })),
            activity: q.activity(limit),
            costs: q.costs(30),
            buyerGrowth: q.buyerGrowth(3),
            rejectionReasons: q.rejectionReasons(),
            credits: q.credits(),
            coverage: q.coverage(Date.now() - 24 * 3600_000),
            meta: q.meta(30),
            thresholds: strategy.thresholds,
            notifyBar: strategy.alerts.notify,
            profile: config.INGEST_PROFILE,
            monthlyBudget: config.HELIUS_MONTHLY_CREDITS,
          })
        );
        return;
      }
      res.writeHead(404).end("not found");
    } catch (err) {
      logger.error({ err, path: url.pathname }, "dashboard error");
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: scrubText(String(err)) }));
    }
  });

  if (!PASSWORD && !LOOPBACK) {
    // Serving the whole research dataset to a network with no password is not
    // a default anyone should be able to reach by accident.
    throw new Error(
      `refusing to bind ${HOST} without WEB_PASSWORD — set one, or bind 127.0.0.1`
    );
  }

  // ---- live push --------------------------------------------------------
  // Replaces the client's 30s poll. The client still holds the fetch, so there
  // is exactly one definition of the payload shape; this only says "now".
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  server.on("upgrade", (req, socket, head) => {
    // The upgrade path needs the same auth as everything else — an open
    // websocket would stream the dataset past the password.
    if (!authorised(req.headers.authorization)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"meme-scout\"\r\n\r\n");
      socket.destroy();
      return;
    }
    if (new URL(req.url ?? "/", `http://${req.headers.host}`).pathname !== "/live") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
      ws.send(JSON.stringify({ type: "revision", rev: lastRev }));
    });
  });

  let lastRev = revision();
  let debounce: NodeJS.Timeout | null = null;

  const broadcast = () => {
    const rev = revision();
    if (rev === lastRev) return; // a WAL checkpoint is not new data
    lastRev = rev;
    const msg = JSON.stringify({ type: "revision", rev });
    for (const ws of clients) {
      try { ws.send(msg); } catch { clients.delete(ws); }
    }
  };

  // Writes land in the -wal first, so watch both. Debounced: ingest can write
  // dozens of rows a second and the UI does not need dozens of repaints.
  for (const file of [config.DB_PATH, `${config.DB_PATH}-wal`]) {
    try {
      watch(file, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(broadcast, 750);
      });
    } catch (err) {
      logger.warn({ err, file }, "cannot watch for changes — the UI will fall back to polling");
    }
  }

  server.listen(PORT, HOST, () => {
    logger.info(
      { url: `http://${HOST}:${PORT}`, auth: PASSWORD ? "basic" : "none (localhost only)" },
      "dashboard listening"
    );
  });
}

// Run standalone: npm run dashboard
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  installCrashHandlers();
  startDashboard();
}
