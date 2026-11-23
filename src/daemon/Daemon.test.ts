import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  type DeviceConfig,
  type NightstandConfig,
} from "../config/config.js";
import type { LogLevel, Notification } from "../notify/Notifier.js";
import type { RunReport } from "../runner/BackupRunner.js";
import { DeviceLocator } from "../discovery/DeviceLocator.js";
import { StateStore } from "../state/StateStore.js";
import { FAKE_UDID, FakeTransport, fakeStatus } from "../testing/fakeTransport.js";
import { DeviceError } from "../transport/DeviceTransport.js";
import { Daemon } from "./Daemon.js";

/** Local time on a fixed day, so windows behave the same in any timezone. */
function at(hours: number, minutes = 0, dayOffset = 0): Date {
  return new Date(2026, 10, 24 + dayOffset, hours, minutes, 0, 0);
}

function deviceConfig(overrides: Partial<DeviceConfig> = {}): DeviceConfig {
  return {
    id: "mike",
    name: "Mike's iPhone",
    udid: FAKE_UDID,
    host: "10.0.0.7",
    port: undefined,
    pairRecordPath: "/secrets/mike.plist",
    // Most tests are about something other than the trigger, so they use the
    // simpler one: any time on a charger.
    policy: { ...DEFAULT_POLICY, trigger: "on-charger" },
    ...overrides,
  };
}

let state: StateStore;
beforeEach(() => {
  state = new StateStore(":memory:");
});
afterEach(() => {
  state.close();
});

function harness(devices: DeviceConfig[] = [deviceConfig()]) {
  const transport = new FakeTransport();
  const sent: Notification[] = [];
  const logs: { level: LogLevel; message: string; fields: unknown }[] = [];
  const ran: string[] = [];
  let now = at(19);

  const config: NightstandConfig = {
    backupRoot: "/backups",
    stateDir: "/state",
    pollIntervalSeconds: 120,
    headsUpLeadSeconds: 5,
    sidecar: { pythonPath: undefined, scriptPath: undefined },
    discovery: { ranges: [], scanIntervalSeconds: 300 },
    devices,
  };

  /** A runner that records a successful run in the state store. */
  let runImpl = (device: DeviceConfig): Promise<RunReport> => {
    const runId = state.startRun(device.id, now);
    state.finishRun(runId, now, {
      outcome: "succeeded",
      durationMs: 1,
    });
    return Promise.resolve({
      runId,
      outcome: "succeeded",
      durationMs: 1,
    });
  };

  const sleeps: number[] = [];
  let onSleep = (): void => undefined;
  const scanner = { enabled: false, candidates: () => Promise.resolve<string[]>([]) };
  const hosts: string[] = [];
  const daemon = new Daemon({
    config,
    locator: new DeviceLocator({
      transport,
      addresses: state,
      scanner,
      log: () => undefined,
      clock: () => now,
    }),
    runner: {
      run: (device, host) => {
        ran.push(device.id);
        hosts.push(host);
        return runImpl(device);
      },
    },
    state,
    notifier: {
      notify: (n) => {
        sent.push(n);
        return Promise.resolve();
      },
    },
    log: (level, message, fields) => logs.push({ level, message, fields }),
    clock: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      onSleep();
      // Yield for real, so cycles that never wait on anything else take turns.
      await settle();
    },
  });

  return {
    daemon,
    transport,
    sent,
    logs,
    ran,
    hosts,
    scanner,
    sleeps,
    setNow: (date: Date) => {
      now = date;
    },
    setRun: (impl: typeof runImpl) => {
      runImpl = impl;
    },
    onSleep: (callback: () => void) => {
      onSleep = callback;
    },
  };
}

function failRun(reason: string, when: Date) {
  return (device: DeviceConfig): Promise<RunReport> => {
    const runId = state.startRun(device.id, when);
    state.finishRun(runId, when, { outcome: "failed", reason, message: reason });
    return Promise.resolve({ runId, outcome: "failed", reason, message: reason });
  };
}

const ON_BATTERY = {
  levelPercent: 90,
  isCharging: false,
  externalPowerConnected: false,
  fullyCharged: false,
};

function sam(): DeviceConfig {
  return deviceConfig({
    id: "sam",
    name: "Sam's iPhone",
    udid: "00008150-000F0E0D0C0B002E",
    host: "10.0.0.8",
  });
}

/** Each device answers a probe with its own identity. */
function probeEachAsItself(h: ReturnType<typeof harness>): FakeTransport["probe"] {
  return (target) => {
    h.transport.probes.push(target);
    return Promise.resolve(fakeStatus({ udid: target.udid }));
  };
}

/** A promise that settles only when told to, to hold a backup "in progress". */
function gate<T>() {
  let open!: (value: T) => void;
  const closed = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { closed, open };
}

/** Let everything that is ready to run, run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("Daemon.tick", () => {
  it("backs up a device that is due, home and on a charger", async () => {
    const h = harness();
    const outcomes = await h.daemon.tick();
    expect(h.ran).toEqual(["mike"]);
    expect(outcomes).toMatchObject([{ deviceId: "mike", action: "backed-up" }]);
    expect(h.transport.probes[0]).toMatchObject({
      udid: FAKE_UDID,
      endpoint: { kind: "tcp", host: "10.0.0.7" },
    });
  });

  it("does not back up again until the interval has passed", async () => {
    const h = harness();
    await h.daemon.tick();
    h.setNow(at(19, 30));
    const outcomes = await h.daemon.tick();
    expect(h.ran).toEqual(["mike"]);
    expect(outcomes).toMatchObject([{ action: "waited", reason: "not-due" }]);
  });

  it("does not contact the phone at all while a backup is far from due", async () => {
    const h = harness();
    await h.daemon.tick();
    const probesSoFar = h.transport.probes.length;

    h.setNow(at(8, 0, 1)); // 13 hours later; due at 15:00
    expect(await h.daemon.tick()).toMatchObject([
      { action: "waited", reason: "not-due", until: at(15, 0, 1) },
    ]);
    expect(h.transport.probes).toHaveLength(probesSoFar);
  });

  it("watches the phone from half an hour before a backup is due, without starting one", async () => {
    const h = harness();
    await h.daemon.tick();
    const probesSoFar = h.transport.probes.length;

    h.setNow(at(14, 40, 1));
    expect(await h.daemon.tick()).toMatchObject([{ action: "waited", reason: "not-due" }]);
    expect(h.transport.probes).toHaveLength(probesSoFar + 1);
    expect(h.ran).toEqual(["mike"]);
  });

  it("treats a phone that is away as normal: no attempt recorded, no back-off", async () => {
    const h = harness();
    h.transport.probeResult = new DeviceError("no answer", "unreachable");
    expect(await h.daemon.tick()).toMatchObject([
      { action: "waited", reason: "unreachable" },
    ]);
    expect(state.attemptsSince("mike", new Date(0))).toEqual([]);

    // The phone comes home two minutes later and is backed up straight away.
    h.transport.probeResult = fakeStatus();
    h.setNow(at(19, 2));
    expect(await h.daemon.tick()).toMatchObject([{ action: "backed-up" }]);
  });

  it("never backs up a phone that is on battery", async () => {
    const h = harness();
    h.transport.probeResult = fakeStatus({ battery: ON_BATTERY });
    expect(await h.daemon.tick()).toMatchObject([{ action: "waited", reason: "on-battery" }]);
    expect(h.ran).toEqual([]);
  });

  it("refuses to back up a phone whose backup encryption has been turned off", async () => {
    const h = harness();
    h.transport.probeResult = fakeStatus({ backupEncryptionEnabled: false });
    expect(await h.daemon.tick()).toMatchObject([
      { action: "waited", reason: "encryption-off" },
    ]);
    expect(h.ran).toEqual([]);
  });

  it("reports a rejected pair record distinctly from an absent phone", async () => {
    const h = harness();
    h.transport.probeResult = new DeviceError("pair record refused", "not-paired");
    expect(await h.daemon.tick()).toMatchObject([{ action: "waited", reason: "not-paired" }]);
  });

  it("keeps asking after unanswered prompts, pausing between each", async () => {
    const h = harness();
    for (const [hour, minute] of [
      [19, 0],
      [19, 10],
      [19, 20],
    ] as const) {
      h.setNow(at(hour, minute));
      h.setRun(failRun("device-locked", at(hour, minute)));
      expect(await h.daemon.tick()).toMatchObject([{ action: "backed-up" }]);

      h.setNow(at(hour, minute + 5));
      expect(await h.daemon.tick()).toMatchObject([
        { action: "waited", reason: "backing-off", until: at(hour, minute + 10) },
      ]);
    }
    // Three prompts in half an hour, and it would ask a fourth time.
    expect(h.ran).toEqual(["mike", "mike", "mike"]);
  });

  it("considers every device even when one of them throws", async () => {
    const h = harness([deviceConfig(), sam()]);
    h.setRun((device) =>
      device.id === "mike"
        ? Promise.reject(new Error("disk on fire"))
        : Promise.resolve({ runId: 1, outcome: "succeeded", durationMs: 1 }),
    );
    h.transport.probe = probeEachAsItself(h);

    const outcomes = await h.daemon.tick();

    expect(h.ran.sort()).toEqual(["mike", "sam"]);
    expect(outcomes).toMatchObject([
      { deviceId: "mike", action: "waited", reason: "error" },
      { deviceId: "sam", action: "backed-up" },
    ]);
    expect(h.logs.some((l) => l.level === "error" && l.message.includes("unexpected"))).toBe(true);
  });

  it("logs a waiting reason once, not on every poll", async () => {
    const h = harness();
    h.transport.probeResult = fakeStatus({ battery: ON_BATTERY });
    await h.daemon.tick();
    await h.daemon.tick();
    await h.daemon.tick();
    expect(h.logs.filter((l) => l.message === "waiting")).toHaveLength(1);

    h.transport.probeResult = new DeviceError("no answer", "unreachable");
    await h.daemon.tick();
    expect(h.logs.filter((l) => l.message === "waiting")).toHaveLength(2);
  });
});

describe('Daemon with the "plugged-in" trigger', () => {
  const pluggedIn = () =>
    deviceConfig({
      policy: { ...DEFAULT_POLICY, trigger: "plugged-in", pluggedInWindowMinutes: 30 },
    });

  it("starts a backup when it sees the phone go onto power", async () => {
    const h = harness([pluggedIn()]);
    h.transport.probeResult = fakeStatus({ battery: ON_BATTERY });
    expect(await h.daemon.tick()).toMatchObject([{ action: "waited", reason: "on-battery" }]);

    h.transport.probeResult = fakeStatus();
    h.setNow(at(19, 2));
    expect(await h.daemon.tick()).toMatchObject([{ action: "backed-up" }]);
  });

  it("does not start on a phone that was already charging when the service started", async () => {
    const h = harness([pluggedIn()]);
    expect(await h.daemon.tick()).toMatchObject([
      { action: "waited", reason: "waiting-for-plug-in" },
    ]);
    expect(h.ran).toEqual([]);
  });

  it("does not prompt a phone left charging overnight when its backup falls due", async () => {
    const h = harness([pluggedIn()]);
    // Yesterday's backup finished at 07:00, so the next is due at 03:00.
    const runId = state.startRun("mike", at(6, 55));
    state.finishRun(runId, at(7), { outcome: "succeeded", durationMs: 1 });

    // Plugged in at 22:00, seen by the daemon only once it starts watching.
    h.transport.probeResult = fakeStatus({ battery: ON_BATTERY });
    h.setNow(at(2, 30, 1));
    await h.daemon.tick();
    h.transport.probeResult = fakeStatus();
    h.setNow(at(2, 32, 1));
    await h.daemon.tick(); // goes onto power at 02:32, not yet due

    h.setNow(at(3, 10, 1)); // due, 38 minutes after the plug-in
    expect(await h.daemon.tick()).toMatchObject([
      { action: "waited", reason: "plug-in-window-passed" },
    ]);
    expect(h.ran).toEqual([]);

    // Unplugged in the morning and plugged in again that evening: now it runs.
    h.transport.probeResult = fakeStatus({ battery: ON_BATTERY });
    h.setNow(at(7, 0, 1));
    await h.daemon.tick();
    h.transport.probeResult = fakeStatus();
    h.setNow(at(18, 0, 1));
    expect(await h.daemon.tick()).toMatchObject([{ action: "backed-up" }]);
  });

  it("retries an unanswered prompt only while still inside the plug-in window", async () => {
    const h = harness([
      deviceConfig({
        policy: {
          ...DEFAULT_POLICY,
          trigger: "plugged-in",
          pluggedInWindowMinutes: 30,
          retryAfterTimeoutMinutes: 10,
        },
      }),
    ]);
    h.transport.probeResult = fakeStatus({ battery: ON_BATTERY });
    await h.daemon.tick();
    h.transport.probeResult = fakeStatus();

    const prompts: string[] = [];
    for (let minute = 2; minute <= 58; minute += 2) {
      h.setNow(at(19, minute));
      h.setRun(failRun("device-locked", at(19, minute)));
      const [outcome] = await h.daemon.tick();
      if (outcome?.action === "backed-up") prompts.push(`19:${String(minute).padStart(2, "0")}`);
    }

    // Plugged in at 19:02: asked then and every ten minutes up to half an
    // hour later, and not again after that although it is still on power.
    expect(prompts).toEqual(["19:02", "19:12", "19:22", "19:32"]);
  });

  it("logs the phone going onto and off power", async () => {
    const h = harness([pluggedIn()]);
    h.transport.probeResult = fakeStatus({ battery: ON_BATTERY });
    await h.daemon.tick();
    h.transport.probeResult = fakeStatus();
    await h.daemon.tick();
    await h.daemon.tick();

    expect(h.logs.filter((l) => l.message === "phone power state changed")).toEqual([
      {
        level: "info",
        message: "phone power state changed",
        fields: { device: "mike", from: "unknown", to: "on-battery" },
      },
      {
        level: "info",
        message: "phone power state changed",
        fields: { device: "mike", from: "on-battery", to: "on-power", sawPlugIn: true },
      },
    ]);
  });
});

describe("Daemon stale alerts", () => {
  it("alerts once a day while the last good backup is too old", async () => {
    const h = harness();
    const runId = state.startRun("mike", at(19, 0, -4));
    state.finishRun(runId, at(19, 6, -4), {
      outcome: "succeeded",
      durationMs: 1,
    });
    h.transport.probeResult = new DeviceError("no answer", "unreachable");

    h.setNow(at(8));
    await h.daemon.tick();
    h.setNow(at(8, 2));
    await h.daemon.tick();
    expect(h.sent.filter((n) => n.kind === "backup-stale")).toEqual([
      {
        kind: "backup-stale",
        deviceId: "mike",
        deviceName: "Mike's iPhone",
        lastSuccessAt: at(19, 6, -4),
      },
    ]);

    h.setNow(at(8, 3, 1));
    await h.daemon.tick();
    expect(h.sent.filter((n) => n.kind === "backup-stale")).toHaveLength(2);
  });

  it("does not alert about a device that has never been backed up", async () => {
    const h = harness();
    h.transport.probeResult = new DeviceError("no answer", "unreachable");
    await h.daemon.tick();
    expect(h.sent).toEqual([]);
  });
});

describe("Daemon finding a phone", () => {
  it("backs the phone up at the address discovery found, and remembers it", async () => {
    const h = harness([deviceConfig({ host: undefined })]);
    h.scanner.enabled = true;
    h.scanner.candidates = () => Promise.resolve(["10.0.0.31", "10.0.0.57"]);
    h.transport.probe = (target) => {
      h.transport.probes.push(target);
      const host = target.endpoint.kind === "tcp" ? target.endpoint.host : "";
      // 10.0.0.31 is some other Apple device and refuses this pair record.
      return host === "10.0.0.57"
        ? Promise.resolve(fakeStatus())
        : Promise.reject(new DeviceError("pair record refused", "not-paired"));
    };

    expect(await h.daemon.tick()).toMatchObject([{ action: "backed-up" }]);
    expect(h.hosts).toEqual(["10.0.0.57"]);
    expect(state.lastAddress("mike")).toBe("10.0.0.57");
  });

  it("treats a phone discovery cannot find as away", async () => {
    const h = harness([deviceConfig({ host: undefined })]);
    h.scanner.enabled = true;
    expect(await h.daemon.tick()).toMatchObject([{ action: "waited", reason: "unreachable" }]);
    expect(state.attemptsSince("mike", new Date(0))).toEqual([]);
  });
});

describe("Daemon with two phones", () => {
  it("backs up both at the same time when both are ready", async () => {
    const h = harness([deviceConfig(), sam()]);
    h.transport.probe = probeEachAsItself(h);
    const inProgress = new Set<string>();
    let mostAtOnce = 0;
    const release = gate<void>();
    h.setRun(async (device) => {
      inProgress.add(device.id);
      mostAtOnce = Math.max(mostAtOnce, inProgress.size);
      await release.closed;
      inProgress.delete(device.id);
      return { runId: 1, outcome: "succeeded", durationMs: 1 };
    });

    const tick = h.daemon.tick();
    await settle();
    expect([...inProgress].sort()).toEqual(["mike", "sam"]);

    release.open();
    expect(await tick).toMatchObject([
      { deviceId: "mike", action: "backed-up" },
      { deviceId: "sam", action: "backed-up" },
    ]);
    expect(mostAtOnce).toBe(2);
  });

  it("keeps watching one phone while the other's backup is still running", async () => {
    const h = harness([deviceConfig(), sam()]);
    h.transport.probe = (target) => {
      h.transport.probes.push(target);
      // Sam is home but on battery; Mike is on a charger.
      return Promise.resolve(
        target.udid === FAKE_UDID
          ? fakeStatus()
          : fakeStatus({ udid: target.udid, battery: ON_BATTERY }),
      );
    };
    const mikesBackup = gate<RunReport>();
    h.setRun(() => mikesBackup.closed);
    const controller = new AbortController();
    const polls = gate<void>();
    let samProbes = 0;
    h.onSleep(() => {
      samProbes = h.transport.probes.filter((probe) => probe.udid !== FAKE_UDID).length;
      if (samProbes >= 3) polls.open();
    });

    const running = h.daemon.run(controller.signal);
    await polls.closed;

    // Mike's backup has not finished, yet Sam has been looked at three times.
    expect(h.ran).toEqual(["mike"]);
    expect(samProbes).toBeGreaterThanOrEqual(3);

    controller.abort();
    mikesBackup.open({ runId: 1, outcome: "succeeded", durationMs: 1 });
    await running;
  });

  it("never starts a second backup of a phone whose first is still running", async () => {
    const h = harness();
    const release = gate<void>();
    h.setRun(async (device) => {
      const runId = state.startRun(device.id, at(19));
      await release.closed;
      state.finishRun(runId, at(19, 6), { outcome: "succeeded", durationMs: 1 });
      return { runId, outcome: "succeeded", durationMs: 1 };
    });

    const first = h.daemon.tick();
    await settle();
    expect(await h.daemon.tick()).toMatchObject([
      { action: "waited", reason: "already-running" },
    ]);
    expect(h.ran).toEqual(["mike"]);

    release.open();
    await first;
  });
});

describe("Daemon.run", () => {
  it("closes off interrupted runs, polls at the configured interval, and stops on abort", async () => {
    const h = harness();
    const orphan = state.startRun("mike", at(18, 0, -1));
    const controller = new AbortController();
    h.transport.probeResult = new DeviceError("no answer", "unreachable");
    h.onSleep(() => {
      if (h.sleeps.length === 3) controller.abort();
    });

    await h.daemon.run(controller.signal);

    expect(state.getRun(orphan)).toMatchObject({
      outcome: "failed",
      failureReason: "interrupted",
    });
    expect(h.transport.probes).toHaveLength(3);
    expect(h.sleeps).toEqual([120_000, 120_000, 120_000]);
    expect(h.logs.at(-1)?.message).toBe("nightstand stopped");
  });
});
