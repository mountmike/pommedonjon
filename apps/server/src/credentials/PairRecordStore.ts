import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Where each phone's pair record is kept: one file per phone, in a
 * directory only the service can enter.
 *
 * A pair record grants full access to a phone, with no passcode, for as
 * long as the pairing lasts. So these are files with their own permissions
 * and not rows in the database, they are never logged, and nothing hands
 * one back out once it is in (DECISIONS.md, D25).
 */
export class PairRecordStore {
  constructor(readonly dir: string) {}

  #ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // mkdir leaves an existing directory's mode alone.
    chmodSync(this.dir, 0o700);
  }

  /** Where a phone's pair record is, whether or not it exists yet. */
  pathFor(deviceId: string): string {
    return path.join(this.dir, `${deviceId}.plist`);
  }

  has(deviceId: string): boolean {
    return existsSync(this.pathFor(deviceId));
  }

  /**
   * Write a pair record somewhere it can be looked at before it is given
   * to a phone. Returns the path; pass it to {@link keep} or {@link discard}.
   */
  receive(contents: Uint8Array): string {
    this.#ensureDir();
    const file = path.join(this.dir, `.incoming-${randomBytes(8).toString("hex")}`);
    writeFileSync(file, contents, { mode: 0o600, flag: "wx" });
    return file;
  }

  /** Make a received pair record the one for this phone, replacing any before it. */
  keep(received: string, deviceId: string): void {
    renameSync(received, this.pathFor(deviceId));
  }

  discard(received: string): void {
    rmSync(received, { force: true });
  }

  remove(deviceId: string): void {
    rmSync(this.pathFor(deviceId), { force: true });
  }
}
