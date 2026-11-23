import type { DeviceConfig } from "../config/config.js";
import type { Logger, Notifier } from "../notify/Notifier.js";
import type { StateStore } from "../state/StateStore.js";
import type { BackupStore } from "../storage/BackupStore.js";
import type { BackupVerifier } from "../storage/BackupVerifier.js";
import {
  BackupError,
  type BackupEvent,
  type DeviceTarget,
  type DeviceTransport,
} from "../transport/DeviceTransport.js";

export type RunReport =
  | {
      readonly runId: number;
      readonly outcome: "succeeded";
      readonly durationMs: number;
    }
  | {
      readonly runId: number;
      readonly outcome: "failed";
      /**
       * A transport failure reason ("device-locked", "unreachable", ...) or
       * one of this runner's own: "heads-up-failed", "verification-failed".
       */
      readonly reason: string;
      readonly message: string;
    };

export interface BackupRunnerDeps {
  readonly transport: DeviceTransport;
  readonly store: BackupStore;
  readonly verifier: BackupVerifier;
  readonly state: StateStore;
  readonly notifier: Notifier;
  readonly log: Logger;
  readonly clock: () => Date;
  /** Resolves after the delay, or early if the signal aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Gap between the heads-up notification and the backup starting. */
  readonly headsUpLeadSeconds: number;
}

/** Progress is recorded only when it crosses one of these steps. */
const PROGRESS_STEP_PERCENT = 10;

export function targetFor(device: DeviceConfig): DeviceTarget {
  return {
    udid: device.udid,
    endpoint: {
      kind: "tcp",
      host: device.host,
      pairRecordPath: device.pairRecordPath,
      ...(device.port !== undefined && { port: device.port }),
    },
  };
}

class RunFailure extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Carries one backup from start to finish: warn the owner, back up, verify
 * the result, and record what happened. Whatever goes wrong, the run is
 * recorded as finished, and the backup is only marked as verified when it
 * is.
 */
export class BackupRunner {
  constructor(private readonly deps: BackupRunnerDeps) {}

  async run(device: DeviceConfig, signal?: AbortSignal): Promise<RunReport> {
    const { state, clock, log, notifier } = this.deps;
    const runId = state.startRun(device.id, clock());
    log("info", "backup starting", { device: device.id, runId });

    let report: RunReport;
    try {
      const { durationMs } = await this.#attempt(device, runId, signal);
      state.finishRun(runId, clock(), { outcome: "succeeded", durationMs });
      report = { runId, outcome: "succeeded", durationMs };
      log("info", "backup succeeded", { device: device.id, runId, durationMs });
    } catch (error) {
      const reason =
        error instanceof RunFailure || error instanceof BackupError
          ? error.reason
          : "failed";
      const message = describe(error);
      state.finishRun(runId, clock(), { outcome: "failed", reason, message });
      report = { runId, outcome: "failed", reason, message };
      log("warning", "backup failed", { device: device.id, runId, reason, message });
    }

    // The outcome is already recorded; a notifier fault must not change it.
    try {
      await notifier.notify(
        report.outcome === "succeeded"
          ? {
              kind: "backup-succeeded",
              deviceId: device.id,
              deviceName: device.name,
              durationMs: report.durationMs,
            }
          : {
              kind: "backup-failed",
              deviceId: device.id,
              deviceName: device.name,
              reason: report.reason,
              message: report.message,
            },
      );
    } catch (error) {
      log("error", "could not send the result notification", {
        device: device.id,
        runId,
        error: describe(error),
      });
    }
    return report;
  }

  async #attempt(
    device: DeviceConfig,
    runId: number,
    signal: AbortSignal | undefined,
  ): Promise<{ durationMs: number }> {
    const { transport, store, verifier, state, notifier, clock, sleep, log } = this.deps;

    // The passcode prompt explains nothing, so an unannounced one is
    // indistinguishable from something to distrust. No heads-up, no backup.
    try {
      await notifier.notify({
        kind: "backup-starting",
        deviceId: device.id,
        deviceName: device.name,
      });
    } catch (error) {
      throw new RunFailure(
        "heads-up-failed",
        `the heads-up notification could not be sent, so no backup was started: ${describe(error)}`,
      );
    }
    await sleep(this.deps.headsUpLeadSeconds * 1000, signal);
    if (signal?.aborted) throw new BackupError("backup cancelled", "cancelled");

    // From here the backup on disk is being changed, so it stops counting as
    // verified until this run proves it again.
    await store.beginRun(device.id);

    const run = transport.startBackup({
      ...targetFor(device),
      backupRoot: store.deviceDir(device.id),
      ...(signal && { signal }),
    });
    let lastStep = -1;
    run.onEvent((event: BackupEvent) => {
      if (event.type === "progress") {
        const step = Math.floor(event.percent / PROGRESS_STEP_PERCENT);
        if (step <= lastStep) return;
        lastStep = step;
      }
      state.recordEvent(runId, clock(), event);

      // The log is the only live view of a run. Someone who started it by
      // hand needs the cue to pick up their phone, and a quiet log should
      // never be the sign that a backup is healthy.
      const fields = { device: device.id, runId };
      if (event.type === "passcode-required") {
        this.deps.log("info", "waiting for the passcode on the phone", fields);
      } else if (event.type === "passcode-dismissed") {
        // The phone reports the prompt closing, not whether it was answered.
        this.deps.log("info", "passcode prompt closed", fields);
      } else if (event.type === "progress") {
        this.deps.log("info", "backup progress", { ...fields, percent: event.percent });
      }
    });
    const result = await run.done;

    const verification = await verifier.verify(store.backupDir(device.id, device.udid));
    if (!verification.ok) {
      throw new RunFailure(
        "verification-failed",
        `the backup did not verify: ${verification.problems.join("; ")}`,
      );
    }
    if (verification.udid !== undefined && verification.udid !== device.udid) {
      throw new RunFailure(
        "verification-failed",
        `the backup belongs to ${verification.udid}, not ${device.udid}`,
      );
    }
    if (verification.isEncrypted === false) {
      throw new RunFailure(
        "verification-failed",
        "the backup is not encrypted, so it does not count as a good backup",
      );
    }

    try {
      await store.markVerified(device.id, device.udid, clock());
    } catch (error) {
      // The backup is good; only the signal to outside tools is missing, and
      // a missing marker errs on the safe side for them.
      log("error", "could not write the verified marker", {
        device: device.id,
        runId,
        error: describe(error),
      });
    }
    return { durationMs: result.durationMs };
  }
}
