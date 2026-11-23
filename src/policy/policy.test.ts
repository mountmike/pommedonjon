import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type DevicePolicy } from "../config/config.js";
import {
  inWindow,
  isStale,
  readyToStart,
  schedule,
  type AttemptSummary,
} from "./policy.js";
import type { PowerState } from "./power.js";

/** Local time on a fixed day, so windows behave the same in any timezone. */
function at(hours: number, minutes = 0, dayOffset = 0): Date {
  return new Date(2026, 10, 24 + dayOffset, hours, minutes, 0, 0);
}

const policy: DevicePolicy = {
  ...DEFAULT_POLICY,
  dueAfterHours: 20,
  window: null,
  retryAfterTimeoutMinutes: 10,
  retryAfterFailureMinutes: 30,
};

function failed(startedAt: Date, failureReason: string, minutesLong = 1): AttemptSummary {
  return {
    startedAt,
    finishedAt: new Date(startedAt.getTime() + minutesLong * 60_000),
    outcome: "failed",
    failureReason,
  };
}

const GO = { observe: true, start: { allowed: true } };

describe("schedule", () => {
  it("allows a first backup straight away", () => {
    expect(
      schedule({ now: at(19), policy, lastSuccessAt: undefined, recentAttempts: [] }),
    ).toEqual(GO);
  });

  it("leaves the phone alone while the last good backup is recent, and says when it is due", () => {
    expect(
      schedule({ now: at(19), policy, lastSuccessAt: at(18, 30), recentAttempts: [] }),
    ).toEqual({
      observe: false,
      start: { allowed: false, reason: "not-due", until: at(14, 30, 1) },
    });
  });

  it("starts watching the phone half an hour before a backup is due", () => {
    const lastSuccessAt = at(21, 0, -1); // due at 17:00 today
    const before = schedule({ now: at(16, 29), policy, lastSuccessAt, recentAttempts: [] });
    const watching = schedule({ now: at(16, 30), policy, lastSuccessAt, recentAttempts: [] });

    expect(before.observe).toBe(false);
    expect(watching).toEqual({
      observe: true,
      start: { allowed: false, reason: "not-due", until: at(17) },
    });
  });

  it("is due after 20 hours, so plugging in a little earlier than yesterday still counts", () => {
    const lastSuccessAt = at(22, 0, -1);
    expect(schedule({ now: at(21, 50), policy, lastSuccessAt, recentAttempts: [] })).toEqual(GO);
  });

  it("has no hours restriction by default", () => {
    expect(DEFAULT_POLICY.window).toBeNull();
    expect(
      schedule({ now: at(3), policy, lastSuccessAt: undefined, recentAttempts: [] }),
    ).toEqual(GO);
  });

  it("with a window set, keeps watching outside it but will not start, and says when it opens", () => {
    const windowed = { ...policy, window: { startMinutes: 18 * 60, endMinutes: 22 * 60 } };
    expect(
      schedule({ now: at(3), policy: windowed, lastSuccessAt: undefined, recentAttempts: [] }),
    ).toEqual({
      observe: true,
      start: { allowed: false, reason: "outside-window", until: at(18) },
    });
    expect(
      schedule({ now: at(22), policy: windowed, lastSuccessAt: undefined, recentAttempts: [] }),
    ).toEqual({
      observe: true,
      start: { allowed: false, reason: "outside-window", until: at(18, 0, 1) },
    });
    expect(
      schedule({ now: at(19), policy: windowed, lastSuccessAt: undefined, recentAttempts: [] }),
    ).toEqual(GO);
  });

  it("asks again soon after an unanswered prompt", () => {
    const recentAttempts = [failed(at(19), "device-locked")];
    expect(
      schedule({ now: at(19, 5), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual({
      observe: true,
      start: { allowed: false, reason: "backing-off", until: at(19, 11) },
    });
    expect(
      schedule({ now: at(19, 11), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual(GO);
  });

  it("sets no limit on how many prompts may go unanswered", () => {
    const recentAttempts = [
      failed(at(18, 0), "device-locked"),
      failed(at(18, 15), "device-locked"),
      failed(at(18, 30), "device-locked"),
      failed(at(18, 45), "device-locked"),
    ];
    expect(schedule({ now: at(19), policy, lastSuccessAt: undefined, recentAttempts })).toEqual(
      GO,
    );
  });

  it("waits the longer, separate pause after any other failure", () => {
    const recentAttempts = [failed(at(19), "unreachable")];
    expect(
      schedule({ now: at(19, 20), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual({
      observe: true,
      start: { allowed: false, reason: "backing-off", until: at(19, 31) },
    });
  });

  it("paces itself by the most recent failure, not an earlier one", () => {
    const recentAttempts = [
      failed(at(19, 10), "device-locked"),
      failed(at(18), "unreachable"),
    ];
    expect(
      schedule({ now: at(19, 15), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toMatchObject({ start: { reason: "backing-off", until: at(19, 21) } });
  });

  it("will not look at or start on a phone that is already being backed up", () => {
    const running: AttemptSummary = {
      startedAt: at(18, 59),
      finishedAt: undefined,
      outcome: "running",
      failureReason: undefined,
    };
    expect(
      schedule({ now: at(19), policy, lastSuccessAt: undefined, recentAttempts: [running] }),
    ).toEqual({ observe: false, start: { allowed: false, reason: "already-running" } });
  });
});

describe("readyToStart", () => {
  const pluggedIn = (since: Date): PowerState => ({ kind: "on-power", since, pluggedIn: true });
  const alreadyCharging = (since: Date): PowerState => ({
    kind: "on-power",
    since,
    pluggedIn: false,
  });

  it("never starts on battery, whichever trigger is set", () => {
    for (const trigger of ["plugged-in", "on-charger"] as const) {
      expect(readyToStart({ ...policy, trigger }, { kind: "on-battery" }, at(19))).toEqual({
        ready: false,
        reason: "on-battery",
      });
    }
  });

  describe('trigger "plugged-in"', () => {
    const plugged = { ...policy, trigger: "plugged-in" as const, pluggedInWindowMinutes: 30 };

    it("starts in the minutes after the phone goes onto power", () => {
      expect(readyToStart(plugged, pluggedIn(at(19)), at(19, 0))).toEqual({ ready: true });
      expect(readyToStart(plugged, pluggedIn(at(19)), at(19, 30))).toEqual({ ready: true });
    });

    it("does not start once the phone has been on power longer than the window", () => {
      expect(readyToStart(plugged, pluggedIn(at(19)), at(19, 31))).toEqual({
        ready: false,
        reason: "plug-in-window-passed",
      });
      // So a phone left charging overnight is not prompted at 3 a.m. when its
      // backup falls due.
      expect(readyToStart(plugged, pluggedIn(at(22, 0, -1)), at(3))).toEqual({
        ready: false,
        reason: "plug-in-window-passed",
      });
    });

    it("does not start on a phone that was already charging when first seen", () => {
      expect(readyToStart(plugged, alreadyCharging(at(19)), at(19))).toEqual({
        ready: false,
        reason: "waiting-for-plug-in",
      });
    });
  });

  describe('trigger "on-charger"', () => {
    const charger = { ...policy, trigger: "on-charger" as const };

    it("starts whenever the phone is on power, however long it has been", () => {
      expect(readyToStart(charger, pluggedIn(at(22, 0, -1)), at(3))).toEqual({ ready: true });
      expect(readyToStart(charger, alreadyCharging(at(19)), at(19))).toEqual({ ready: true });
    });
  });

  it("does not start when the phone's state is unknown or it is not answering", () => {
    expect(readyToStart(policy, { kind: "unknown" }, at(19)).ready).toBe(false);
    expect(
      readyToStart(
        policy,
        { kind: "unreachable", since: at(19), before: { kind: "on-battery" } },
        at(19),
      ).ready,
    ).toBe(false);
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
