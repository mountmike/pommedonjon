import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type DevicePolicy } from "../../src/config/config.js";
import { INITIAL_LOCK_STATE, observeLock, type LockState } from "../../src/policy/lock.js";
import {
  inWindow,
  isStale,
  lastUnansweredAt,
  momentsInPlay,
  readyToStart,
  schedule,
  wantedForMs,
  type AttemptSummary,
} from "../../src/policy/policy.js";
import type { PowerState } from "../../src/policy/power.js";

/** Local time on a fixed day, so windows behave the same in any timezone. */
function at(hours: number, minutes = 0, dayOffset = 0): Date {
  return new Date(2026, 10, 24 + dayOffset, hours, minutes, 0, 0);
}

const policy: DevicePolicy = {
  ...DEFAULT_POLICY,
  dueAfterHours: 20,
  window: null,
  retryAfterTimeoutMinutes: 10,
  retryAfterCancelMinutes: 240,
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

  it("stops for the day after three prompts went unanswered, until the oldest is a day old", () => {
    const recentAttempts = [
      failed(at(9, 0), "device-locked"),
      failed(at(13, 0), "device-locked"),
      failed(at(18, 0), "device-locked"),
    ];
    expect(schedule({ now: at(19), policy, lastSuccessAt: undefined, recentAttempts })).toEqual({
      observe: true,
      start: { allowed: false, reason: "backing-off", until: at(9, 1, 1) },
    });
    // Two is not three.
    expect(
      schedule({
        now: at(19),
        policy,
        lastSuccessAt: undefined,
        recentAttempts: recentAttempts.slice(1),
      }),
    ).toEqual(GO);
  });

  it("does not count prompts that were answered or dismissed towards that limit", () => {
    const recentAttempts = [
      failed(at(9, 0), "device-locked"),
      failed(at(10, 0), "passcode-cancelled"),
      failed(at(18, 0), "device-locked"),
    ];
    expect(schedule({ now: at(19), policy, lastSuccessAt: undefined, recentAttempts })).toEqual(
      GO,
    );
  });

  it("starts nothing, and does not even look, when backups are only on request", () => {
    expect(
      schedule({
        now: at(19),
        policy: { ...policy, automatic: false },
        lastSuccessAt: at(19, 0, -3),
        recentAttempts: [],
      }),
    ).toEqual({ observe: false, start: { allowed: false, reason: "manual-only" } });
  });

  it("leaves the phone alone for hours after its owner dismissed the prompt", () => {
    const recentAttempts = [failed(at(19), "passcode-cancelled")];
    expect(
      schedule({ now: at(19, 11), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual({
      observe: true,
      start: { allowed: false, reason: "backing-off", until: at(23, 1) },
    });
    expect(
      schedule({ now: at(23, 1), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual(GO);
  });

  it("leaves the phone alone as long after its owner stopped a backup from the app", () => {
    const recentAttempts = [failed(at(19), "stopped")];
    expect(
      schedule({ now: at(22, 59), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toMatchObject({ start: { allowed: false, reason: "backing-off", until: at(23, 1) } });
  });

  it("goes back to asking soon if a later prompt merely timed out", () => {
    const recentAttempts = [
      failed(at(14), "passcode-cancelled"),
      failed(at(19), "device-locked"),
    ];
    expect(
      schedule({ now: at(19, 11), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual(GO);
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

  it("keeps a Cancel's pause when something else fails during it", () => {
    // Cancelled at noon: left alone until 16:01. An hour in, a backup that
    // was asked for went unanswered, which by itself is a ten-minute pause.
    const recentAttempts = [
      failed(at(12), "passcode-cancelled"),
      failed(at(13), "device-locked"),
    ];
    expect(
      schedule({ now: at(13, 15), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual({
      observe: true,
      start: { allowed: false, reason: "backing-off", until: at(16, 1) },
    });
    expect(
      schedule({ now: at(16, 1), policy, lastSuccessAt: undefined, recentAttempts }),
    ).toEqual(GO);
  });

  it("takes a limit on unanswered prompts that is not a whole number as the one below", () => {
    const recentAttempts = [failed(at(9), "device-locked"), failed(at(13), "device-locked")];
    const fussy = { ...policy, maxUnansweredPerDay: 2.5 };
    expect(
      schedule({ now: at(19), policy: fussy, lastSuccessAt: undefined, recentAttempts }),
    ).toMatchObject({ start: { allowed: false, reason: "backing-off" } });
  });

  it("paces itself by whichever pause ends last, not by an earlier one that has run out", () => {
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

describe("observeLock", () => {
  const unlockedAt = (since: Date): LockState => ({ kind: "unlocked", since });

  it("counts a run of unlocked readings as one stretch, from the first", () => {
    const first = observeLock(INITIAL_LOCK_STATE, "unlocked", at(19));
    expect(first).toEqual(unlockedAt(at(19)));
    expect(observeLock(first, "unlocked", at(19, 2))).toEqual(unlockedAt(at(19)));
  });

  it("starts a new stretch once the phone has been seen locked", () => {
    const locked = observeLock(unlockedAt(at(19)), "locked", at(19, 4));
    expect(locked).toEqual({ kind: "locked" });
    expect(observeLock(locked, "unlocked", at(19, 6))).toEqual(unlockedAt(at(19, 6)));
  });

  it("does not make a new stretch of one missed reading", () => {
    const missed = observeLock(unlockedAt(at(19)), "unknown", at(19, 2));
    expect(missed.kind).toBe("unknown");
    expect(observeLock(missed, "unlocked", at(19, 4))).toEqual(unlockedAt(at(19)));
  });

  it("keeps counting the gap from the first missed reading, not the latest", () => {
    let state = observeLock(unlockedAt(at(19)), "unknown", at(19, 2));
    state = observeLock(state, "unknown", at(19, 10));
    state = observeLock(state, "unknown", at(19, 16));
    // Fourteen minutes of silence is a gap; sixteen is the phone put down.
    expect(observeLock(state, "unlocked", at(19, 16))).toEqual(unlockedAt(at(19)));
    expect(observeLock(state, "unlocked", at(19, 18))).toEqual(unlockedAt(at(19, 18)));
  });

  it("does not resume a stretch across a reading of locked", () => {
    let state = observeLock(unlockedAt(at(19)), "unknown", at(19, 2));
    state = observeLock(state, "locked", at(19, 4));
    state = observeLock(state, "unknown", at(19, 6));
    expect(observeLock(state, "unlocked", at(19, 8))).toEqual(unlockedAt(at(19, 8)));
  });
});

describe("wantedForMs", () => {
  const HOUR = 60 * 60 * 1000;

  it("is zero until the last good backup is older than how often", () => {
    expect(wantedForMs(policy, at(19, 0, -1), at(14))).toBe(0);
    expect(wantedForMs(policy, at(19, 0, -1), at(15))).toBe(0);
  });

  it("then counts from the moment the backup became wanted", () => {
    // Backed up at 19:00 yesterday, so wanted from 15:00 today.
    expect(wantedForMs(policy, at(19, 0, -1), at(19))).toBe(4 * HOUR);
  });

  it("is zero for a phone that has never been backed up: there is nothing to count from", () => {
    expect(wantedForMs(policy, undefined, at(19))).toBe(0);
  });
});

describe("lastUnansweredAt", () => {
  it("is when the most recent prompt went unanswered", () => {
    const attempts = [
      failed(at(9), "device-locked"),
      failed(at(13), "device-locked"),
      failed(at(18), "passcode-cancelled"),
    ];
    expect(lastUnansweredAt(attempts)).toEqual(at(13, 1));
  });

  it("is nothing when none did", () => {
    expect(lastUnansweredAt([failed(at(18), "passcode-cancelled")])).toBeUndefined();
    expect(lastUnansweredAt([])).toBeUndefined();
  });
});

describe("momentsInPlay", () => {
  const HOUR = 60 * 60 * 1000;

  it("gets less choosy the longer a backup has been wanted", () => {
    expect(momentsInPlay(policy, 0)).toEqual(["plugged-in"]);
    expect(momentsInPlay(policy, 4 * HOUR - 1)).toEqual(["plugged-in"]);
    expect(momentsInPlay(policy, 4 * HOUR)).toEqual(["plugged-in", "unlocked"]);
    expect(momentsInPlay(policy, 24 * HOUR)).toEqual(["plugged-in", "unlocked", "on-charger"]);
  });

  it("leaves out a moment that is switched off, however long the wait", () => {
    const fussy = {
      ...policy,
      startWhenPluggedIn: false,
      startWhenUnlockedAfterHours: null,
      startOnChargerAfterHours: 0,
    };
    expect(momentsInPlay(fussy, 0)).toEqual(["on-charger"]);
    expect(momentsInPlay({ ...fussy, startOnChargerAfterHours: null }, 99 * HOUR)).toEqual([]);
  });
});

describe("readyToStart", () => {
  const HOUR = 60 * 60 * 1000;
  const pluggedIn = (since: Date): PowerState => ({ kind: "on-power", since, pluggedIn: true });
  const alreadyCharging = (since: Date): PowerState => ({
    kind: "on-power",
    since,
    pluggedIn: false,
  });
  const LOCKED: LockState = { kind: "locked" };
  const unlocked = (since: Date): LockState => ({ kind: "unlocked", since });

  /** Ask with everything quiet unless a test says otherwise. */
  const ask = (input: Partial<Parameters<typeof readyToStart>[0]> & { now: Date }) =>
    readyToStart({
      policy,
      power: { kind: "on-battery" },
      lock: LOCKED,
      wantedMs: 0,
      lastUnansweredAt: undefined,
      ...input,
    });

  describe("a backup that has only just become wanted", () => {
    it("starts in the minutes after the phone goes onto power", () => {
      const go = { ready: true, moment: "plugged-in" };
      expect(ask({ power: pluggedIn(at(19)), now: at(19, 0) })).toEqual(go);
      expect(ask({ power: pluggedIn(at(19)), now: at(19, 30) })).toEqual(go);
    });

    it("does not start once the phone has been on power longer than the window", () => {
      const passed = { ready: false, reason: "plug-in-window-passed", moments: ["plugged-in"] };
      expect(ask({ power: pluggedIn(at(19)), now: at(19, 31) })).toEqual(passed);
      // So a phone left charging overnight is not prompted at 3 a.m. when its
      // backup falls due.
      expect(ask({ power: pluggedIn(at(22, 0, -1)), now: at(3) })).toEqual(passed);
    });

    it("does not start on a phone that was already charging when first seen", () => {
      expect(ask({ power: alreadyCharging(at(19)), now: at(19) })).toEqual({
        ready: false,
        reason: "waiting-for-plug-in",
        moments: ["plugged-in"],
      });
    });

    it("does not start on battery, even with the phone unlocked in its owner's hand", () => {
      expect(ask({ lock: unlocked(at(19)), now: at(19) })).toEqual({
        ready: false,
        reason: "on-battery",
        moments: ["plugged-in"],
      });
    });

    it("does not start when the phone's power is unknown or it is not answering", () => {
      expect(ask({ power: { kind: "unknown" }, now: at(19) }).ready).toBe(false);
      expect(
        ask({
          power: { kind: "unreachable", since: at(19), before: { kind: "on-battery" } },
          now: at(19),
        }).ready,
      ).toBe(false);
    });
  });

  describe("a backup that has been wanted for four hours", () => {
    const waited = { wantedMs: 4 * HOUR };

    it("also starts when the phone is found unlocked, on battery or not", () => {
      expect(ask({ ...waited, lock: unlocked(at(19)), now: at(19) })).toEqual({
        ready: true,
        moment: "unlocked",
      });
    });

    it("does not start while the phone is locked, or will not say", () => {
      const waiting = {
        ready: false,
        reason: "on-battery",
        moments: ["plugged-in", "unlocked"],
      };
      expect(ask({ ...waited, now: at(19) })).toEqual(waiting);
      expect(ask({ ...waited, lock: { kind: "unknown" }, now: at(19) })).toEqual(waiting);
    });

    it("still does not start just because the phone sits on a charger", () => {
      expect(ask({ ...waited, power: alreadyCharging(at(12)), now: at(19) }).ready).toBe(false);
    });
  });

  describe("a backup that has been wanted for a day", () => {
    const waited = { wantedMs: 24 * HOUR };

    it("also starts any time the phone is on a charger, however long it has been there", () => {
      const go = { ready: true, moment: "on-charger" };
      expect(ask({ ...waited, power: pluggedIn(at(22, 0, -1)), now: at(3) })).toEqual(go);
      expect(ask({ ...waited, power: alreadyCharging(at(19)), now: at(19) })).toEqual(go);
    });
  });

  describe("after a prompt nobody answered", () => {
    const waited = { wantedMs: 30 * HOUR, lastUnansweredAt: at(19, 3) };

    it("does not use the same plug-in twice", () => {
      expect(ask({ power: pluggedIn(at(19)), lastUnansweredAt: at(19, 3), now: at(19, 15) })).toEqual({
        ready: false,
        reason: "moment-used",
        moments: ["plugged-in"],
      });
    });

    it("starts at the next plug-in", () => {
      expect(
        ask({ power: pluggedIn(at(20)), lastUnansweredAt: at(19, 3), now: at(20, 1) }),
      ).toEqual({ ready: true, moment: "plugged-in" });
    });

    it("does not use the same stretch of being unlocked twice, but does use the next", () => {
      expect(ask({ ...waited, lock: unlocked(at(19)), now: at(19, 15) })).toMatchObject({
        ready: false,
        reason: "moment-used",
      });
      expect(ask({ ...waited, lock: unlocked(at(19, 40)), now: at(19, 41) })).toEqual({
        ready: true,
        moment: "unlocked",
      });
    });

    it("on a charger with no moment to wait for, asks again only after four hours", () => {
      const charging = alreadyCharging(at(12));
      expect(ask({ ...waited, power: charging, now: at(23, 2) })).toMatchObject({
        ready: false,
        reason: "moment-used",
      });
      expect(ask({ ...waited, power: charging, now: at(23, 3) })).toEqual({
        ready: true,
        moment: "on-charger",
      });
    });
  });

  describe("with moments switched off", () => {
    it("any time on a charger from the start, if that is what is set", () => {
      const charger = { ...policy, startOnChargerAfterHours: 0 };
      expect(ask({ policy: charger, power: alreadyCharging(at(19)), now: at(19) })).toEqual({
        ready: true,
        moment: "on-charger",
      });
    });

    it("ignores a plug-in when plug-ins are switched off", () => {
      const noPlugIn = { ...policy, startWhenPluggedIn: false };
      expect(ask({ policy: noPlugIn, power: pluggedIn(at(19)), now: at(19, 1) })).toEqual({
        ready: false,
        reason: "waiting-for-moment",
        moments: [],
      });
    });
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
