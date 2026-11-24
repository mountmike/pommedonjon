import type { DeviceSummary } from "@pommedonjon/api-contract";
import { describe, expect, it } from "vitest";
import { ago, at, howLong } from "../src/phones/time";
import { describeState } from "../src/phones/words";

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
