import { z } from "zod";
import type { Sidecar } from "../sidecar/Sidecar.js";

/** What the sidecar's `verify` command prints. */
const VerifyReplySchema = z.object({
  ok: z.boolean(),
  problems: z.array(z.string()),
  udid: z.string().nullish(),
  isEncrypted: z.boolean().nullish(),
});

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
    const reply = VerifyReplySchema.safeParse(value);
    if (!reply.success) {
      // Fail closed: a check that did not run, or that answered in a shape
      // we do not understand, is not a pass.
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
    const { ok, problems, udid, isEncrypted } = reply.data;
    return {
      // Never report ok alongside problems, whatever the sidecar printed.
      ok: ok && problems.length === 0,
      problems,
      udid: udid ?? undefined,
      isEncrypted: isEncrypted ?? undefined,
    };
  }
}
