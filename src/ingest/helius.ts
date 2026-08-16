import WebSocket from "ws";
import { HELIUS_WS, PROGRAMS } from "../config.js";
import { logger } from "../logger.js";
import type { LaunchSource, TokenLaunch } from "../types.js";
import { decodeCreateEvent } from "./pumpfun.js";

type LaunchHandler = (launch: TokenLaunch, rawLogs: string[]) => void;

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
export class HeliusListener {
  private ws: WebSocket | null = null;
  private backoffMs = 1_000;
  private subIdToSource = new Map<number, LaunchSource>();
  private reqIdToSource = new Map<number, LaunchSource>();
  /** Unix ms of the last event received — heartbeat reads this (FR-G2). */
  public lastEventAt = Date.now();

  private readonly subscriptions: Subscription[] = [
    { reqId: 1, program: PROGRAMS.RAYDIUM_AMM_V4, source: "raydium" },
    { reqId: 2, program: PROGRAMS.PUMP_FUN, source: "pumpfun" },
    { reqId: 3, program: PROGRAMS.PUMPSWAP, source: "pumpswap" },
    { reqId: 4, program: PROGRAMS.RAYDIUM_LAUNCHLAB, source: "launchlab" },
  ];

  constructor(private onLaunch: LaunchHandler) {}

  start(): void {
    this.connect();
  }

  private connect(): void {
    logger.info("connecting to Helius websocket");
    this.ws = new WebSocket(HELIUS_WS);

    this.ws.on("open", () => {
      this.backoffMs = 1_000;
      for (const sub of this.subscriptions) {
        this.subscribeLogs(sub.reqId, sub.program, sub.source);
      }
      logger.info(
        { venues: this.subscriptions.map((s) => s.source) },
        "subscribed to launch/graduation venues"
      );
    });

    this.ws.on("message", (data) => this.handleMessage(data.toString()));

    this.ws.on("close", () => this.scheduleReconnect("socket closed"));
    this.ws.on("error", (err) => {
      logger.error({ err }, "websocket error");
      this.ws?.close();
    });
  }

  private scheduleReconnect(reason: string): void {
    logger.warn({ reason, retryInMs: this.backoffMs }, "reconnecting");
    setTimeout(() => this.connect(), this.backoffMs);
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
