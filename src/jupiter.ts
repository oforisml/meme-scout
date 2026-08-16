import { config } from "./config.js";

/**
 * Shared Jupiter endpoint selection, used by both the price sweep and the
 * execution-cost quotes so the two cannot drift apart.
 *
 * lite-api needs no key but carries a deprecation notice dated 2025-12-31;
 * both hosts still answer keyless today. Setting JUPITER_API_KEY moves us to
 * the keyed host before the free one goes away.
 */
export const JUPITER_HOST = config.JUPITER_API_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag";

export function jupiterHeaders(): Record<string, string> {
  return config.JUPITER_API_KEY ? { "x-api-key": config.JUPITER_API_KEY } : {};
}
