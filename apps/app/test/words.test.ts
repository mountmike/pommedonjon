import type { DeviceSummary, RunSummary } from "@pommedonjon/api-contract";
import { describe, expect, it } from "vitest";
import { groupByDay } from "../src/phones/runsByDay";
import { ago, at, dayHeading, howLong, took } from "../src/phones/time";
import { describeAttempt, describeState, lastTryWords } from "../src/phones/words";

// Melbourne, where the first phones live: UTC+11 in November.
const STYLE = { locale: "en-AU", timeZone: "Australia/Melbourne" };
/** 9:30 pm on Tuesday 24 November 2026, Melbourne time. */
const NOW = new Date("2026-11-24T10:30:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const hoursAgo = (hours: number) => minutesAgo(hours * 60);

function phone(overrides: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    id: "mike",
    name: "Mike's iPhone",
    state: "backed-up",
    lastBackupAt: hoursAgo(2).toISOString(),
    dueAt: hoursAgo(-18).toISOString(),
    waiting: { reason: "not-due", until: hoursAgo(-18).toISOString() },
    run: null,
    problem: null,
    lastAttempt: null,
    ...overrides,
  };
}

describe("ago", () => {
  it.each([
    [0.5, "just now"],
    [1, "1 minute ago"],
    [59, "59 minutes ago"],
    [60, "1 hour ago"],
    [5 * 60, "5 hours ago"],
    // Earlier the same day stays in hours.
    [12 * 60, "12 hours ago"],
    // 9:01 pm the evening before.
    [24 * 60 + 29, "yesterday at 9:01 pm"],
    [3 * 24 * 60, "Saturday at 9:30 pm"],
    [10 * 24 * 60, "14 November"],
  ])("%f minutes ago reads as %s", (minutes, expected) => {
    expect(ago(minutesAgo(minutes), NOW, STYLE)).toBe(expected);
  });

  it("says yesterday for something a few hours old on the other side of midnight only once it is old enough to matter", () => {
    // 11:50 pm the night before, seen at 1 am: two hours, not "yesterday".
    const now = new Date("2026-11-24T14:00:00.000Z");
    expect(ago(new Date(now.getTime() - 70 * 60_000), now, STYLE)).toBe("1 hour ago");
  });
});

describe("at", () => {
  it.each([
    [1, "10:30 pm"],
    [20, "5:30 pm tomorrow"],
    [72, "9:30 pm on Friday"],
  ])("%i hours from now reads as %s", (hours, expected) => {
    expect(at(hoursAgo(-hours), NOW, STYLE)).toBe(expected);
  });
});

describe("howLong", () => {
  it.each([
    [0.005, "1 minute"],
    [0.2, "12 minutes"],
    [3, "3 hours"],
    [47, "47 hours"],
    [72.5, "3 days"],
    [100, "4 days"],
  ])("%f hours is %s", (hours, expected) => {
    expect(howLong(hoursAgo(hours), NOW)).toBe(expected);
  });
});

describe("describeState", () => {
  it("answers the first question first for a phone that is backed up", () => {
    expect(describeState(phone(), NOW, STYLE)).toEqual({
      title: "Backed up",
      detail: "2 hours ago",
      next: "Next backup when you plug in at home after 3:30 pm tomorrow.",
      tone: "safe",
      glyph: "✓",
    });
  });

  it.each([
    ["on-battery", "Will start when you plug in at home."],
    ["waiting-for-plug-in", "Will start when you plug in at home."],
    ["plug-in-window-passed", "Will start the next time you plug in at home."],
    ["probe-failed", "Couldn't check on the phone just now. It will keep trying."],
    ["a-reason-from-a-newer-server", "Waiting for a good moment."],
  ])("says what a due backup is waiting for: %s", (reason, next) => {
    const words = describeState(
      phone({ state: "due", lastBackupAt: hoursAgo(24.5).toISOString(), waiting: { reason } }),
      NOW,
      STYLE,
    );
    expect(words).toMatchObject({
      title: "Backup due",
      detail: "Last backed up yesterday at 9:00 pm.",
      next,
      tone: "due",
    });
  });

  it("says when it will try again after a failed attempt", () => {
    const words = describeState(
      phone({
        state: "due",
        waiting: { reason: "backing-off", until: minutesAgo(-10).toISOString() },
      }),
      NOW,
      STYLE,
    );
    expect(words.next).toBe("Will try again after 9:40 pm.");
  });

  it("does not call a phone that is out a fault", () => {
    expect(
      describeState(
        phone({ state: "away", lastBackupAt: hoursAgo(24.5).toISOString(), waiting: { reason: "unreachable" } }),
        NOW,
        STYLE,
      ),
    ).toMatchObject({
      title: "Not at home",
      next: "Will start when the phone is back at home.",
      tone: "neutral",
    });
  });

  it("is unmissable about a phone that has gone days without a backup", () => {
    expect(
      describeState(
        phone({ state: "overdue", lastBackupAt: hoursAgo(100).toISOString(), waiting: { reason: "on-battery" } }),
        NOW,
        STYLE,
      ),
    ).toMatchObject({ title: "No backup for 4 days", tone: "overdue", glyph: "!" });
  });

  it.each([
    ["encryption-off", "Backup encryption is off"],
    ["not-paired", "This phone needs pairing again"],
  ] as const)("says what only the owner can fix: %s", (problem, title) => {
    expect(
      describeState(phone({ state: "needs-you", problem, waiting: { reason: problem } }), NOW, STYLE),
    ).toMatchObject({ title, tone: "overdue" });
  });

  it("is plain about a phone that has never been backed up", () => {
    expect(
      describeState(phone({ state: "never", lastBackupAt: null, dueAt: null, waiting: null }), NOW, STYLE),
    ).toMatchObject({ title: "Not backed up yet", tone: "due" });
  });

  describe("while a backup is running", () => {
    const running = (run: NonNullable<DeviceSummary["run"]>) =>
      describeState(phone({ state: "backing-up", waiting: null, run }), NOW, STYLE);
    const startedAt = minutesAgo(1).toISOString();

    it("says it is connecting", () => {
      expect(running({ stage: "connecting", startedAt })).toMatchObject({
        title: "Connecting to your phone",
        tone: "busy",
      });
    });

    it("asks for the passcode and counts the 60 seconds down", () => {
      const words = running({
        stage: "passcode",
        startedAt,
        passcodeSince: new Date(NOW.getTime() - 12_000).toISOString(),
      });
      expect(words).toMatchObject({
        title: "Enter your passcode on the phone",
        detail: "The phone waits 60 seconds. 48 seconds left.",
      });
    });

    it("never counts below zero", () => {
      const words = running({
        stage: "passcode",
        startedAt,
        passcodeSince: new Date(NOW.getTime() - 90_000).toISOString(),
      });
      expect(words.detail).toBe("The phone waits 60 seconds. 0 seconds left.");
    });

    it("shows how far the copy has got, in whole percent", () => {
      expect(running({ stage: "transferring", startedAt, percent: 42.7 })).toMatchObject({
        title: "Backing up",
        detail: "42%. You can put the phone down.",
      });
      expect(running({ stage: "transferring", startedAt }).detail).toBe("You can put the phone down.");
    });

    it("says it is checking the backup at the end", () => {
      expect(running({ stage: "checking", startedAt, percent: 100 }).title).toBe("Checking the backup");
    });
  });
});

function attempt(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    startedAt: minutesAgo(125).toISOString(),
    finishedAt: hoursAgo(2).toISOString(),
    outcome: "succeeded",
    reason: null,
    prompted: true,
    durationMs: 282_000,
    ...overrides,
  };
}

const failed = (reason: string, minutes: number, overrides: Partial<RunSummary> = {}) =>
  attempt({
    startedAt: minutesAgo(minutes + 1).toISOString(),
    finishedAt: minutesAgo(minutes).toISOString(),
    outcome: "failed",
    reason,
    durationMs: null,
    ...overrides,
  });

describe("took", () => {
  it.each([
    [400, "0 s"],
    [42_000, "42 s"],
    [60_000, "1 min"],
    [282_000, "4 min 42 s"],
    [3_600_000, "1 h"],
    [4_320_000, "1 h 12 min"],
  ])("%d ms reads as %s", (ms, expected) => {
    expect(took(ms)).toBe(expected);
  });
});

describe("dayHeading", () => {
  it.each([
    [1, "Today"],
    [24, "Yesterday"],
    [3 * 24, "Saturday"],
    [10 * 24, "14 November"],
  ])("%d hours ago is headed %s", (hours, expected) => {
    expect(dayHeading(hoursAgo(hours), NOW, STYLE)).toBe(expected);
  });
});

describe("lastTryWords", () => {
  it("says nothing when the last try worked", () => {
    expect(lastTryWords(phone({ lastAttempt: attempt() }), NOW, STYLE)).toBeUndefined();
  });

  it("says nothing when there has been no try", () => {
    expect(lastTryWords(phone(), NOW, STYLE)).toBeUndefined();
  });

  it.each([
    ["device-locked", "The phone asked for your passcode and nobody answered."],
    ["passcode-cancelled", "You cancelled on the phone."],
    ["verification-failed", "The backup finished but did not pass its checks, so it does not count."],
    ["not-paired", "The phone did not accept its pairing."],
    ["interrupted", "The server stopped part-way."],
    ["encryption-off", "Backup encryption is off on this phone."],
    ["something-new", "The backup did not work."],
  ])("explains a try that failed with %s, and that the last good backup is safe", (reason, sentence) => {
    const words = lastTryWords(phone({ lastAttempt: failed(reason, 5) }), NOW, STYLE);
    expect(words).toBe(`Tried 5 minutes ago. ${sentence} Your last good backup is safe.`);
  });

  it("tells losing the phone part-way from never reaching it", () => {
    const partWay = phone({ lastAttempt: failed("unreachable", 5, { prompted: true }) });
    const never = phone({ lastAttempt: failed("unreachable", 5, { prompted: false }) });
    expect(lastTryWords(partWay, NOW, STYLE)).toContain("Lost contact with the phone part-way.");
    expect(lastTryWords(never, NOW, STYLE)).toContain("Couldn't reach the phone.");
  });

  it("says a backup that was asked for could not reach the phone", () => {
    const asked = phone({ lastAttempt: failed("probe-failed", 0.2, { prompted: false }) });
    expect(lastTryWords(asked, NOW, STYLE)).toBe(
      "Tried just now. Couldn't reach the phone. Your last good backup is safe.",
    );
  });

  it("does not promise a good backup is safe when there has never been one", () => {
    const fresh = phone({ state: "never", lastBackupAt: null, lastAttempt: failed("device-locked", 5) });
    expect(lastTryWords(fresh, NOW, STYLE)).toBe(
      "Tried 5 minutes ago. The phone asked for your passcode and nobody answered.",
    );
  });

  it("stays quiet about a failure once a good backup has been made since", () => {
    // Failed three hours ago; backed up two hours ago.
    const recovered = phone({ lastAttempt: failed("device-locked", 180) });
    expect(lastTryWords(recovered, NOW, STYLE)).toBeUndefined();
  });

  it("stays quiet while another backup is running", () => {
    const running = phone({ state: "backing-up", lastAttempt: failed("device-locked", 5) });
    expect(lastTryWords(running, NOW, STYLE)).toBeUndefined();
  });
});

describe("describeAttempt", () => {
  it("says when a good backup ended and how long it took", () => {
    expect(describeAttempt(attempt(), STYLE)).toEqual({
      title: "Backed up",
      detail: "7:30 pm, took 4 min 42 s",
      tone: "safe",
      glyph: "✓",
    });
  });

  it("says why a failed one did not count, in a few words", () => {
    expect(describeAttempt(failed("passcode-cancelled", 60), STYLE)).toEqual({
      title: "Cancelled on the phone",
      detail: "8:30 pm",
      tone: "due",
      glyph: "×",
    });
  });

  it("shows one still running as running", () => {
    const running = attempt({ outcome: "running", finishedAt: null, durationMs: null });
    expect(describeAttempt(running, STYLE)).toMatchObject({
      title: "Backing up now",
      detail: "Started 7:25 pm",
    });
  });
});

describe("groupByDay", () => {
  it("gathers runs under the day each ended on, most recent first", () => {
    const runs = [
      failed("passcode-cancelled", 60),
      attempt(),
      // 9:01 pm the evening before.
      attempt({ startedAt: minutesAgo(24 * 60 + 34).toISOString(), finishedAt: minutesAgo(24 * 60 + 29).toISOString() }),
    ];
    const days = groupByDay(runs, NOW, STYLE);
    expect(days.map((day) => [day.heading, day.runs.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
    ]);
    expect(days[0]?.runs[0]?.reason).toBe("passcode-cancelled");
  });

  it("puts a run by the local day, not the UTC one", () => {
    // 12:30 am Melbourne on the 24th is still the 23rd in UTC.
    const justAfterMidnight = attempt({
      startedAt: "2026-11-23T13:25:00.000Z",
      finishedAt: "2026-11-23T13:30:00.000Z",
    });
    expect(groupByDay([justAfterMidnight], NOW, STYLE)[0]?.heading).toBe("Today");
  });

  it("has no days when there are no runs", () => {
    expect(groupByDay([], NOW, STYLE)).toEqual([]);
  });
});
