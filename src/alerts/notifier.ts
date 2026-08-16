import { config } from "../config.js";
import { saveAlert } from "../db/db.js";
import { logger } from "../logger.js";
import type { Alert, Assessment } from "../types.js";

/**
 * Telegram transport, shared by token alerts and operational alerts.
 *
 * Operational alerts (backup stale, websocket stalled, daily alive ping) must
 * NOT go through notify(): that writes an `alerts` row, and `alerts.mint` is
 * NOT NULL, so an ops alert would need a fake mint that pollutes both the
 * table and the per-mint cooldown query.
 *
 * Note the response check. `fetch` does not throw on 4xx/5xx, so without it a
 * revoked bot token or a wrong chat id fails completely silently — which would
 * quietly invalidate both FR-G1 AC2 (backup failure must alert) and FR-G2's
 * daily ping, whose entire purpose is confirming delivery works.
 */
export async function sendTelegram(title: string, body: string, severity: "info" | "high"): Promise<boolean> {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_CHAT_ID,
        text: `${severity === "high" ? "🚨" : "ℹ️"} ${title}\n\n${body}`,
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, body: await res.text().catch(() => "") }, "telegram rejected the message");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, "telegram send failed");
    return false;
  }
}

/** Operational alert: reaches the operator, never touches the alerts table. */
export async function notifyOps(title: string, body: string): Promise<void> {
  logger.warn({ title }, body);
  await sendTelegram(title, body, "high");
}

/**
 * Persists the alert and returns its id, so execution-cost quotes (FR-A6) can
 * reference the specific alert rather than the mint — the same mint can alert
 * more than once inside a 240 minute horizon window.
 */
export async function notify(alert: Alert, send: boolean): Promise<number> {
  const alertId = saveAlert(alert, send);
  logger.info({ mint: alert.mint, severity: alert.severity, notified: send }, alert.title);
  // Recorded either way; only delivery is gated. The dataset must not shrink
  // just because the operator wants a quieter phone.
  if (send) await sendTelegram(alert.title, alert.body, alert.severity);
  return alertId;
}

export function assessmentToAlert(a: Assessment): Alert {
  // Mark evidence that came from a filter which could not evaluate, so a
  // reader can tell a judgement from a gap at a glance.
  const lines = a.results.flatMap((r) =>
    r.evidence.map((e) => `[${r.name}${r.insufficientData ? " ?" : ""}] ${e}`)
  );
  return {
    mint: a.mint,
    createdAt: Date.now(),
    severity: "high",
    title: `Candidate passed filters — score ${a.totalScore.toFixed(0)}/100`,
    body: `Mint: ${a.mint}\nhttps://dexscreener.com/solana/${a.mint}\n\n${lines.join("\n")}`,
  };
}
