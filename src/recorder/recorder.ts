import { Connection, PublicKey } from "@solana/web3.js";
import { HELIUS_RPC } from "../config.js";
import { saveRawEvent, saveSnapshot, saveToken } from "../db/db.js";
import { logger } from "../logger.js";
import { strategy } from "../strategy.js";
import type { TokenLaunch, TokenSnapshot } from "../types.js";

/**
 * The recorder is the real long-term asset of this project.
 *
 * Historical point-in-time data for freshly launched meme coins cannot be
 * bought later — most tokens live for hours. Everything we observe is
 * written down with OUR observation timestamp so that any future backtest
 * can only use information that was genuinely available at decision time.
 */
export class Recorder {
  private connection = new Connection(HELIUS_RPC, "confirmed");
  private tracked = new Map<string, NodeJS.Timeout>();

  /** Resolve mint/pool/creator from the launch transaction, persist it. */
  async resolveAndRecord(launch: TokenLaunch, rawLogs: string[]): Promise<TokenLaunch | null> {
    saveRawEvent("launch.observed", { signature: launch.signature, logs: rawLogs }, null, launch.slot);

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

    const resolved: TokenLaunch = { ...launch, mint, creator };
    saveToken(resolved);
    logger.info({ mint, source: launch.source, creator }, "new token recorded");
    return resolved;
  }

  /** Take an immediate snapshot, then keep snapshotting on an interval so the dataset has a time series. */
  async snapshotNow(mint: string): Promise<TokenSnapshot> {
    const snapshot = await this.buildSnapshot(mint);
    saveSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Decaying cadence from strategy.config.json: dense in the first minutes
   * (where the action is), sparse later. Self-scheduling timeout chain.
   */
  track(mint: string): void {
    if (this.tracked.has(mint)) return;
    const startedAt = Date.now();
    const schedule = strategy.snapshots.schedule;
    const horizonSec = schedule[schedule.length - 1]?.untilSec ?? 3600;

    const tick = () => {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      if (elapsedSec >= horizonSec) {
        this.tracked.delete(mint);
        return;
      }
      this.snapshotNow(mint).catch((err) => logger.warn({ err, mint }, "snapshot failed"));
      const band = schedule.find((b) => elapsedSec < b.untilSec) ?? schedule[schedule.length - 1];
      const timer = setTimeout(tick, band.everySec * 1000);
      this.tracked.set(mint, timer);
    };

    const first = schedule[0]?.everySec ?? 30;
    this.tracked.set(mint, setTimeout(tick, first * 1000));
  }

  private async buildSnapshot(mint: string): Promise<TokenSnapshot> {
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

    let top10HolderPct: number | null = null;
    if (largest?.value?.length && supply > 0) {
      const top10 = largest.value.slice(0, 10).reduce((sum, a) => sum + Number(a.amount), 0);
      top10HolderPct = (top10 / supply) * 100;
    }

    return {
      mint,
      takenAt: Date.now(),
      priceUsd: null,      // TODO: derive from pool reserves or Jupiter price API
      liquidityUsd: null,  // TODO: read pool vault balances
      holderCount: null,   // TODO: Helius getTokenAccounts (DAS) gives holder counts
      top10HolderPct,
      mintAuthorityActive,
      freezeAuthorityActive,
      lpBurnedPct: null,   // TODO: check LP token supply sent to burn address
    };
  }
}
