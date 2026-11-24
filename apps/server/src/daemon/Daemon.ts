import type { DeviceConfig, PommedonjonConfig } from "../config/config.js";
import type { Logger } from "../log.js";
import { isStale, readyToStart, schedule, type WaitReason } from "../policy/policy.js";
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

/** What became of a request to back a phone up now. */
export type BackupRequestResult =
  /** A backup is being started; how it ends is in the log and the history. */
  | "started"
  /** No configured device has that id. */
  | "unknown-device"
  /** That phone is already being backed up. */
  | "already-running";

/** What became of a phone saying it has just been plugged in. */
export type PlugInReportResult =
  | { readonly outcome: "started" | "unknown-device" | "already-running" }
  | {
      /** The schedule says no: nothing is due, or the phone is being left alone. */
      readonly outcome: "not-now";
      readonly reason: Exclude<WaitReason, "already-running">;
      /** When the answer could change, where that is knowable. */
      readonly until?: Date;
    };

/** Why a backup was started outside the daemon's own polling. */
type RequestSource =
  /** Someone asked for a backup now. */
  | "request"
  /** The phone said it had just been plugged in, and a backup was due. */
  | "plug-in";

/** Why no backup is starting, and when that could change if it is knowable. */
export interface WaitingFor {
  readonly reason: string;
  readonly until?: Date;
}

/**
 * A backup that was asked for and is not, or not yet, a run: the daemon
 * looks for the phone first, and a run only begins once it has answered.
 */
export interface RequestState {
  /** When it was asked for. */
  readonly at: Date;
  /**
   * "connecting": the phone is being looked for. "not-started": it was not
   * found, or was not fit to back up, so there was no run.
   */
  readonly status: "connecting" | "not-started";
  /** Why not, for "not-started": "unreachable", "encryption-off" and so on. */
  readonly reason?: string;
}

export interface DaemonDeps {
  readonly config: PommedonjonConfig;
  readonly locator: Pick<DeviceLocator, "locate">;
  readonly runner: Pick<BackupRunner, "run">;
  readonly state: StateStore;
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
  /** Devices with a backup in hand, whichever way it was started. */
  readonly #busy = new Set<string>();
  /** Backups started on request that have not finished yet. */
  readonly #requested = new Set<Promise<void>>();
  /** Why each phone was not backed up on its last pass, for anyone asking. */
  readonly #waiting = new Map<string, WaitingFor>();
  /** The last backup asked for per phone, until a run takes its place. */
  readonly #requests = new Map<string, RequestState>();
  /** When each phone's overdue backup was last warned about: daily, not every poll. */
  readonly #staleWarnedAt = new Map<string, Date>();
  /** The signal `run` was given, so requested backups stop with the daemon. */
  #signal: AbortSignal | undefined;

  constructor(private readonly deps: DaemonDeps) {}

  /** Run until the signal aborts. */
  async run(signal: AbortSignal): Promise<void> {
    const { config, state, log, clock } = this.deps;
    this.#signal = signal;
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
    await Promise.all(this.#requested);
    log("info", "pommedonjon stopped");
  }

  /**
   * Back a phone up now, because someone asked: its owner, holding it.
   *
   * Nothing about the schedule is consulted: not whether a backup is due,
   * not whether the phone was just plugged in or is on a charger at all, not
   * a pause after an earlier failure. The one thing that still holds is that
   * a phone is never backed up twice at once.
   *
   * Returns as soon as that is decided. The backup carries on in the
   * background and reports through the log and the history like any other.
   */
  requestBackup(deviceId: string): BackupRequestResult {
    const device = this.deps.config.devices.find((candidate) => candidate.id === deviceId);
    if (!device) return "unknown-device";
    if (this.#busy.has(device.id)) return "already-running";

    this.#start(device, "request");
    return "started";
  }

  /**
   * The phone says it has just been plugged in: back it up if the schedule
   * allows one now.
   *
   * This is the daemon's usual trigger with the guesswork taken out. Polling
   * has to infer a plug-in from two readings minutes apart; here the phone
   * says so itself, the moment it happens. Everything else about the
   * schedule still applies: nothing starts unless a backup is due, inside
   * the allowed hours, and not during the pause after a failed attempt or a
   * dismissed prompt.
   */
  reportPlugIn(deviceId: string): PlugInReportResult {
    const { config, state, log, clock } = this.deps;
    const device = config.devices.find((candidate) => candidate.id === deviceId);
    if (!device) return { outcome: "unknown-device" };
    if (this.#busy.has(device.id)) return { outcome: "already-running" };

    const now = clock();
    const plan = schedule({
      now,
      policy: device.policy,
      lastSuccessAt: state.lastSuccessAt(device.id),
      recentAttempts: state.attemptsSince(device.id, new Date(now.getTime() - HISTORY_MS)),
    });
    if (plan.start.allowed) {
      this.#start(device, "plug-in");
      return { outcome: "started" };
    }
    const { reason, until } = plan.start;
    if (reason === "already-running") return { outcome: "already-running" };

    const detail = { reason, ...(until && { until: until.toISOString() }) };
    log("info", "plug-in reported, no backup started", { device: device.id, ...detail });
    state.recordDeviceEvent(device.id, now, "plug-in-reported", detail);
    return { outcome: "not-now", reason, ...(until && { until }) };
  }

  /** Begin a backup outside the polling cycle. The caller has checked `#busy`. */
  #start(device: DeviceConfig, source: RequestSource): void {
    this.#busy.add(device.id);
    const work = this.#backUpOnRequest(device, source).finally(() => {
      this.#busy.delete(device.id);
      this.#requested.delete(work);
    });
    this.#requested.add(work);
  }

  /** The work behind `requestBackup` and `reportPlugIn`. Never rejects. */
  async #backUpOnRequest(device: DeviceConfig, source: RequestSource): Promise<void> {
    const { locator, runner, state, log, clock } = this.deps;
    const now = clock();
    log("info", "backup requested", { device: device.id, source });
    state.recordDeviceEvent(device.id, now, "requested", { source });
    // Until a run exists there is nothing in the history to show for the
    // request, so what became of it is kept here for anyone asking.
    this.#requests.set(device.id, { at: now, status: "connecting" });
    const notStarted = (reason: string): void => {
      log("warning", "requested backup not started", { device: device.id, reason });
      this.#requests.set(device.id, { at: now, status: "not-started", reason });
    };
    let reached = false;
    try {
      const { status, host } = await locator.locate(device);
      this.#observe(
        device,
        status.battery.externalPowerConnected ? "on-power" : "on-battery",
        now,
      );
      if (!status.backupEncryptionEnabled) {
        // The same rule as for a scheduled backup: never an unencrypted one.
        notStarted("encryption-off");
        return;
      }
      reached = true;
      try {
        await runner.run(device, host, this.#signal);
      } finally {
        // The run is in the history now, and speaks for itself.
        this.#requests.delete(device.id);
      }
      // The next scheduled pass should say afresh why it is waiting.
      this.#lastLogged.delete(device.id);
    } catch (error) {
      if (error instanceof DeviceError) {
        notStarted(error.reason === "failed" ? "probe-failed" : error.reason);
        return;
      }
      log("error", "unexpected error in a requested backup", {
        device: device.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!reached) this.#requests.set(device.id, { at: now, status: "not-started", reason: "error" });
    }
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
    if (outcome.action === "waited") {
      this.#waiting.set(device.id, {
        reason: outcome.reason,
        ...(outcome.until && { until: outcome.until }),
      });
    } else {
      this.#waiting.delete(device.id);
    }
    this.#logChange(outcome);
    return outcome;
  }

  /**
   * Why a phone is not being backed up right now, as found on its last
   * pass. Undefined before its first pass, and just after a backup. This is
   * what is known, not a fresh look: a phone is only asked about itself
   * when a backup is nearly due.
   */
  waitingFor(deviceId: string): WaitingFor | undefined {
    return this.#waiting.get(deviceId);
  }

  /**
   * What became of the last backup asked for, while no run speaks for it:
   * still looking for the phone, or not started and why. Undefined once a
   * run has taken its place, and when nothing has been asked for.
   */
  requestFor(deviceId: string): RequestState | undefined {
    return this.#requests.get(deviceId);
  }

  async #consider(device: DeviceConfig, signal?: AbortSignal): Promise<DeviceOutcome> {
    const { locator, runner, state, clock } = this.deps;
    const now = clock();
    const lastSuccessAt = state.lastSuccessAt(device.id);

    this.#warnIfStale(device, lastSuccessAt, now);

    // A backup started on request is in hand: leave the phone to it.
    if (this.#busy.has(device.id)) {
      return { deviceId: device.id, action: "waited", reason: "already-running" };
    }

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

    // A request may have arrived while this pass was finding the phone.
    if (this.#busy.has(device.id)) {
      return { deviceId: device.id, action: "waited", reason: "already-running" };
    }
    this.#busy.add(device.id);
    try {
      const report = await runner.run(device, host, signal);
      return { deviceId: device.id, action: "backed-up", report };
    } finally {
      this.#busy.delete(device.id);
    }
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

  /**
   * Say so, once a day, while a phone has gone too long without a good
   * backup. A backup service usually fails by stopping quietly, and until
   * there is a status page the log is where that has to show.
   */
  #warnIfStale(device: DeviceConfig, lastSuccessAt: Date | undefined, now: Date): void {
    if (!lastSuccessAt || !isStale(device.policy, lastSuccessAt, now)) {
      this.#staleWarnedAt.delete(device.id);
      return;
    }
    const warnedAt = this.#staleWarnedAt.get(device.id);
    if (warnedAt && now.getTime() - warnedAt.getTime() < DAY_MS) return;
    this.#staleWarnedAt.set(device.id, now);
    this.deps.log("warning", "no good backup for too long", {
      device: device.id,
      lastSuccessAt: lastSuccessAt.toISOString(),
      staleAfterHours: device.policy.staleAfterHours,
    });
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
