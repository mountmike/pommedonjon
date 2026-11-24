import type { DeviceConfig } from "../config/config.js";
import type { Logger } from "../log.js";
import type { StateStore } from "../state/StateStore.js";
import type { BackupStore } from "../storage/BackupStore.js";
import type { BackupVerifier } from "../storage/BackupVerifier.js";
import { targetAt } from "../discovery/DeviceLocator.js";
import {
  BackupError,
  type BackupEvent,
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
       * this runner's own "verification-failed".
       */
      readonly reason: string;
      readonly message: string;
    };

export interface BackupRunnerDeps {
  readonly transport: DeviceTransport;
  readonly store: BackupStore;
  readonly verifier: BackupVerifier;
  readonly state: StateStore;
  readonly log: Logger;
  readonly clock: () => Date;
}

/** Progress is recorded only when it crosses one of these steps. */
const PROGRESS_STEP_PERCENT = 10;

class RunFailure extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The reason to abort a run's signal with when its owner asked for the
 * backup to stop, as opposed to the service shutting down.
 */
export const STOPPED_BY_OWNER = "stopped-by-owner";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Carries one backup from start to finish: back up, verify the result, and
 * record what happened. The phone's own passcode prompt is the only notice
 * its owner gets, so whoever calls this should have reason to think they
 * are at the phone. Whatever goes wrong, the run is
 * recorded as finished, and the backup is only marked as verified when it
 * is.
 */
export class BackupRunner {
  constructor(private readonly deps: BackupRunnerDeps) {}

  /**
   * @param host Where the phone is, as found by whoever decided to back it
   *   up. The runner does not go looking for it.
   */
  async run(
    device: DeviceConfig,
    host: string,
    signal?: AbortSignal,
    /** What started it: a moment, "request" or "command". Kept with the run. */
    startedBy?: string,
  ): Promise<RunReport> {
    const { state, clock, log } = this.deps;
    const runId = state.startRun(device.id, clock(), startedBy);
    log("info", "backup starting", {
      device: device.id,
      runId,
      ...(startedBy !== undefined && { startedBy }),
    });

    let report: RunReport;
    try {
      const { durationMs } = await this.#attempt(device, host, runId, signal);
      state.finishRun(runId, clock(), { outcome: "succeeded", durationMs });
      report = { runId, outcome: "succeeded", durationMs };
      log("info", "backup succeeded", { device: device.id, runId, durationMs });
    } catch (error) {
      const cause =
        error instanceof RunFailure || error instanceof BackupError ? error.reason : "failed";
      // Stopped by its owner from the app is its own reason: it is a "not
      // now", like Cancel on the phone, where the service stopping is not.
      const reason = cause === "cancelled" && signal?.reason === STOPPED_BY_OWNER ? "stopped" : cause;
      const message = describe(error);
      state.finishRun(runId, clock(), { outcome: "failed", reason, message });
      report = { runId, outcome: "failed", reason, message };
      log("warning", "backup failed", { device: device.id, runId, reason, message });
    }

    return report;
  }

  async #attempt(
    device: DeviceConfig,
    host: string,
    runId: number,
    signal: AbortSignal | undefined,
  ): Promise<{ durationMs: number }> {
    const { transport, store, verifier, state, clock, log } = this.deps;

    if (signal?.aborted) throw new BackupError("backup cancelled", "cancelled");

    // From here the backup on disk is being changed, so it stops counting as
    // verified until this run proves it again.
    await store.beginRun(device.id);

    const run = transport.startBackup({
      ...targetAt(device, host),
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
