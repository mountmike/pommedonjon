import type { Sidecar } from "../sidecar/Sidecar.js";

export interface BackupVerification {
  readonly ok: boolean;
  /** Human-readable reasons the backup is not complete. Empty when ok. */
  readonly problems: readonly string[];
  /** The device the backup says it belongs to, when the manifest is readable. */
  readonly udid: string | undefined;
  readonly isEncrypted: boolean | undefined;
}

/**
 * Decides whether a backup directory on disk is complete enough to keep.
 * This is a structural check; it does not decrypt anything.
 */
export interface BackupVerifier {
  verify(backupDir: string): Promise<BackupVerification>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Verifies through the sidecar's `verify` command, which knows the backup
 * format. The important rule it applies: Status.plist saying "finished" is
 * not enough, because a run that fails at the passcode prompt leaves exactly
 * that next to an empty manifest.
 */
export class SidecarBackupVerifier implements BackupVerifier {
  readonly #sidecar: Sidecar;

  constructor(sidecar: Sidecar) {
    this.#sidecar = sidecar;
  }

  async verify(backupDir: string): Promise<BackupVerification> {
    const { value, exitCode, stderrTail } = await this.#sidecar.runJson(
      ["verify", "--backup-dir", backupDir],
      { timeoutMs: 60_000 },
    );
    if (!isRecord(value) || typeof value["ok"] !== "boolean") {
      const detail = stderrTail.trim();
      return {
        ok: false,
        problems: [
          `verification did not run (exit code ${exitCode})` +
            (detail ? `: ${detail}` : ""),
        ],
        udid: undefined,
        isEncrypted: undefined,
      };
    }
    const problems = Array.isArray(value["problems"])
      ? value["problems"].filter((p): p is string => typeof p === "string")
      : [];
    return {
      // Never report ok alongside problems, whatever the sidecar printed.
      ok: value["ok"] && problems.length === 0,
      problems,
      udid: typeof value["udid"] === "string" ? value["udid"] : undefined,
      isEncrypted:
        typeof value["isEncrypted"] === "boolean" ? value["isEncrypted"] : undefined,
    };
  }
}
