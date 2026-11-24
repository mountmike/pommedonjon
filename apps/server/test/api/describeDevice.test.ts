import { DeviceDetailSchema, DeviceSummarySchema } from "@pommedonjon/api-contract";
import { describe, expect, it } from "vitest";
import {
  describeDevice,
  describeDeviceDetail,
  describeRun,
  type DeviceFacts,
} from "../../src/api/describeDevice.js";
import { DEFAULT_POLICY } from "../../src/config/config.js";
import type { RunEvent, RunRecord } from "../../src/state/StateStore.js";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-11-24T10:00:00.000Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 1,
    deviceId: "mike",
    startedAt: ago(2.1),
    finishedAt: ago(2),
    outcome: "succeeded",
    failureReason: undefined,
    message: undefined,
    prompted: true,
    durationMs: 282_000,
    ...overrides,
  };
}

function facts(overrides: Partial<DeviceFacts> = {}): DeviceFacts {
  return {
    device: { id: "mike", name: "Mike's iPhone", policy: DEFAULT_POLICY },
    now: NOW,
    lastSuccessAt: ago(2),
    recentRuns: [run()],
    runningEvents: [],
    waiting: { reason: "not-due", until: new Date(ago(2).getTime() + 20 * HOUR) },
    ...overrides,
  };
}

const event = (type: string, secondsIn: number, detail: Record<string, unknown> = {}): RunEvent => ({
  at: new Date(NOW.getTime() + secondsIn * 1000),
  type,
  detail,
});

describe("describeDevice", () => {
  it("says a phone backed up two hours ago is backed up, and when it will next be wanted", () => {
    const summary = describeDevice(facts());
    expect(summary).toEqual({
      id: "mike",
      name: "Mike's iPhone",
      state: "backed-up",
      lastBackupAt: ago(2).toISOString(),
      dueAt: new Date(ago(2).getTime() + 20 * HOUR).toISOString(),
      waiting: { reason: "not-due", until: new Date(ago(2).getTime() + 20 * HOUR).toISOString() },
      run: null,
      problem: null,
      lastAttempt: {
        startedAt: ago(2.1).toISOString(),
        finishedAt: ago(2).toISOString(),
        outcome: "succeeded",
        reason: null,
        prompted: true,
        durationMs: 282_000,
      },
    });
  });

  it.each([
    ["backed-up", 19.9, "not-due"],
    ["due", 20.1, "waiting-for-plug-in"],
    ["due", 30, "on-battery"],
    ["away", 30, "unreachable"],
    ["overdue", 72.1, "on-battery"],
    // Gone too long is the thing to say, even when the phone is simply out.
    ["overdue", 100, "unreachable"],
  ])("is %s when the last good backup was %f hours ago and it is %s", (state, hours, reason) => {
    const summary = describeDevice(facts({ lastSuccessAt: ago(hours), waiting: { reason } }));
    expect(summary.state).toBe(state);
  });

  it("is not called away just because the phone is out, while nothing is wanted", () => {
    const summary = describeDevice(facts({ waiting: { reason: "unreachable" } }));
    expect(summary.state).toBe("backed-up");
  });

  it("has never been backed up until a backup succeeds", () => {
    const summary = describeDevice(
      facts({
        lastSuccessAt: undefined,
        recentRuns: [run({ outcome: "failed", failureReason: "device-locked" })],
        waiting: { reason: "backing-off" },
      }),
    );
    expect(summary).toMatchObject({ state: "never", lastBackupAt: null, dueAt: null });
  });

  it.each([["encryption-off"], ["not-paired"]] as const)(
    "needs its owner when the reason is %s, however recent the last backup",
    (reason) => {
      const summary = describeDevice(facts({ waiting: { reason } }));
      expect(summary).toMatchObject({ state: "needs-you", problem: reason });
    },
  );

  it("is backing up while a run is in progress, whatever else is true", () => {
    const summary = describeDevice(
      facts({
        lastSuccessAt: ago(100),
        recentRuns: [run({ id: 2, outcome: "running", startedAt: NOW, finishedAt: undefined }), run()],
        waiting: { reason: "encryption-off" },
      }),
    );
    expect(summary).toMatchObject({
      state: "backing-up",
      waiting: null,
      problem: null,
      run: { stage: "connecting", startedAt: NOW.toISOString() },
    });
  });

  it("says nothing about waiting before the daemon has looked at the phone", () => {
    expect(describeDevice(facts({ waiting: undefined })).waiting).toBeNull();
  });

  it("leaves out a time it does not have", () => {
    expect(describeDevice(facts({ waiting: { reason: "on-battery" } })).waiting).toEqual({
      reason: "on-battery",
    });
  });

  it("carries how the last backup that ended went, so a failure can be explained", () => {
    const cancelled = run({
      id: 2,
      startedAt: ago(1),
      finishedAt: ago(0.99),
      outcome: "failed",
      failureReason: "passcode-cancelled",
      durationMs: undefined,
    });
    expect(describeDevice(facts({ recentRuns: [cancelled, run()] })).lastAttempt).toMatchObject({
      outcome: "failed",
      reason: "passcode-cancelled",
      finishedAt: ago(0.99).toISOString(),
    });
  });

  it("looks past the run in progress for the last one that ended", () => {
    const running = run({ id: 3, startedAt: ago(0.01), finishedAt: undefined, outcome: "running" });
    expect(describeDevice(facts({ recentRuns: [running, run()] })).lastAttempt).toMatchObject({
      outcome: "succeeded",
    });
  });

  it("has no last attempt before any backup has ended", () => {
    expect(describeDevice(facts({ lastSuccessAt: undefined, recentRuns: [] })).lastAttempt).toBeNull();
  });

  it("is backing up, at its first step, from the moment a backup is asked for", () => {
    const asked = new Date(NOW.getTime() - 3000);
    const summary = describeDevice(facts({ request: { at: asked, status: "connecting" } }));
    expect(summary).toMatchObject({
      state: "backing-up",
      waiting: null,
      run: { stage: "connecting", startedAt: asked.toISOString() },
    });
  });

  it("lets a real run speak over a request still marked as connecting", () => {
    const running = run({ id: 3, startedAt: ago(0.01), finishedAt: undefined, outcome: "running" });
    const summary = describeDevice(
      facts({
        recentRuns: [running, run()],
        runningEvents: [event("passcode-required", -20)],
        request: { at: ago(0.02), status: "connecting" },
      }),
    );
    expect(summary.run?.stage).toBe("passcode");
  });

  it("counts a backup that was asked for and never started as the last try", () => {
    const asked = ago(0.1);
    const summary = describeDevice(
      facts({ request: { at: asked, status: "not-started", reason: "unreachable" } }),
    );
    expect(summary.state).toBe("backed-up");
    expect(summary.lastAttempt).toEqual({
      startedAt: asked.toISOString(),
      finishedAt: asked.toISOString(),
      outcome: "failed",
      reason: "unreachable",
      prompted: false,
      durationMs: null,
    });
  });

  it("forgets a request that never started once a run has ended since", () => {
    const summary = describeDevice(
      facts({ request: { at: ago(5), status: "not-started", reason: "unreachable" } }),
    );
    expect(summary.lastAttempt).toMatchObject({ outcome: "succeeded" });
  });

  it("always produces a summary the contract accepts", () => {
    for (const waiting of [undefined, { reason: "on-battery" }, { reason: "not-paired" }]) {
      for (const lastSuccessAt of [undefined, ago(1), ago(30), ago(200)]) {
        expect(() =>
          DeviceSummarySchema.parse(describeDevice(facts({ waiting, lastSuccessAt }))),
        ).not.toThrow();
      }
    }
  });
});

describe("describeRun", () => {
  const running = run({ outcome: "running", startedAt: NOW, finishedAt: undefined });

  it.each([
    ["connecting", [], {}],
    ["connecting", [event("started", 1)], {}],
    [
      "passcode",
      [event("started", 1), event("passcode-required", 9)],
      { passcodeSince: new Date(NOW.getTime() + 9000).toISOString() },
    ],
    [
      "transferring",
      [event("passcode-required", 9), event("passcode-dismissed", 12)],
      {},
    ],
    [
      "transferring",
      [event("passcode-required", 9), event("passcode-dismissed", 12), event("progress", 60, { percent: 42 })],
      { percent: 42 },
    ],
    [
      "checking",
      [event("passcode-dismissed", 12), event("progress", 200, { percent: 100 })],
      { percent: 100 },
    ],
  ] as const)("is %s after %j", (stage, events, extra) => {
    expect(describeRun(running, events)).toEqual({
      stage,
      startedAt: NOW.toISOString(),
      ...extra,
    });
  });

  it("uses the latest progress, and keeps it inside 0 to 100", () => {
    const events = [event("progress", 20, { percent: 10 }), event("progress", 40, { percent: 180 })];
    expect(describeRun(running, events).percent).toBe(100);
  });

  it("ignores events it does not know", () => {
    const events = [event("log", 3, { message: "hello" }), event("progress", 4, { percent: "half" })];
    expect(describeRun(running, events).stage).toBe("connecting");
  });
});

describe("describeDeviceDetail", () => {
  it("adds the recent runs, most recent first, in the contract's shape", () => {
    const failed = run({
      id: 2,
      startedAt: ago(1),
      finishedAt: ago(0.99),
      outcome: "failed",
      failureReason: "passcode-cancelled",
      durationMs: undefined,
    });
    const detail = describeDeviceDetail(facts({ recentRuns: [failed, run()] }));
    expect(detail.recentRuns).toEqual([
      {
        startedAt: ago(1).toISOString(),
        finishedAt: ago(0.99).toISOString(),
        outcome: "failed",
        reason: "passcode-cancelled",
        prompted: true,
        durationMs: null,
      },
      {
        startedAt: ago(2.1).toISOString(),
        finishedAt: ago(2).toISOString(),
        outcome: "succeeded",
        reason: null,
        prompted: true,
        durationMs: 282_000,
      },
    ]);
    expect(() => DeviceDetailSchema.parse(detail)).not.toThrow();
  });
});
