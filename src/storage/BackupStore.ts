import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** What the marker file says about the backup beside it. */
export const VerifiedMarkerSchema = z.object({
  udid: z.string(),
  /** When verification passed, as an ISO 8601 time. */
  verifiedAt: z.iso.datetime(),
});
export type VerifiedMarker = Readonly<z.infer<typeof VerifiedMarkerSchema>>;

export const VERIFIED_MARKER = "verified.json";

/**
 * Where backups live on disk.
 *
 *   <root>/<deviceId>/<udid>/         the phone's backup, in the standard
 *                                     Finder/iTunes layout; every run updates
 *                                     it in place
 *   <root>/<deviceId>/verified.json   present only while that backup is in a
 *                                     verified state
 *
 * nightstand keeps this one copy and no history. Because a run updates the
 * backup in place, a failed run can leave it worse than it was; keeping
 * earlier versions is the job of whatever snapshots the person running
 * nightstand has arranged on this directory.
 *
 * The marker is for those tools. It is removed before a run touches the
 * backup and written again only after the result verifies, so "snapshot only
 * when verified.json exists" never captures a half-written backup.
 */
export class BackupStore {
  constructor(readonly root: string) {}

  /** The directory handed to the transport as its backup root. */
  deviceDir(deviceId: string): string {
    return path.join(this.root, deviceId);
  }

  /** Where the transport puts this device's backup. */
  backupDir(deviceId: string, udid: string): string {
    return path.join(this.deviceDir(deviceId), udid);
  }

  markerPath(deviceId: string): string {
    return path.join(this.deviceDir(deviceId), VERIFIED_MARKER);
  }

  /**
   * Get ready for a run: make sure the directory exists and withdraw the
   * claim that the backup is verified. Rejects if the marker cannot be
   * removed, because a run must not start under a claim it may invalidate.
   */
  async beginRun(deviceId: string): Promise<void> {
    await mkdir(this.deviceDir(deviceId), { recursive: true });
    await rm(this.markerPath(deviceId), { force: true });
  }

  /** Record that the backup on disk has just verified. */
  async markVerified(deviceId: string, udid: string, at: Date): Promise<void> {
    const marker: VerifiedMarker = { udid, verifiedAt: at.toISOString() };
    // Written beside its final name and renamed, so a reader never sees half
    // a file.
    const final = this.markerPath(deviceId);
    const partial = `${final}.partial`;
    await writeFile(partial, `${JSON.stringify(marker, null, 2)}\n`);
    await rename(partial, final);
  }

  /** The marker, if the backup is currently in a verified state. */
  async verified(deviceId: string): Promise<VerifiedMarker | undefined> {
    let text: string;
    try {
      text = await readFile(this.markerPath(deviceId), "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = VerifiedMarkerSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}
