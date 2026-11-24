import { describe, expect, it } from "vitest";
import type { DeviceEvent, RunEvent, RunRecord } from "../../src/state/StateStore.js";
import { buildReport, formatReport, localDate } from "../../src/report/report.js";

/** Local time, so days and hours behave the same in any timezone. */
function at(day: number, hours: number, minutes = 0, seconds = 0): Date {
  return new Date(2026, 10, day, hours, minutes, seconds, 0);
}

let nextId = 1;
const events = new Map<number, RunEvent[]>();

function run(
  startedAt: Date,
  result:
    | { outcome: "succeeded"; seconds: number }
    | { outcome: "failed"; reason: string }
    | { outcome: "running" },
  prompt?: { afterSeconds: number; openSeconds: number },
): RunRecord {
  const id = nextId++;
  const list: RunEvent[] = [];
  if (prompt) {
    const shown = new Date(startedAt.getTime() + prompt.afterSeconds * 1000);
    list.push({ at: shown, type: "passcode-required", detail: {} });
    list.push({
      at: new Date(shown.getTime() + prompt.openSeconds * 1000),
      type: "passcode-dismissed",
      detail: {},
    });
  }
  events.set(id, list);
  const finishedAt =
    result.outcome === "running"
      ? undefined
      : new Date(
          startedAt.getTime() + (result.outcome === "succeeded" ? result.seconds : 70) * 1000,
        );
  return {
    id,
    deviceId: "mike",
    startedAt,
    finishedAt,
    outcome: result.outcome,
    failureReason: result.outcome === "failed" ? result.reason : undefined,
    message: undefined,
    prompted: prompt !== undefined,
    durationMs: result.outcome === "succeeded" ? result.seconds * 1000 : undefined,
  };
}

const power = (when: Date, from: string, to: string, sawPlugIn?: boolean): DeviceEvent => ({
  at: when,
  kind: "power",
  detail: { from, to, ...(sawPlugIn !== undefined && { sawPlugIn }) },
});
const waiting = (when: Date, reason: string): DeviceEvent => ({
  at: when,
  kind: "waiting",
  detail: { reason },
});

function report(runs: RunRecord[], deviceEvents: DeviceEvent[], days = { from: 24, to: 26 }) {
  return buildReport({
    deviceId: "mike",
    since: at(days.from, 0),
    now: at(days.to, 23, 59),
    runs,
    eventsFor: (id) => events.get(id) ?? [],
    deviceEvents,
  });
}

/** Three days: a normal one, one where the prompt was missed, one with no plug-in. */
function threeDays() {
  return report(
    [
      run(at(24, 18, 2), { outcome: "succeeded", seconds: 251 }, { afterSeconds: 3, openSeconds: 4 }),
      run(at(25, 23, 10), { outcome: "failed", reason: "device-locked" }, { afterSeconds: 3, openSeconds: 60 }),
      run(at(25, 23, 21), { outcome: "failed", reason: "device-locked" }, { afterSeconds: 4, openSeconds: 59 }),
    ],
    [
      power(at(24, 18, 2), "on-battery", "on-power", true),
      waiting(at(24, 18, 8), "not-due"),
      power(at(25, 7, 30), "on-power", "on-battery"),
      power(at(25, 23, 10), "on-battery", "on-power", true),
      waiting(at(25, 23, 42), "plug-in-window-passed"),
      power(at(26, 7, 15), "on-power", "on-battery"),
      power(at(26, 8, 0), "on-battery", "unreachable"),
    ],
  );
}

describe("buildReport", () => {
  it("answers: is the phone backed up on every day it is plugged in at home?", () => {
    const { totals } = threeDays();
    expect(totals).toMatchObject({
      days: 3,
      daysPluggedIn: 2,
      daysBackedUp: 1,
      pluggedInNotBackedUp: ["2026-11-25"],
    });
  });

  it("answers: how many prompts, and how many arrived with nobody there?", () => {
    const { totals } = threeDays();
    expect(totals).toMatchObject({
      prompts: 3,
      promptsAnswered: 1,
      promptsTimedOut: 2,
      promptsCancelled: 0,
      medianAnswerSeconds: 4,
    });
  });

  it("shows at what hour unanswered prompts arrived, which is what a trigger is judged on", () => {
    expect(threeDays().totals.timedOutByHour).toEqual({ 23: 2 });
  });

  it("lays each day out in order, with the plug-in before the backup it set off", () => {
    const [first, second, third] = threeDays().days;
    expect(first?.date).toBe("2026-11-24");
    expect(first?.entries.map((entry) => entry.type)).toEqual(["power", "run", "waiting"]);
    expect(second?.entries.map((entry) => entry.type)).toEqual([
      "power",
      "power",
      "run",
      "run",
      "waiting",
    ]);
    expect(third).toMatchObject({ date: "2026-11-26", pluggedIn: false, backedUp: false });
  });

  it("gives a day on which nothing was seen its own empty row", () => {
    const quiet = report([], [], { from: 24, to: 25 });
    expect(quiet.days).toEqual([
      { date: "2026-11-24", entries: [], pluggedIn: false, backedUp: false },
      { date: "2026-11-25", entries: [], pluggedIn: false, backedUp: false },
    ]);
    expect(quiet.totals).toMatchObject({ days: 2, prompts: 0, medianAnswerSeconds: undefined });
  });

  it("counts a cancelled prompt separately from an unanswered one", () => {
    const { totals } = report(
      [run(at(24, 8), { outcome: "failed", reason: "passcode-cancelled" }, { afterSeconds: 3, openSeconds: 2.6 })],
      [],
    );
    expect(totals).toMatchObject({ prompts: 1, promptsCancelled: 1, promptsTimedOut: 0, promptsAnswered: 0 });
  });

  it("counts a prompt as answered when the backup failed afterwards for another reason", () => {
    const { totals, days } = report(
      [run(at(24, 8), { outcome: "failed", reason: "unreachable" }, { afterSeconds: 3, openSeconds: 5 })],
      [],
    );
    expect(totals).toMatchObject({ prompts: 1, promptsAnswered: 1 });
    expect(days[0]?.entries[0]).toMatchObject({ run: { kind: "failed", reason: "unreachable" } });
  });

  it("does not count a run that never showed a prompt as a prompt", () => {
    const { totals } = report([run(at(24, 8), { outcome: "failed", reason: "unreachable" })], []);
    expect(totals.prompts).toBe(0);
  });

  it("does not call it a plug-in when the phone was already charging when first seen", () => {
    const { days, totals } = report([], [power(at(24, 9), "unknown", "on-power", false)]);
    expect(days[0]?.pluggedIn).toBe(false);
    expect(totals.daysPluggedIn).toBe(0);
  });

  it("measures the longest stretch between good backups", () => {
    const { totals } = report(
      [
        run(at(24, 18), { outcome: "succeeded", seconds: 60 }),
        run(at(25, 18), { outcome: "succeeded", seconds: 60 }),
        run(at(26, 23), { outcome: "succeeded", seconds: 60 }),
      ],
      [],
    );
    expect(totals.longestGapHours).toBe(29);
  });

  it("files an event under its local date", () => {
    expect(localDate(at(24, 0, 0))).toBe("2026-11-24");
    expect(localDate(at(24, 23, 59))).toBe("2026-11-24");
  });
});

describe("formatReport", () => {
  it("reads as a summary followed by a day-by-day account", () => {
    expect(formatReport(threeDays())).toBe(
      [
        "mike: 2026-11-24 to 2026-11-26 (3 days)",
        "  backed up on 1 of 3 days; seen plugged in on 2",
        "  prompts: 3 shown, 1 answered (median 4 s), 2 unanswered, 0 cancelled",
        "  unanswered prompts by hour: 23:00 x2",
        "  plugged in but not backed up: 2026-11-25",
        "",
        "2026-11-24",
        "  18:02  plugged in",
        "  18:02  backed up in 4 min 11 s (prompt at 18:02, open 4 s)",
        "  18:08  waiting: not-due",
        "",
        "2026-11-25",
        "  07:30  unplugged",
        "  23:10  plugged in",
        "  23:10  prompt went unanswered (prompt at 23:10, open 60 s)",
        "  23:21  prompt went unanswered (prompt at 23:21, open 59 s)",
        "  23:42  waiting: plug-in-window-passed",
        "",
        "2026-11-26",
        "  07:15  unplugged",
        "  08:00  stopped answering",
      ].join("\n"),
    );
  });

  it("says so when nothing was seen on a day", () => {
    expect(formatReport(report([], [], { from: 24, to: 24 }))).toContain(
      "2026-11-24\n  nothing seen",
    );
  });

  it("describes the other things that can happen in a day", () => {
    const text = formatReport(
      report(
        [
          run(at(24, 8), { outcome: "failed", reason: "passcode-cancelled" }, { afterSeconds: 3, openSeconds: 2.6 }),
          run(at(24, 9), { outcome: "failed", reason: "unreachable" }),
          run(at(24, 10), { outcome: "running" }),
        ],
        [
          power(at(24, 7), "unknown", "on-power", false),
          power(at(24, 12), "unreachable", "on-power", true),
          power(at(24, 13), "unknown", "on-battery"),
          { at: at(24, 14), kind: "requested", detail: {} },
        ],
      ),
    );
    expect(text).toContain("14:00  backup requested");
    expect(text).toContain("07:00  on power (already charging when first seen)");
    expect(text).toContain("08:00  prompt was cancelled on the phone (prompt at 08:00, open 2.6 s)");
    expect(text).toContain("09:00  backup failed: unreachable (no prompt shown)");
    expect(text).toContain("10:00  backup still running (no prompt shown)");
    expect(text).toContain("12:00  back, and on power");
    expect(text).toContain("13:00  seen, on battery");
  });
});
