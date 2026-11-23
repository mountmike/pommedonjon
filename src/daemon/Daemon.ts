import type { DeviceConfig, NightstandConfig } from "../config/config.js";
import type { Logger, Notifier } from "../notify/Notifier.js";
import { deviceReady, isStale, shouldAttempt } from "../policy/policy.js";
import { targetFor, type BackupRunner, type RunReport } from "../runner/BackupRunner.js";
import type { StateStore } from "../state/StateStore.js";
import { DeviceError, type DeviceTransport } from "../transport/DeviceTransport.js";

/** What the daemon did about one device on one pass. */
export type DeviceOutcome =
  | {
      readonly deviceId: string;
      readonly action: "waited";
      /**
       * A policy reason ("not-due", "outside-window", ...), a readiness
       * reason ("on-battery", "battery-low", "encryption-off"), or a probe
       * result ("unreachable", "not-paired", "probe-failed").
       */
      readonly reason: string;
      readonly until?: Date;
    }
  | {
      readonly deviceId: string;
      readonly action: "backed-up";
      readonly report: RunReport;
    };

export interface DaemonDeps {
  readonly config: NightstandConfig;
  readonly transport: DeviceTransport;
  readonly runner: Pick<BackupRunner, "run">;
  readonly state: StateStore;
  readonly notifier: Notifier;
  readonly log: Logger;
  readonly clock: () => Date;
  /** Resolves after the delay, or early if the signal aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the policy looks; a little over the 24-hour prompt budget. */
const HISTORY_MS = 25 * 60 * 60 * 1000;
const STALE_ALERT = "stale";

/**
 * Decides, device by device, whether now is the moment to back up, and runs
 * the backup when it is. Devices are handled one at a time so two phones
 * never compete for the disk or the network.
 */
export class Daemon {
  /** The last thing logged per device, so the log shows changes, not polls. */
  readonly #lastLogged = new Map<string, string>();

  constructor(private readonly deps: DaemonDeps) {}

  /** Run until the signal aborts. */
  async run(signal: AbortSignal): Promise<void> {
    const { config, state, log, clock, sleep } = this.deps;
    const interrupted = state.failInterruptedRuns(clock());
    if (interrupted > 0) {
      log("warning", "closed off runs left unfinished by a previous stop", {
        count: interrupted,
      });
    }
    log("info", "nightstand started", {
      devices: config.devices.map((device) => device.id),
      pollIntervalSeconds: config.pollIntervalSeconds,
    });

    while (!signal.aborted) {
      await this.tick(signal);
      await sleep(config.pollIntervalSeconds * 1000, signal);
    }
    log("info", "nightstand stopped");
  }

  /** One pass over every configured device. */
  async tick(signal?: AbortSignal): Promise<DeviceOutcome[]> {
    const outcomes: DeviceOutcome[] = [];
    for (const device of this.deps.config.devices) {
      if (signal?.aborted) break;
      let outcome: DeviceOutcome;
      try {
        outcome = await this.#consider(device, signal);
      } catch (error) {
        // One device's fault must not stop the others being considered.
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log("error", "unexpected error considering a device", {
          device: device.id,
          error: message,
        });
        outcome = { deviceId: device.id, action: "waited", reason: "error" };
      }
      this.#logChange(outcome);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  async #consider(device: DeviceConfig, signal?: AbortSignal): Promise<DeviceOutcome> {
    const { transport, runner, state, clock } = this.deps;
    const now = clock();
    const lastSuccessAt = state.lastSuccessAt(device.id);

    await this.#alertIfStale(device, lastSuccessAt, now);

    const decision = shouldAttempt({
      now,
      policy: device.policy,
      lastSuccessAt,
      recentAttempts: state.attemptsSince(device.id, new Date(now.getTime() - HISTORY_MS)),
    });
    if (!decision.attempt) {
      return {
        deviceId: device.id,
        action: "waited",
        reason: decision.reason,
        ...(decision.until && { until: decision.until }),
      };
    }

    // A phone that is away from home is the normal case, not a failure: it
    // is not recorded as an attempt and does not trigger a back-off.
    let status;
    try {
      status = await transport.probe(targetFor(device));
    } catch (error) {
      if (!(error instanceof DeviceError)) throw error;
      return {
        deviceId: device.id,
        action: "waited",
        reason: error.reason === "failed" ? "probe-failed" : error.reason,
      };
    }

    if (!status.backupEncryptionEnabled) {
      // Never take an unencrypted backup just because encryption got turned
      // off on the phone. Turning it back on is the owner's decision.
      return { deviceId: device.id, action: "waited", reason: "encryption-off" };
    }
    const readiness = deviceReady(device.policy, status);
    if (!readiness.ready) {
      return { deviceId: device.id, action: "waited", reason: readiness.reason };
    }

    const report = await runner.run(device, signal);
    return { deviceId: device.id, action: "backed-up", report };
  }

  async #alertIfStale(
    device: DeviceConfig,
    lastSuccessAt: Date | undefined,
    now: Date,
  ): Promise<void> {
    const { state, notifier, log } = this.deps;
    if (!lastSuccessAt || !isStale(device.policy, lastSuccessAt, now)) return;
    const lastAlert = state.lastAlertAt(device.id, STALE_ALERT);
    if (lastAlert && now.getTime() - lastAlert.getTime() < DAY_MS) return;
    try {
      await notifier.notify({
        kind: "backup-stale",
        deviceId: device.id,
        deviceName: device.name,
        lastSuccessAt,
      });
      state.recordAlert(device.id, STALE_ALERT, now);
    } catch (error) {
      log("error", "could not send the stale-backup alert", {
        device: device.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #logChange(outcome: DeviceOutcome): void {
    // Backups are logged by the runner; here only a change of waiting reason.
    if (outcome.action !== "waited") {
      this.#lastLogged.delete(outcome.deviceId);
      return;
    }
    if (this.#lastLogged.get(outcome.deviceId) === outcome.reason) return;
    this.#lastLogged.set(outcome.deviceId, outcome.reason);
    this.deps.log("info", "waiting", {
      device: outcome.deviceId,
      reason: outcome.reason,
      ...(outcome.until && { until: outcome.until.toISOString() }),
    });
  }
}
