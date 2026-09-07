import type { ActionFilePersistence } from "./persistence.js";
import type { ActionAuthoritySnapshotV1 } from "./types.js";

/** Read-side cache for an `ActionAuthorityStore`: the proposals listing plus
 * per-proposal verified snapshots, both keyed by filesystem mtimes so reads
 * stay O(1) while every durable write (from any store instance) invalidates
 * the affected entry through the file's changed timestamp. */
export class ActionAuthorityStoreReadCacheV1 {
  private readonly snapshotCache = new Map<string, ActionAuthoritySnapshotV1 | null>();
  private readonly snapshotCacheMtimes = new Map<string, number>();
  private cachedProposalIds: string[] | null = null;
  private cachedProposalsMtime = -1;

  constructor(private readonly files: ActionFilePersistence) {}

  invalidate(): void {
    this.cachedProposalIds = null;
    this.snapshotCache.clear();
    this.snapshotCacheMtimes.clear();
  }

  /** Drop the cached proposal listing when the store directory changed on
   * disk. A second store instance (browser vs home authorities) writes the
   * same files, so a same-process cache cannot rely on instance-local
   * invalidation alone. */
  private refreshCacheAuthority(): void {
    const mtime = this.files.proposalsMtimeMs();
    if (mtime !== this.cachedProposalsMtime) {
      this.invalidate();
      this.cachedProposalsMtime = mtime;
    }
  }

  proposalIds(): string[] {
    this.refreshCacheAuthority();
    if (this.cachedProposalIds === null) this.cachedProposalIds = this.files.proposalIds();
    return this.cachedProposalIds;
  }

  /** Verified snapshot for a proposal, re-read only when the authority file
   * changed. Every state transition (approval, staleness, terminal) appends
   * to that file from any store instance, so an equal mtime proves the
   * snapshot is current without re-reading and re-verifying the closure. */
  get(
    proposalId: string,
    read: (proposalId: string) => ActionAuthoritySnapshotV1 | null,
  ): ActionAuthoritySnapshotV1 | null {
    const authorityMtime = this.files.authorityMtimeMs(proposalId);
    if (authorityMtime === this.snapshotCacheMtimes.get(proposalId))
      return this.snapshotCache.get(proposalId) ?? null;
    const snapshot = read(proposalId);
    this.snapshotCache.set(proposalId, snapshot);
    this.snapshotCacheMtimes.set(proposalId, authorityMtime);
    return snapshot;
  }
}
