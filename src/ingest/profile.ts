import type { LaunchSource } from "../types.js";

/**
 * Ingest scope selection.
 *
 * Helius meters WebSocket usage at 2 credits per 0.1 MB streamed (20/MB), and
 * `logsSubscribe` delivers every transaction touching a program — we discard
 * well over 99% of it. That makes the subscription set, not the RPC call
 * count, the thing that determines spend. Measured live:
 *
 *   PumpSwap  104 GB/day  ->  62M credits/month
 *   pump.fun   13.5 GB/day ->  8.1M credits/month
 *
 * against tiers of 1M (free), 10M ($49), 100M ($499) per month. The full set
 * costs ~71M/month, which exhausts a free allowance in about ten hours — as it
 * did on 2026-08-16.
 *
 * So scope is a deployment choice, not a constant.
 */

export type Venue = LaunchSource;

export interface VenueToggles {
  pumpfun: boolean;
  pumpswap: boolean;
  launchlab: boolean;
  raydium: boolean;
}

export type ProfileName = "free" | "developer" | "business" | "custom";

/**
 * Measured GB/day per venue. null = not yet measured; the runtime credit meter
 * refines these from real traffic rather than trusting a guess.
 */
export const MEASURED_GB_PER_DAY: Record<Venue, number | null> = {
  pumpswap: 104,
  pumpfun: 13.5,
  launchlab: null,
  raydium: null,
};

/** Helius: 2 credits per 0.1 MB of streamed data. */
export const CREDITS_PER_MB = 20;

export const PROFILES: Record<Exclude<ProfileName, "custom">, VenueToggles> = {
  // Everything, including post-graduation swap capture. ~71M credits/month.
  business: { pumpfun: true, pumpswap: true, launchlab: true, raydium: true },
  // Drops the PumpSwap firehose, which is 88% of the bill. Graduations are
  // still detected, because migration transactions mention pump.fun too.
  developer: { pumpfun: true, pumpswap: false, launchlab: false, raydium: false },
  // Same venues as developer, but no continuous subscription fits 1M/month —
  // pump.fun alone is 8x over — so this profile duty-cycles under a budget and
  // records its coverage windows.
  free: { pumpfun: true, pumpswap: false, launchlab: false, raydium: false },
};

export function resolveVenues(profile: ProfileName, configured: VenueToggles): VenueToggles {
  return profile === "custom" ? configured : PROFILES[profile];
}

/** Projected monthly credits from streaming, for the enabled venues. */
export function projectMonthlyCredits(venues: VenueToggles): {
  total: number;
  unmeasured: Venue[];
  perVenue: { venue: Venue; creditsPerMonth: number | null }[];
} {
  const perVenue = (Object.keys(venues) as Venue[])
    .filter((v) => venues[v])
    .map((venue) => {
      const gbDay = MEASURED_GB_PER_DAY[venue];
      return {
        venue,
        creditsPerMonth: gbDay === null ? null : Math.round(gbDay * 1000 * CREDITS_PER_MB * 30),
      };
    });
  return {
    total: perVenue.reduce((sum, v) => sum + (v.creditsPerMonth ?? 0), 0),
    unmeasured: perVenue.filter((v) => v.creditsPerMonth === null).map((v) => v.venue),
    perVenue,
  };
}

export function bytesToCredits(bytes: number): number {
  return (bytes / 1_000_000) * CREDITS_PER_MB;
}
