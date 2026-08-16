import { Connection, PublicKey } from "@solana/web3.js";
import { HELIUS_RPC } from "../config.js";
import { holderStats } from "../das.js";
import { saveRawEvent, saveSnapshot, saveToken, setTokenPool } from "../db/db.js";
import { logger } from "../logger.js";
import { marketData, refreshMarketData } from "../prices.js";
import { strategy } from "../strategy.js";
import type { TokenLaunch, TokenSnapshot } from "../types.js";
import { concentrationPct, deriveLpMint, extractPoolCandidates } from "./pool.js";

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
  holders: { count: number; at: number } | null;
  nextChainMark: number;
  nextHoldersMark: number;
}

export class Recorder {
  private connection = new Connection(HELIUS_RPC, "confirmed");
  private tracked = new Map<string, TrackState>();
  private sweeper: NodeJS.Timeout | null = null;

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
    // Pool extraction is validated for PumpSwap. Other venues simply fail to
    // confirm a pool, which records as "unknown" rather than as a guess.
    const state = this.stateFor(mint, launch.observedAt);
    for (const candidate of extractPoolCandidates(tx, mint)) {
      const burned = await this.lpBurnedPct(candidate.pool);
      if (burned === null) continue; // LP mint absent -> not a pool
      state.pool = candidate.pool;
      state.baseVault = candidate.baseVault;
      state.lpBurnedPct = burned;
      break;
    }

    const resolved: TokenLaunch = { ...launch, mint, creator, pool: state.pool };
    saveToken(resolved);
    if (state.pool) setTokenPool(mint, state.pool);

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
  private async lpBurnedPct(pool: string): Promise<number | null> {
    try {
      const supply = await this.connection.getTokenSupply(new PublicKey(deriveLpMint(pool)));
      return Number(supply.value.amount) === 0 ? 100 : 0;
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
        state.holders = { count: stats.uniqueOwners, at: Date.now() };
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
