import { Connection, PublicKey } from "@solana/web3.js";
import { HELIUS_RPC } from "../config.js";
import { holderStats } from "../das.js";
import { backfillSwapMint, saveBucket, saveRawEvent, saveSnapshot, saveSwaps, saveToken, setTokenPool, type SwapRow } from "../db/db.js";
import { logger } from "../logger.js";
import { marketData, refreshMarketData } from "../prices.js";
import { strategy } from "../strategy.js";
import type { TokenLaunch, TokenSnapshot } from "../types.js";
import { concentrationPct, deriveLpMint, extractPoolCandidates, parseMintSupply, parsePoolMints, supportsPoolPipeline } from "./pool.js";
import { SwapAggregator, type AggSwap } from "./swaps.js";
import { decodeSwaps, denominate, type PumpSwapTrade } from "../ingest/pumpswap.js";
import { decodeTrades } from "../ingest/pumpfun.js";

/**
 * The recorder is the real long-term asset of this project.
 *
 * Historical point-in-time data for freshly launched meme coins cannot be
 * bought later — most tokens live for hours. Everything we observe is
 * written down with OUR observation timestamp so that any future backtest
 * can only use information that was genuinely available at decision time.
 *
 * Fields are gathered on different cadences because they cost wildly
 * different amounts. Price and liquidity come from one batched Jupiter
 * request that covers every tracked mint at once and costs no RPC credits,
 * so they refresh on every tick. Authority/concentration state and holder
 * counts cost Helius credits per mint, so they refresh only at the ages
 * listed in strategy.config.json and are carried forward in between — always
 * stamped with when they were really read.
 */

/** How often the batched price sweep runs over all tracked mints. */
const MARKET_SWEEP_MS = 10_000;

interface SlowFields {
  top10HolderPct: number | null;
  mintAuthorityActive: boolean | null;
  freezeAuthorityActive: boolean | null;
  at: number;
}

/** Called after a snapshot whose metered fields were actually refreshed. */
export type OnMeteredSnapshot = (mint: string, snapshot: TokenSnapshot) => void;

interface TrackState {
  timer: NodeJS.Timeout | null;
  startedAt: number;
  onMetered: OnMeteredSnapshot | null;
  /** Confirmed AMM pool and the vault holding our mint, if we could identify them. */
  pool: string | null;
  baseVault: string | null;
  lpBurnedPct: number | null;
  chain: SlowFields | null;
  holders: { count: number; at: number; truncated: boolean } | null;
  nextChainMark: number;
  nextHoldersMark: number;
}

export class Recorder {
  private connection = new Connection(HELIUS_RPC, "confirmed");
  private tracked = new Map<string, TrackState>();
  private sweeper: NodeJS.Timeout | null = null;

  // ---- swap recording (FR-A5 / FR-H1) -------------------------------------
  private agg = new SwapAggregator(strategy.swaps.bucketSec * 1000);
  private poolToMint = new Map<string, string>();
  /** pool -> is OUR token the pair's base side? Decides which amount is SOL. */
  private mintIsBase = new Map<string, boolean>();
  /** mint -> unix ms after which raw per-swap capture stops. */
  private rawUntil = new Map<string, number>();
  /** mint -> raw rows written so far, against strategy.swaps.maxRawPerToken. */
  private rawWritten = new Map<string, number>();
  /** pump.fun launches seen recently: mint -> birth slot (FR-H1 window). */
  private bornAtSlot = new Map<string, number>();
  /**
   * A pool trades before we have resolved pool -> mint, so its earliest swaps
   * — exactly the launch window we care about — arrive unattributable. They
   * are held here briefly and replayed once the pool resolves.
   */
  private pending: { pool: string; row: SwapRow; agg: AggSwap; raw: PumpSwapTrade }[] = [];

  /** Resolve mint/pool/creator from the launch transaction, persist it. */
  async resolveAndRecord(launch: TokenLaunch): Promise<TokenLaunch | null> {
    // Signature only. The log array was ~7.5 KB per event and nothing ever
    // read it; signature and slot are already on the tokens row, and the
    // signature is the pointer to everything else.
    saveRawEvent("launch.observed", { signature: launch.signature }, null, launch.slot);

    const tx = await this.connection.getParsedTransaction(launch.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx?.meta) return null;

    // The freshest mint in the transaction's token balances is our candidate.
    const WSOL = "So11111111111111111111111111111111111111112";
    const mints = (tx.meta.postTokenBalances ?? [])
      .map((b) => b.mint)
      .filter((m) => m && m !== WSOL);
    const mint = mints[0];
    if (!mint) return null;

    const creator = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58() ?? null;

    // Identify the pool. Every candidate is checked against its derived LP
    // mint — an account that is not really a pool derives an LP mint that
    // does not exist, which is a cheap and unambiguous test. Observed on live
    // traffic: without it, an unrelated wallet appearing in a PumpSwap
    // instruction gets recorded as the pool.
    // Only attempted for venues the pipeline can actually serve. The previous
    // comment here said other venues "simply fail to confirm a pool", which
    // was the wrong mechanism: extraction never produced a candidate for them,
    // because it looks for accounts touched by the PUMPSWAP program. Skipping
    // explicitly costs nothing and, unlike trying, spends no RPC.
    const state = this.stateFor(mint, launch.observedAt);
    if (!supportsPoolPipeline(launch.source)) {
      logger.debug({ mint, source: launch.source }, "pool identification unsupported for this venue");
    }
    for (const candidate of supportsPoolPipeline(launch.source) ? extractPoolCandidates(tx, mint) : []) {
      const confirmed = await this.confirmPool(candidate.pool, mint);
      if (!confirmed) continue; // not a real pool for this mint
      state.pool = candidate.pool;
      state.baseVault = candidate.baseVault;
      state.lpBurnedPct = confirmed.lpBurnedPct;
      this.mintIsBase.set(candidate.pool, confirmed.mintIsBase);
      break;
    }

    const resolved: TokenLaunch = { ...launch, mint, creator, pool: state.pool };
    saveToken(resolved);
    if (state.pool) {
      setTokenPool(mint, state.pool);
      // Open the raw-swap window before adopting, so replayed swaps land in it.
      this.rawUntil.set(mint, Date.now() + strategy.swaps.pumpswapRawWindowSec * 1000);
      this.adoptPool(state.pool, mint);
    }

    logger.info(
      { mint, source: launch.source, creator, pool: state.pool, lpBurnedPct: state.lpBurnedPct },
      "new token recorded"
    );
    return resolved;
  }

  /** Take an immediate snapshot, then keep snapshotting so the dataset has a time series. */
  async snapshotNow(mint: string): Promise<TokenSnapshot> {
    const { snapshot } = await this.snapshotWithMeta(mint);
    return snapshot;
  }

  private async snapshotWithMeta(mint: string): Promise<{ snapshot: TokenSnapshot; metered: boolean }> {
    const built = await this.buildSnapshot(mint);
    saveSnapshot(built.snapshot);
    return built;
  }

  /**
   * Decaying cadence from strategy.config.json: dense in the first minutes
   * (where the action is), sparse later. Self-scheduling timeout chain.
   */
  track(mint: string, onMetered?: OnMeteredSnapshot): void {
    const state = this.stateFor(mint, Date.now());
    if (onMetered) state.onMetered = onMetered;
    if (state.timer) return;

    const schedule = strategy.snapshots.schedule;
    const horizonSec = schedule[schedule.length - 1]?.untilSec ?? 1800;

    const tick = () => {
      const elapsedSec = (Date.now() - state.startedAt) / 1000;
      if (elapsedSec >= horizonSec) {
        this.untrack(mint);
        return;
      }
      // Close any completed swap bucket. Driven by this timer rather than by
      // swap arrival: a token that stops trading is the interesting case, and
      // an arrival-driven flush would never emit its final bucket.
      const bucket = this.agg.flush(mint);
      if (bucket) saveBucket(bucket);

      this.snapshotWithMeta(mint)
        .then(({ snapshot, metered }) => {
          // Re-assess only when the metered fields were actually refreshed.
          // Judging on every tick would re-run the creator RPC 50 times per
          // token; judging only at t=0 would mean judging on the worst data
          // we will ever have for it.
          if (metered) state.onMetered?.(mint, snapshot);
        })
        .catch((err) => logger.warn({ err, mint }, "snapshot failed"));
      const band = schedule.find((b) => elapsedSec < b.untilSec) ?? schedule[schedule.length - 1];
      state.timer = setTimeout(tick, band.everySec * 1000);
    };

    const first = schedule[0]?.everySec ?? 30;
    state.timer = setTimeout(tick, first * 1000);
    this.startSweeper();
  }

  /**
   * Stop tracking a mint and release its timer. Without this there is no way
   * to stop spending RPC budget on a token that has already died, and no
   * clean shutdown.
   */
  untrack(mint: string): void {
    const state = this.tracked.get(mint);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    const finalBucket = this.agg.flush(mint);
    if (finalBucket) saveBucket(finalBucket);
    this.agg.forget(mint);
    if (state.pool) { this.poolToMint.delete(state.pool); this.mintIsBase.delete(state.pool); }
    this.rawUntil.delete(mint);
    this.rawWritten.delete(mint);
    this.tracked.delete(mint);
    if (this.tracked.size === 0) this.stopSweeper();
  }

  /** Drain everything — used on shutdown so the process can exit cleanly. */
  stop(): void {
    for (const mint of [...this.tracked.keys()]) this.untrack(mint);
    this.stopSweeper();
  }

  get trackedCount(): number {
    return this.tracked.size;
  }

  // ---- swap recording ------------------------------------------------------

  /** Called for every PumpSwap notification, launch-shaped or not. */
  onPumpSwapLogs(logs: string[], signature: string, slot: number): void {
    const trades = decodeSwaps(logs);
    if (trades.length === 0) return;
    const now = Date.now();
    const rows: SwapRow[] = [];

    for (const t of trades) {
      const mint = this.poolToMint.get(t.pool);
      // Orientation is only known for pools we confirmed. For a pending pool
      // assume the common layout and re-denominate on adoption.
      const { solAmount, tokenAmount } = denominate(t, this.mintIsBase.get(t.pool) ?? true);
      const row: SwapRow = {
        mint: mint ?? null,
        pool: t.pool,
        venue: "pumpswap",
        signature,
        slot,
        side: t.side,
        solAmount,
        tokenAmount,
        wallet: t.wallet,
        chainTs: t.chainTs,
        observedAt: now,
      };
      const aggSwap: AggSwap = { wallet: t.wallet, side: t.side, solAmount, at: now };

      if (!mint) {
        // Unknown pool. Almost all of these belong to tokens we do not track,
        // so hold only briefly and let the pruner drop them.
        this.pending.push({ pool: t.pool, row, agg: aggSwap, raw: t });
        continue;
      }
      const bucket = this.agg.add(mint, aggSwap);
      if (bucket) saveBucket(bucket);
      if (this.withinRawWindow(mint, now)) rows.push(row);
    }

    if (rows.length) saveSwaps(rows);
    this.prunePending(now);
  }

  /** Called for every pump.fun notification — bonding-curve trades (FR-H1). */
  onPumpFunLogs(logs: string[], signature: string, slot: number): void {
    const trades = decodeTrades(logs);
    if (trades.length === 0) return;
    const now = Date.now();
    const rows: SwapRow[] = [];

    for (const t of trades) {
      const born = this.bornAtSlot.get(t.mint);
      // FR-H1: only the first N slots after launch, and only for launches we saw.
      if (born === undefined || slot - born > strategy.swaps.pumpfunRawWindowSlots) continue;
      if (!this.underRawCap(t.mint)) continue;
      rows.push({
        mint: t.mint, pool: null, venue: "pumpfun", signature, slot, side: t.side,
        solAmount: t.solAmount, tokenAmount: t.tokenAmount, wallet: t.wallet,
        chainTs: t.chainTs, observedAt: now,
      });
    }
    if (rows.length) saveSwaps(rows);
  }

  /** Tier-1 tells us a curve launch happened, opening its FR-H1 window. */
  noteLaunch(mint: string, slot: number): void {
    this.bornAtSlot.set(mint, slot);
    // Bounded: launches arrive ~40/min and each window is seconds long.
    if (this.bornAtSlot.size > 2000) {
      const cutoff = slot - strategy.swaps.pumpfunRawWindowSlots * 4;
      for (const [m, s] of this.bornAtSlot) if (s < cutoff) this.bornAtSlot.delete(m);
    }
  }

  private withinRawWindow(mint: string, now: number): boolean {
    const until = this.rawUntil.get(mint);
    return until !== undefined && now <= until && this.underRawCap(mint);
  }

  private underRawCap(mint: string): boolean {
    const n = this.rawWritten.get(mint) ?? 0;
    if (n >= strategy.swaps.maxRawPerToken) return false;
    this.rawWritten.set(mint, n + 1);
    return true;
  }

  /** Replay buffered swaps once we learn which mint a pool belongs to. */
  private adoptPool(pool: string, mint: string): void {
    this.poolToMint.set(pool, mint);
    const now = Date.now();
    const rows: SwapRow[] = [];
    const mintIsBase = this.mintIsBase.get(pool) ?? true;
    this.pending = this.pending.filter((p) => {
      if (p.pool !== pool) return true;
      // Re-denominate: these were buffered before the pair orientation was known.
      const { solAmount, tokenAmount } = denominate(p.raw, mintIsBase);
      const bucket = this.agg.add(mint, { ...p.agg, solAmount });
      if (bucket) saveBucket(bucket);
      if (this.withinRawWindow(mint, now)) rows.push({ ...p.row, mint, solAmount, tokenAmount });
      return false;
    });
    if (rows.length) saveSwaps(rows);
    // Anything already written with a null mint gets stitched up.
    backfillSwapMint(pool, mint);
  }

  private prunePending(now: number): void {
    // The buffer only exists to cover the pool-resolution round trip.
    if (this.pending.length < 4000) return;
    const cutoff = now - 15_000;
    this.pending = this.pending.filter((p) => p.row.observedAt >= cutoff);
  }

  // ---- internals ----------------------------------------------------------

  private stateFor(mint: string, startedAt: number): TrackState {
    let state = this.tracked.get(mint);
    if (!state) {
      state = {
        timer: null,
        startedAt,
        onMetered: null,
        pool: null,
        baseVault: null,
        lpBurnedPct: null,
        chain: null,
        holders: null,
        nextChainMark: 0,
        nextHoldersMark: 0,
      };
      this.tracked.set(mint, state);
    }
    return state;
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      refreshMarketData([...this.tracked.keys()]).catch((err) =>
        logger.warn({ err }, "market sweep failed")
      );
    }, MARKET_SWEEP_MS);
    this.sweeper.unref?.();
  }

  private stopSweeper(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /**
   * LP burn state, derived from the LP mint's supply.
   *
   * Returns null when the derived LP mint does not exist — which is how we
   * tell a real pool from an unrelated account. A supply of zero means every
   * LP token minted was burned, i.e. the liquidity cannot be pulled. Note the
   * limitation: outstanding supply is reported as 0% burned even if some
   * fraction was burned, which is the conservative direction.
   */
  private async confirmPool(
    pool: string,
    mint: string
  ): Promise<{ lpBurnedPct: number; mintIsBase: boolean } | null> {
    try {
      const [poolAcc, lpAcc] = await this.connection.getMultipleAccountsInfo([
        new PublicKey(pool),
        new PublicKey(deriveLpMint(pool)),
      ]);
      // Not a pool if its derived LP mint does not exist. Without this an
      // unrelated wallet appearing in a PumpSwap instruction is recorded as
      // the pool -- observed on live traffic.
      if (!poolAcc || !lpAcc) return null;

      const mints = parsePoolMints(poolAcc.data);
      if (!mints) return null;
      if (mints.baseMint !== mint && mints.quoteMint !== mint) return null;

      const supply = parseMintSupply(lpAcc.data);
      return {
        lpBurnedPct: supply !== null && supply === 0n ? 100 : 0,
        // Which side of the pair our token sits on decides which of the two
        // positional amounts in a swap event is SOL.
        mintIsBase: mints.baseMint === mint,
      };
    } catch {
      return null;
    }
  }

  private async buildSnapshot(mint: string): Promise<{ snapshot: TokenSnapshot; metered: boolean }> {
    const state = this.stateFor(mint, Date.now());
    const now = Date.now();
    const ageSec = (now - state.startedAt) / 1000;
    let metered = false;

    // --- every tick: batched, credit-free -----------------------------------
    const market = await marketData(mint);

    // --- occasional: chain state (authorities + concentration) --------------
    const chainMarks = strategy.snapshots.chainStateAtSec;
    if (state.nextChainMark < chainMarks.length && ageSec >= chainMarks[state.nextChainMark]) {
      state.nextChainMark++;
      const fresh = await this.readChainState(mint, state.baseVault);
      if (fresh) {
        state.chain = fresh;
        metered = true;
      }
    }

    // --- occasional: holder count (DAS, tightly rate limited) ---------------
    const holderMarks = strategy.snapshots.holdersAtSec;
    if (state.nextHoldersMark < holderMarks.length && ageSec >= holderMarks[state.nextHoldersMark]) {
      state.nextHoldersMark++;
      const stats = await holderStats(mint);
      if (stats) {
        state.holders = { count: stats.uniqueOwners, at: Date.now(), truncated: stats.truncated };
        metered = true;
      }
    }

    const snapshot: TokenSnapshot = {
      mint,
      takenAt: now,
      priceUsd: market?.priceUsd ?? null,
      liquidityUsd: market?.liquidityUsd ?? null,
      holderCount: state.holders?.count ?? null,
      top10HolderPct: state.chain?.top10HolderPct ?? null,
      mintAuthorityActive: state.chain?.mintAuthorityActive ?? null,
      freezeAuthorityActive: state.chain?.freezeAuthorityActive ?? null,
      lpBurnedPct: state.lpBurnedPct,
      chainStateAt: state.chain?.at ?? null,
      holderCountAt: state.holders?.at ?? null,
      holderCountTruncated: state.holders?.truncated ?? null,
    };

    // Only offer the snapshot for judging once every metered field has been
    // read at least once. A chain-state-only refresh at t=0 would otherwise
    // trigger an assessment that is guaranteed to fail on a null holder count
    // and spend a creator RPC doing it.
    const judgeable = metered && state.chain !== null && state.holders !== null;

    return { snapshot, metered: judgeable };
  }

  /**
   * Authority state and holder concentration.
   *
   * The pool's own vault is excluded from the concentration figure. It is
   * normally the largest single account of a freshly graduated token, and
   * counting it makes every token look ~100% concentrated — on live samples
   * this moved one token from 87.5% to 27.7%, i.e. from rejected to passing.
   * If we could not confirm the pool we return concentration as unknown
   * rather than as an inflated number we know to be wrong.
   */
  private async readChainState(mint: string, baseVault: string | null): Promise<SlowFields | null> {
    const mintPk = new PublicKey(mint);

    const [mintInfo, largest] = await Promise.all([
      this.connection.getParsedAccountInfo(mintPk),
      this.connection.getTokenLargestAccounts(mintPk).catch(() => null),
    ]);

    let mintAuthorityActive: boolean | null = null;
    let freezeAuthorityActive: boolean | null = null;
    let supply = 0;

    const parsed: any = mintInfo.value?.data;
    if (parsed && "parsed" in parsed) {
      const info = parsed.parsed?.info;
      mintAuthorityActive = info?.mintAuthority != null;
      freezeAuthorityActive = info?.freezeAuthority != null;
      supply = Number(info?.supply ?? 0);
    }

    const top10HolderPct = concentrationPct(
      (largest?.value ?? []).map((a) => ({ address: a.address.toBase58(), amount: a.amount })),
      supply,
      baseVault
    );

    return { top10HolderPct, mintAuthorityActive, freezeAuthorityActive, at: Date.now() };
  }
}
