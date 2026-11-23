import { constants } from "node:fs";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Where backups live on disk, and how a good one is preserved.
 *
 *   <root>/<deviceId>/working/<udid>/     the directory the phone backs up
 *                                         into; rewritten by every run
 *   <root>/<deviceId>/snapshots/<time>/   copies taken after verified runs
 *
 * The working directory is only ever a candidate. A run that fails or does
 * not verify leaves the snapshots untouched, so the last good backup survives
 * anything that happens to the working copy.
 */
export class BackupStore {
  constructor(
    readonly root: string,
    private readonly snapshots: SnapshotStrategy,
  ) {}

  deviceDir(deviceId: string): string {
    return path.join(this.root, deviceId);
  }

  /** The directory handed to the transport as its backup root. */
  workingRoot(deviceId: string): string {
    return path.join(this.deviceDir(deviceId), "working");
  }

  /** Where the transport puts this device's backup inside the working root. */
  workingDir(deviceId: string, udid: string): string {
    return path.join(this.workingRoot(deviceId), udid);
  }

  async prepare(deviceId: string): Promise<void> {
    await mkdir(this.workingRoot(deviceId), { recursive: true });
  }

  /**
   * Preserve the working copy after a verified run. Returns where it was
   * kept, or undefined when the strategy keeps nothing itself.
   */
  snapshot(deviceId: string, at: Date): Promise<string | undefined> {
    return this.snapshots.snapshot({
      deviceDir: this.deviceDir(deviceId),
      workingRoot: this.workingRoot(deviceId),
      at,
    });
  }
}

export interface SnapshotRequest {
  readonly deviceDir: string;
  readonly workingRoot: string;
  readonly at: Date;
}

export interface SnapshotStrategy {
  snapshot(request: SnapshotRequest): Promise<string | undefined>;
}

/**
 * Keeps nothing. For when something else preserves history, such as a ZFS
 * snapshot schedule on the dataset. With this strategy a failed run can leave
 * the only copy incomplete until the next good run, so it is only safe when
 * that outside mechanism exists.
 */
export class NoSnapshots implements SnapshotStrategy {
  snapshot(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

/** `2026-11-24T00-38-50Z`: sortable, and safe as a directory name anywhere. */
export function snapshotName(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const PARTIAL_SUFFIX = ".partial";

/**
 * Copies the working directory after each verified run and keeps the newest
 * few. The copy is made under a temporary name and renamed into place, so a
 * snapshot directory with a proper name is always complete.
 *
 * Cost: assume a full copy. The copy asks for a copy-on-write clone, which
 * Node honours on Linux filesystems that support reflinks (Btrfs, XFS) but
 * not on macOS: measured on APFS, a 22 GB backup of 123,000 files took about
 * 90 seconds and 22 GB of disk per snapshot. On a dataset that has real
 * snapshots (ZFS), use those instead and set the strategy to "none".
 */
export class CopySnapshots implements SnapshotStrategy {
  constructor(private readonly keep: number) {
    if (!Number.isInteger(keep) || keep < 1) {
      throw new RangeError("keep must be a whole number of at least 1");
    }
  }

  async snapshot(request: SnapshotRequest): Promise<string> {
    const dir = path.join(request.deviceDir, "snapshots");
    await mkdir(dir, { recursive: true });
    await this.#removePartials(dir);

    const final = path.join(dir, snapshotName(request.at));
    const partial = final + PARTIAL_SUFFIX;
    await cp(request.workingRoot, partial, {
      recursive: true,
      errorOnExist: true,
      force: false,
      // Reflink where the platform and filesystem allow, plain copy otherwise.
      mode: constants.COPYFILE_FICLONE,
    });
    await rename(partial, final);

    await this.#prune(dir);
    return final;
  }

  /** Leftovers from a copy that was interrupted. Never a usable snapshot. */
  async #removePartials(dir: string): Promise<void> {
    for (const entry of await readdir(dir)) {
      if (entry.endsWith(PARTIAL_SUFFIX)) {
        await rm(path.join(dir, entry), { recursive: true, force: true });
      }
    }
  }

  async #prune(dir: string): Promise<void> {
    // Only directories this class named are candidates; anything else a
    // person put here is left alone.
    const snapshots = (await readdir(dir)).filter((n) => SNAPSHOT_NAME.test(n)).sort();
    for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - this.keep))) {
      await rm(path.join(dir, stale), { recursive: true, force: true });
    }
  }
}
