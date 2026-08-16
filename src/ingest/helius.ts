import WebSocket from "ws";
import { HELIUS_WS, PROGRAMS } from "../config.js";
import { logger } from "../logger.js";
import type { LaunchSource, TokenLaunch } from "../types.js";
import { decodeCreateEvent } from "./pumpfun.js";

type LaunchHandler = (launch: TokenLaunch, rawLogs: string[]) => void;
type ActivityHandler = (
  source: LaunchSource,
  logs: string[],
  signature: string,
  slot: number
) => void;

interface Subscription {
  reqId: number;
  program: string;
  source: LaunchSource;
}

/**
 * Subscribes to program logs across the venues that matter in 2026:
 *  - pump.fun bonding curve (new token creation)
 *  - PumpSwap AMM (graduations: create_pool fires when a curve completes —
 *    since 2025-03-20 graduations go here, NOT to Raydium)
 *  - Raydium LaunchLab (LetsBonk launches)
 *  - Raydium AMM v4 (legacy/general new pools)
 * Reconnects with backoff on drop.
 *
 * Log matching is heuristic on purpose: when a signature looks like a
 * launch/graduation we hand it off, and the recorder fetches the parsed
 * transaction to extract mint/pool/creator precisely.
 */
/** Websocket-level keepalive, so a dead-but-open socket is detectable. */
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 90_000;

export class HeliusListener {
  private ws: WebSocket | null = null;
  private backoffMs = 1_000;
  private subIdToSource = new Map<number, LaunchSource>();
  private reqIdToSource = new Map<number, LaunchSource>();
  private keepalive: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastPongAt = Date.now();
  /** Unix ms of the last event received — heartbeat reads this (FR-G2). */
  public lastEventAt = Date.now();

  private readonly subscriptions: Subscription[] = [
    { reqId: 1, program: PROGRAMS.RAYDIUM_AMM_V4, source: "raydium" },
    { reqId: 2, program: PROGRAMS.PUMP_FUN, source: "pumpfun" },
    { reqId: 3, program: PROGRAMS.PUMPSWAP, source: "pumpswap" },
    { reqId: 4, program: PROGRAMS.RAYDIUM_LAUNCHLAB, source: "launchlab" },
  ];

  constructor(
    private onLaunch: LaunchHandler,
    /** Fires for every non-failed notification, launch-shaped or not. */
    private onActivity?: ActivityHandler
  ) {}

  start(): void {
    this.connect();
  }

  private connect(): void {
    logger.info("connecting to Helius websocket");

    // Subscription ids are only meaningful for the socket that issued them.
    // Carrying them across a reconnect leaked entries and risked mapping a new
    // subscription id onto a stale venue.
    this.subIdToSource.clear();

    this.ws = new WebSocket(HELIUS_WS);

    this.ws.on("open", () => {
      this.backoffMs = 1_000;
      // Deliberately do NOT touch lastEventAt here. Resetting it on connect
      // would hide the failure this whole mechanism exists to catch: a socket
      // that opens fine and then delivers nothing (bad key, dropped
      // subscription, silent server). Reconnect looping is prevented by
      // rate-limiting the reconnect in the heartbeat, not by faking liveness.
      this.lastPongAt = Date.now();
      for (const sub of this.subscriptions) {
        this.subscribeLogs(sub.reqId, sub.program, sub.source);
      }
      logger.info(
        { venues: this.subscriptions.map((s) => s.source) },
        "subscribed to launch/graduation venues"
      );
    });

    this.ws.on("message", (data) => this.handleMessage(data.toString()));
    this.ws.on("pong", () => { this.lastPongAt = Date.now(); });

    this.ws.on("close", () => this.scheduleReconnect("socket closed"));
    this.ws.on("error", (err) => {
      logger.error({ err }, "websocket error");
      this.ws?.close();
    });

    this.startKeepalive();
  }

  /**
   * A TCP connection can go dead without ever emitting "close" — the socket
   * stays open and simply delivers nothing, which is the exact failure FR-G2
   * describes as "indistinguishable from a quiet market". Pings make it
   * distinguishable.
   */
  private startKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        logger.warn({ silentSec: ((Date.now() - this.lastPongAt) / 1000).toFixed(0) }, "no pong — socket is dead");
        this.forceReconnect("pong timeout");
        return;
      }
      try {
        this.ws.ping();
      } catch (err) {
        logger.warn({ err }, "ping failed");
      }
    }, PING_INTERVAL_MS);
    this.keepalive.unref?.();
  }

  /**
   * Tear down the current socket so the close handler reconnects. Detecting a
   * stall and only logging it — the previous behaviour — left a dead recorder
   * dead until someone noticed.
   */
  forceReconnect(reason: string): void {
    logger.warn({ reason }, "forcing websocket reconnect");
    this.backoffMs = 1_000; // heal fast; this is a deliberate reset, not a retry storm
    const sock = this.ws;
    this.ws = null;
    if (sock) {
      // terminate(), not close(): a stalled socket may never complete a
      // graceful close handshake.
      try { sock.terminate(); } catch { /* already gone */ }
      // terminate() on an already-dead socket may not emit "close".
      if (sock.readyState === WebSocket.CLOSED) this.scheduleReconnect(reason);
    } else {
      this.scheduleReconnect(reason);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer) return; // never stack reconnects
    logger.warn({ reason, retryInMs: this.backoffMs }, "reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
  }

  private subscribeLogs(id: number, program: string, source: LaunchSource): void {
    this.reqIdToSource.set(id, source);
    this.ws?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "logsSubscribe",
        params: [{ mentions: [program] }, { commitment: "confirmed" }],
      })
    );
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Subscription confirmations map request id -> subscription id
    if (typeof msg.id === "number" && typeof msg.result === "number") {
      const source = this.reqIdToSource.get(msg.id);
      if (source) this.subIdToSource.set(msg.result, source);
      return;
    }

    if (msg.method !== "logsNotification") return;
    this.lastEventAt = Date.now();

    const source = this.subIdToSource.get(msg.params?.subscription);
    if (!source) return;

    const value = msg.params?.result?.value;
    const slot: number = msg.params?.result?.context?.slot ?? 0;
    if (!value || value.err) return; // ignore failed transactions

    const logs: string[] = value.logs ?? [];

    // Every non-failed notification, BEFORE the launch-shaped gate below.
    // Swaps live in this stream and were previously discarded by that gate —
    // which is why H1 has never been measurable.
    this.onActivity?.(source, logs, value.signature, slot);

    if (!this.looksInteresting(source, logs)) return;

    this.onLaunch(
      {
        mint: "", // resolved later from the transaction
        pool: null,
        creator: null,
        source,
        kind: source === "pumpswap" ? "graduation" : "launch",
        signature: value.signature,
        slot,
        observedAt: Date.now(),
      },
      logs
    );
  }

  private looksInteresting(source: LaunchSource, logs: string[]): boolean {
    switch (source) {
      case "raydium":
        // Raydium AMM v4 pool creation emits initialize2
        return logs.some((l) => l.includes("initialize2"));
      case "pumpfun":
        // A pump.fun event is a launch iff it carries a decodable CreateEvent.
        // The old substring test matched "Instruction: Create", which also
        // matches "Instruction: CreateIdempotent" — emitted on ordinary buys.
        // 28% of what we captured as launches were trades on existing tokens.
        // Only this arm pays for base64 decoding; the others stay on cheap
        // substring tests since this is the hot path (~40 events/min).
        return decodeCreateEvent(logs) !== null;
      case "pumpswap":
        // PumpSwap create_pool fires after a pump.fun graduation
        return logs.some(
          (l) => l.includes("CreatePool") || l.includes("Instruction: create_pool")
        );
      case "launchlab":
        // LaunchLab pool initialization (LetsBonk launches)
        return logs.some(
          (l) => l.includes("Instruction: Initialize") || l.includes("PoolCreateEvent")
        );
    }
  }
}
