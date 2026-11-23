import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  type DeviceConfig,
  type NightstandConfig,
} from "../config/config.js";
import type { LogLevel, Notification } from "../notify/Notifier.js";
import type { RunReport } from "../runner/BackupRunner.js";
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
    policy: {
      ...DEFAULT_POLICY,
      window: { startMinutes: 18 * 60, endMinutes: 22 * 60 },
    },
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
    snapshots: { strategy: "none", keep: 7 },
    sidecar: { pythonPath: undefined, scriptPath: undefined },
    devices,
  };

  /** A runner that records a successful run in the state store. */
  let runImpl = (device: DeviceConfig): Promise<RunReport> => {
    const runId = state.startRun(device.id, now);
    state.finishRun(runId, now, {
      outcome: "succeeded",
      durationMs: 1,
      snapshotPath: undefined,
    });
    return Promise.resolve({
      runId,
      outcome: "succeeded",
      durationMs: 1,
      snapshotPath: undefined,
    });
  };

  const sleeps: number[] = [];
  const daemon = new Daemon({
    config,
    transport,
    runner: {
      run: (device) => {
        ran.push(device.id);
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
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  return {
    daemon,
    transport,
    sent,
    logs,
    ran,
    sleeps,
    setNow: (date: Date) => {
      now = date;
    },
    setRun: (impl: typeof runImpl) => {
      runImpl = impl;
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

describe("Daemon.tick", () => {
  it("backs up a device that is due, home, charging and inside its window", async () => {
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

  it("does not contact the phone at all when a backup is not due or it is night", async () => {
    const h = harness();
    h.setNow(at(3));
    const outcomes = await h.daemon.tick();
    expect(outcomes).toMatchObject([{ action: "waited", reason: "outside-window" }]);
    expect(h.transport.probes).toEqual([]);
    expect(h.ran).toEqual([]);
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

  it("waits for a charger when the policy requires one", async () => {
    const h = harness();
    h.transport.probeResult = fakeStatus({
      battery: {
        levelPercent: 90,
        isCharging: false,
        externalPowerConnected: false,
        fullyCharged: false,
      },
    });
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

  it("backs off after a failed run and stops prompting once the budget is spent", async () => {
    const h = harness();
    h.setRun(failRun("device-locked", at(19)));
    await h.daemon.tick();

    h.setNow(at(19, 30));
    expect(await h.daemon.tick()).toMatchObject([{ action: "waited", reason: "backing-off" }]);

    h.setNow(at(20, 5));
    h.setRun(failRun("device-locked", at(20, 5)));
    expect(await h.daemon.tick()).toMatchObject([{ action: "backed-up" }]);

    // Two unanswered prompts today: no third, even after the back-off ends.
    h.setNow(at(21, 30));
    expect(await h.daemon.tick()).toMatchObject([
      { action: "waited", reason: "prompt-budget-spent" },
    ]);
    expect(h.ran).toEqual(["mike", "mike"]);
  });

  it("handles devices one at a time, and one device's fault does not skip the next", async () => {
    const second = deviceConfig({
      id: "sam",
      name: "Sam's iPhone",
      udid: "00008150-000F0E0D0C0B002E",
      host: "10.0.0.8",
    });
    const h = harness([deviceConfig(), second]);
    h.setRun((device) =>
      device.id === "mike"
        ? Promise.reject(new Error("disk on fire"))
        : Promise.resolve({ runId: 1, outcome: "succeeded", durationMs: 1, snapshotPath: undefined }),
    );
    // Each device is probed with its own identity.
    h.transport.probe = (target) => {
      h.transport.probes.push(target);
      return Promise.resolve(fakeStatus({ udid: target.udid }));
    };

    const outcomes = await h.daemon.tick();

    expect(h.ran).toEqual(["mike", "sam"]);
    expect(outcomes).toMatchObject([
      { deviceId: "mike", action: "waited", reason: "error" },
      { deviceId: "sam", action: "backed-up" },
    ]);
    expect(h.logs.some((l) => l.level === "error" && l.message.includes("unexpected"))).toBe(true);
  });

  it("logs a waiting reason once, not on every poll", async () => {
    const h = harness();
    h.setNow(at(3));
    await h.daemon.tick();
    await h.daemon.tick();
    await h.daemon.tick();
    expect(h.logs.filter((l) => l.message === "waiting")).toHaveLength(1);

    h.setNow(at(19));
    h.transport.probeResult = new DeviceError("no answer", "unreachable");
    await h.daemon.tick();
    expect(h.logs.filter((l) => l.message === "waiting")).toHaveLength(2);
  });
});

describe("Daemon stale alerts", () => {
  it("alerts once a day while the last good backup is too old", async () => {
    const h = harness();
    const runId = state.startRun("mike", at(19, 0, -4));
    state.finishRun(runId, at(19, 6, -4), {
      outcome: "succeeded",
      durationMs: 1,
      snapshotPath: undefined,
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
    h.setNow(at(3));
    await h.daemon.tick();
    expect(h.sent).toEqual([]);
  });
});

describe("Daemon.run", () => {
  it("closes off interrupted runs, polls at the configured interval, and stops on abort", async () => {
    const h = harness();
    const orphan = state.startRun("mike", at(18, 0, -1));
    const controller = new AbortController();
    h.setNow(at(3));
    let ticks = 0;
    const originalTick = h.daemon.tick.bind(h.daemon);
    h.daemon.tick = async (signal) => {
      ticks += 1;
      if (ticks === 3) controller.abort();
      return originalTick(signal);
    };

    await h.daemon.run(controller.signal);

    expect(state.getRun(orphan)).toMatchObject({
      outcome: "failed",
      failureReason: "interrupted",
    });
    expect(ticks).toBe(3);
    expect(h.sleeps).toEqual([120_000, 120_000, 120_000]);
    expect(h.logs.at(-1)?.message).toBe("nightstand stopped");
  });
});
