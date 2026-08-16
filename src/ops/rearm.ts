/**
 * Repeat-alert suppression.
 *
 * Every ops check runs on the 60s heartbeat, so without this a single
 * persistent fault sends 1440 Telegram messages a day and trains the operator
 * to ignore the channel — which is worse than no alerting at all.
 */
export function shouldRealert(lastAlertedAt: number | null, now: number, windowMs: number): boolean {
  return lastAlertedAt === null || now - lastAlertedAt >= windowMs;
}
