import { config } from "../config.js";
import { saveAlert } from "../db/db.js";
import { logger } from "../logger.js";
import type { Alert, Assessment } from "../types.js";

export async function notify(alert: Alert): Promise<void> {
  saveAlert(alert);
  logger.info({ mint: alert.mint, severity: alert.severity }, alert.title);

  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.TELEGRAM_CHAT_ID,
          text: `${alert.severity === "high" ? "🚨" : "ℹ️"} ${alert.title}\n\n${alert.body}`,
        }),
      });
    } catch (err) {
      logger.warn({ err }, "telegram send failed");
    }
  }
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
