import type { BucketRow } from "../db/db.js";

/**
 * Per-minute swap aggregation.
 *
 * H1 is stated in terms of "unique-buyer growth without wash signatures", so
 * the quantity that matters is not volume but how many *new* wallets buy in
 * each minute. Volume is trivially faked; a stream of genuinely new buyers is
 * expensive to fake, and a token whose trades keep coming from the same
 * wallets is exactly the wash pattern the hypothesis wants excluded.
 *
 * Hence: `new_buyers` per bucket is the headline series, and
 * `buyers_who_also_sold` is a cheap first-pass wash tell.
 *
 * Raw swaps are far too voluminous to keep in full (~7M rows/day for tracked
 * tokens), so they are only persisted inside a bounded launch window; these
 * aggregates carry the rest of the tracking period.
 */

export interface AggSwap {
  wallet: string;
  side: "buy" | "sell";
  solAmount: number;
  at: number;
}

interface MintState {
  /** Every buyer ever seen for this mint — the denominator of "new". */
  everBought: Set<string>;
  bucketStart: number;
  buyersThisBucket: Set<string>;
  sellersThisBucket: Set<string>;
  trades: number;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  /** True once at least one swap has landed in the current bucket. */
  dirty: boolean;
}

function floorTo(ms: number, bucketMs: number): number {
  return Math.floor(ms / bucketMs) * bucketMs;
}

function freshBucket(state: MintState, start: number): void {
  state.bucketStart = start;
  state.buyersThisBucket = new Set();
  state.sellersThisBucket = new Set();
  state.trades = 0;
  state.buys = 0;
  state.sells = 0;
  state.solIn = 0;
  state.solOut = 0;
  state.dirty = false;
}

export class SwapAggregator {
  private state = new Map<string, MintState>();

  constructor(private bucketMs: number = 60_000) {}

  /**
   * Fold one swap in. Returns a completed bucket when this swap crosses into a
   * new minute, so the caller can persist it — no separate timer needed for
   * the common case.
   */
  add(mint: string, swap: AggSwap): BucketRow | null {
    let s = this.state.get(mint);
    if (!s) {
      s = {
        everBought: new Set(),
        bucketStart: floorTo(swap.at, this.bucketMs),
        buyersThisBucket: new Set(),
        sellersThisBucket: new Set(),
        trades: 0, buys: 0, sells: 0, solIn: 0, solOut: 0, dirty: false,
      };
      this.state.set(mint, s);
    }

    let completed: BucketRow | null = null;
    const bucket = floorTo(swap.at, this.bucketMs);
    if (bucket !== s.bucketStart) {
      completed = this.snapshot(mint, s);
      // Only after snapshotting does this bucket's buyers count as "ever seen",
      // otherwise every buyer would look pre-existing and new_buyers would be 0.
      for (const w of s.buyersThisBucket) s.everBought.add(w);
      freshBucket(s, bucket);
    }

    s.trades++;
    s.dirty = true;
    if (swap.side === "buy") {
      s.buys++;
      s.solIn += swap.solAmount;
      s.buyersThisBucket.add(swap.wallet);
    } else {
      s.sells++;
      s.solOut += swap.solAmount;
      s.sellersThisBucket.add(swap.wallet);
    }
    return completed;
  }

  /**
   * Close the current bucket without waiting for another swap. A token that
   * stops trading entirely — the interesting case, a token dying — would
   * otherwise never emit its last and most informative bucket.
   */
  flush(mint: string): BucketRow | null {
    const s = this.state.get(mint);
    if (!s || !s.dirty) return null;
    const row = this.snapshot(mint, s);
    for (const w of s.buyersThisBucket) s.everBought.add(w);
    freshBucket(s, floorTo(Date.now(), this.bucketMs));
    return row;
  }

  /** Drop all memory for a mint once it leaves the tracking window. */
  forget(mint: string): void {
    this.state.delete(mint);
  }

  get size(): number {
    return this.state.size;
  }

  private snapshot(mint: string, s: MintState): BucketRow {
    let newBuyers = 0;
    for (const w of s.buyersThisBucket) if (!s.everBought.has(w)) newBuyers++;

    let alsoSold = 0;
    for (const w of s.buyersThisBucket) if (s.sellersThisBucket.has(w)) alsoSold++;

    return {
      mint,
      bucketStart: s.bucketStart,
      trades: s.trades,
      buys: s.buys,
      sells: s.sells,
      solIn: s.solIn,
      solOut: s.solOut,
      distinctBuyers: s.buyersThisBucket.size,
      newBuyers,
      cumulativeBuyers: s.everBought.size + newBuyers,
      buyersWhoAlsoSold: alsoSold,
    };
  }
}
