import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type DevicePolicy } from "../config/config.js";
import {
  deviceReady,
  inWindow,
  isStale,
  shouldAttempt,
  type AttemptSummary,
} from "./policy.js";

/** Local time on a fixed day, so windows behave the same in any timezone. */
function at(hours: number, minutes = 0, dayOffset = 0): Date {
  return new Date(2026, 10, 24 + dayOffset, hours, minutes, 0, 0);
}

const policy: DevicePolicy = {
  ...DEFAULT_POLICY,
  minIntervalHours: 20,
  window: { startMinutes: 18 * 60, endMinutes: 22 * 60 },
  maxUnansweredPromptsPerDay: 2,
  retryAfterMinutes: 60,
};

function failed(startedAt: Date, failureReason: string, minutesLong = 1): AttemptSummary {
  return {
    startedAt,
    finishedAt: new Date(startedAt.getTime() + minutesLong * 60_000),
    outcome: "failed",
    failureReason,
  };
}

describe("shouldAttempt", () => {
  it("attempts a first backup inside the window", () => {
    expect(
      shouldAttempt({ now: at(19), policy, lastSuccessAt: undefined, recentAttempts: [] }),
    ).toEqual({ attempt: true });
  });

  it("waits until the last good backup is old enough, and says when", () => {
    const decision = shouldAttempt({
      now: at(19),
      policy,
      lastSuccessAt: at(18, 30),
      recentAttempts: [],
    });
    expect(decision).toEqual({
      attempt: false,
      reason: "not-due",
      until: at(14, 30, 1),
    });
  });

  it("attempts again once the interval has passed", () => {
    expect(
      shouldAttempt({
        now: at(19),
        policy,
        lastSuccessAt: at(21, 0, -1),
        recentAttempts: [],
      }),
    ).toEqual({ attempt: true });
  });

  it("never starts outside the window, and reports when it next opens", () => {
    expect(
      shouldAttempt({ now: at(3), policy, lastSuccessAt: undefined, recentAttempts: [] }),
    ).toEqual({ attempt: false, reason: "outside-window", until: at(18) });
    expect(
      shouldAttempt({ now: at(22), policy, lastSuccessAt: undefined, recentAttempts: [] }),
    ).toEqual({ attempt: false, reason: "outside-window", until: at(18, 0, 1) });
  });

  it("has no window restriction when the policy has none", () => {
    expect(
      shouldAttempt({
        now: at(3),
        policy: { ...policy, window: null },
        lastSuccessAt: undefined,
        recentAttempts: [],
      }),
    ).toEqual({ attempt: true });
  });

  it("backs off after a failure, then retries", () => {
    const recentAttempts = [failed(at(18, 30), "unreachable")];
    expect(
      shouldAttempt({ now: at(19), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual({ attempt: false, reason: "backing-off", until: at(19, 31) });
    expect(
      shouldAttempt({ now: at(19, 31), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual({ attempt: true });
  });

  it("stops prompting once the daily budget of unanswered prompts is spent", () => {
    const recentAttempts = [
      failed(at(18, 5), "device-locked"),
      failed(at(19, 10), "device-locked"),
    ];
    expect(
      shouldAttempt({ now: at(21), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual({
      attempt: false,
      reason: "prompt-budget-spent",
      until: at(18, 5, 1),
    });
  });

  it("frees the prompt budget as old prompts age past 24 hours", () => {
    const recentAttempts = [
      failed(at(18, 5, -1), "device-locked"),
      failed(at(19, 10, -1), "device-locked"),
    ];
    // 18:06 the next day: the 18:05 prompt has aged out, leaving one counted.
    expect(
      shouldAttempt({ now: at(18, 6), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual({ attempt: true });
  });

  it("does not count failures that never prompted against the prompt budget", () => {
    const recentAttempts = [
      failed(at(18, 0), "unreachable"),
      failed(at(18, 10), "unreachable"),
      failed(at(18, 20), "failed"),
    ];
    expect(
      shouldAttempt({ now: at(20), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual({ attempt: true });
  });

  it("will not start a second attempt while one is running", () => {
    const running: AttemptSummary = {
      startedAt: at(18, 59),
      finishedAt: undefined,
      outcome: "running",
      failureReason: undefined,
    };
    expect(
      shouldAttempt({
        now: at(19),
        policy,
        lastSuccessAt: undefined,
        recentAttempts: [running],
      }),
    ).toEqual({ attempt: false, reason: "already-running" });
  });
});

describe("inWindow", () => {
  it("includes the start and excludes the end", () => {
    const window = { startMinutes: 18 * 60, endMinutes: 22 * 60 };
    expect(inWindow(window, at(17, 59))).toBe(false);
    expect(inWindow(window, at(18, 0))).toBe(true);
    expect(inWindow(window, at(21, 59))).toBe(true);
    expect(inWindow(window, at(22, 0))).toBe(false);
  });

  it("handles a window that wraps midnight", () => {
    const window = { startMinutes: 21 * 60, endMinutes: 60 };
    expect(inWindow(window, at(20, 59))).toBe(false);
    expect(inWindow(window, at(23, 30))).toBe(true);
    expect(inWindow(window, at(0, 30))).toBe(true);
    expect(inWindow(window, at(1, 0))).toBe(false);
  });
});

describe("deviceReady", () => {
  const battery = (levelPercent: number, externalPowerConnected: boolean) => ({
    battery: {
      levelPercent,
      externalPowerConnected,
      isCharging: externalPowerConnected,
      fullyCharged: false,
    },
  });

  it("is ready on a charger whatever the level", () => {
    expect(deviceReady(policy, battery(3, true))).toEqual({ ready: true });
  });

  it("waits for a charger when the policy requires one", () => {
    expect(deviceReady({ ...policy, requireExternalPower: true }, battery(90, false))).toEqual({
      ready: false,
      reason: "on-battery",
    });
  });

  it("allows battery above the floor when a charger is not required", () => {
    const relaxed = { ...policy, requireExternalPower: false, minBatteryPercent: 50 };
    expect(deviceReady(relaxed, battery(50, false))).toEqual({ ready: true });
    expect(deviceReady(relaxed, battery(49, false))).toEqual({
      ready: false,
      reason: "battery-low",
    });
  });
});

describe("isStale", () => {
  it("is stale only once the last good backup passes the threshold", () => {
    const threeDays = { ...policy, staleAfterHours: 72 };
    expect(isStale(threeDays, at(12, 0, -3), at(11, 59))).toBe(false);
    expect(isStale(threeDays, at(12, 0, -3), at(12, 1))).toBe(true);
  });

  it("does not call a device that has never backed up stale", () => {
    expect(isStale(policy, undefined, at(12))).toBe(false);
  });
});
