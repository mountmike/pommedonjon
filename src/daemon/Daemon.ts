import type { DeviceConfig, PommedonjonConfig } from "../config/config.js";
import type { Logger, Notifier } from "../notify/Notifier.js";
import { isStale, readyToStart, schedule } from "../policy/policy.js";
import {
  INITIAL_POWER_STATE,
  observe,
  type PowerReading,
  type PowerState,
} from "../policy/power.js";
import type { DeviceLocator } from "../discovery/DeviceLocator.js";
import type { BackupRunner, RunReport } from "../runner/BackupRunner.js";
import type { StateStore } from "../state/StateStore.js";
import { DeviceError } from "../transport/DeviceTransport.js";

/** What the daemon did about one device on one pass. */
export type DeviceOutcome =
  | {
      readonly deviceId: string;
      readonly action: "waited";
      /**
       * A schedule reason ("not-due", "backing-off", ...), a readiness
       * reason ("on-battery", "waiting-for-plug-in", "plug-in-window-passed",
       * "encryption-off"), or a probe result ("unreachable", "not-paired",
       * "probe-failed").
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
  readonly config: PommedonjonConfig;
  readonly locator: Pick<DeviceLocator, "locate">;
  readonly runner: Pick<BackupRunner, "run">;
  readonly state: StateStore;
  readonly notifier: Notifier;
  readonly log: Logger;
  readonly clock: () => Date;
  /** Which build this is, for the start-up log line. */
  readonly version?: string;
  /** Resolves after the delay, or early if the signal aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the schedule looks for an earlier failure to pace itself by. */
const HISTORY_MS = DAY_MS;
const STALE_ALERT = "stale";

/**
 * Decides, for each device, whether now is the moment to back up, and runs
 * the backup when it is. Every device has its own independent cycle: two
 * phones can back up at the same time, and one that is slow, faulty or
 * waiting on its owner never delays another.
 */
export class Daemon {
  /** The last thing logged per device, so the log shows changes, not polls. */
  readonly #lastLogged = new Map<string, string>();
  /** What recent probes say about each phone's power, to spot a plug-in. */
  readonly #power = new Map<string, PowerState>();

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
    log("info", "pommedonjon started", {
      ...(this.deps.version !== undefined && { version: this.deps.version }),
      devices: config.devices.map((device) => device.id),
      pollIntervalSeconds: config.pollIntervalSeconds,
    });

    await Promise.all(config.devices.map((device) => this.#cycle(device, signal)));
    log("info", "pommedonjon stopped");
  }

  /** One device's cycle: consider it, pause, repeat, until told to stop. */
  async #cycle(device: DeviceConfig, signal: AbortSignal): Promise<void> {
    const { config, sleep } = this.deps;
    while (!signal.aborted) {
      await this.#pass(device, signal);
      await sleep(config.pollIntervalSeconds * 1000, signal);
    }
  }

  /** Consider every configured device once, all at the same time. */
  tick(signal?: AbortSignal): Promise<DeviceOutcome[]> {
    return Promise.all(this.deps.config.devices.map((device) => this.#pass(device, signal)));
  }

  /** Consider one device once. Never rejects. */
  async #pass(device: DeviceConfig, signal?: AbortSignal): Promise<DeviceOutcome> {
    let outcome: DeviceOutcome;
    try {
      outcome = await this.#consider(device, signal);
    } catch (error) {
      // One device's fault must not stop it, or the others, being considered.
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log("error", "unexpected error considering a device", {
        device: device.id,
        error: message,
      });
      outcome = { deviceId: device.id, action: "waited", reason: "error" };
    }
    this.#logChange(outcome);
    return outcome;
  }

  async #consider(device: DeviceConfig, signal?: AbortSignal): Promise<DeviceOutcome> {
    const { locator, runner, state, clock } = this.deps;
    const now = clock();
    const lastSuccessAt = state.lastSuccessAt(device.id);

    await this.#alertIfStale(device, lastSuccessAt, now);

    const plan = schedule({
      now,
      policy: device.policy,
      lastSuccessAt,
      recentAttempts: state.attemptsSince(device.id, new Date(now.getTime() - HISTORY_MS)),
    });
    const blocked = (): DeviceOutcome | undefined =>
      plan.start.allowed
        ? undefined
        : {
            deviceId: device.id,
            action: "waited",
            reason: plan.start.reason,
            ...(plan.start.until && { until: plan.start.until }),
          };
    if (!plan.observe) {
      return blocked() ?? { deviceId: device.id, action: "waited", reason: "not-due" };
    }

    // A phone that is away from home is the normal case, not a failure: it
    // is not recorded as an attempt and does not trigger a back-off.
    let located;
    try {
      located = await locator.locate(device);
    } catch (error) {
      if (!(error instanceof DeviceError)) throw error;
      this.#observe(device, "unreachable", now);
      return {
        deviceId: device.id,
        action: "waited",
        reason: error.reason === "failed" ? "probe-failed" : error.reason,
      };
    }
    const { status, host } = located;
    const power = this.#observe(
      device,
      status.battery.externalPowerConnected ? "on-power" : "on-battery",
      now,
    );

    const waiting = blocked();
    if (waiting) return waiting;

    if (!status.backupEncryptionEnabled) {
      // Never take an unencrypted backup just because encryption got turned
      // off on the phone. Turning it back on is the owner's decision.
      return { deviceId: device.id, action: "waited", reason: "encryption-off" };
    }
    const readiness = readyToStart(device.policy, power, now);
    if (!readiness.ready) {
      return { deviceId: device.id, action: "waited", reason: readiness.reason };
    }

    const report = await runner.run(device, host, signal);
    return { deviceId: device.id, action: "backed-up", report };
  }

  /** Fold a probe result into what is known, logging when the picture changes. */
  #observe(device: DeviceConfig, reading: PowerReading, at: Date): PowerState {
    const before = this.#power.get(device.id) ?? INITIAL_POWER_STATE;
    const after = observe(before, reading, at);
    this.#power.set(device.id, after);
    if (after.kind !== before.kind) {
      const change = {
        from: before.kind,
        to: after.kind,
        ...(after.kind === "on-power" && { sawPlugIn: after.pluggedIn }),
      };
      this.deps.log("info", "phone power state changed", { device: device.id, ...change });
      this.deps.state.recordDeviceEvent(device.id, at, "power", change);
    }
    return after;
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
    const detail = {
      reason: outcome.reason,
      ...(outcome.until && { until: outcome.until.toISOString() }),
    };
    this.deps.log("info", "waiting", { device: outcome.deviceId, ...detail });
    // Kept as well as logged: "why did no backup start?" is the question a
    // trial of the schedule most often has to answer.
    this.deps.state.recordDeviceEvent(outcome.deviceId, this.deps.clock(), "waiting", detail);
  }
}
