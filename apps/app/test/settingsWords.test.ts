import type { DeviceSettings } from "@pommedonjon/api-contract";
import { describe, expect, it } from "vitest";
import {
  chargerWaitChoices,
  hourLabel,
  howOftenChoices,
  overdueChoices,
  plugInChoices,
  problemsWith,
  scheduleSummary,
  timeChoices,
  unlockWaitChoices,
  withChange,
} from "../src/phones/settingsWords";

const SETTINGS: DeviceSettings = {
  name: "Mike's iPhone",
  automatic: true,
  dueAfterHours: 20,
  startWhenPluggedIn: true,
  pluggedInWindowMinutes: 30,
  startWhenAppOpened: true,
  startWhenUnlockedAfterHours: 4,
  startOnChargerAfterHours: 24,
  quietHours: null,
  staleAfterHours: 72,
};

const values = (choices: readonly { value: unknown }[]) => choices.map((choice) => choice.value);
const labels = (choices: readonly { label: string }[]) => choices.map((choice) => choice.label);

describe("the choices", () => {
  it("offers how often in days and a week", () => {
    expect(labels(howOftenChoices(20))).toEqual([
      "Every day",
      "Every 2 days",
      "Every 3 days",
      "Every week",
    ]);
  });

  it("keeps a value set some other way among the choices, in order", () => {
    const choices = howOftenChoices(48);
    expect(values(choices)).toEqual([20, 44, 48, 68, 164]);
    expect(choices[2]?.label).toBe("Every 2 days");
    expect(labels(howOftenChoices(30))).toContain("Every 30 hours");
    expect(values(plugInChoices(45))).toEqual([10, 15, 30, 45, 60]);
  });

  it("only offers an overdue warning that comes after the backup is wanted", () => {
    expect(labels(overdueChoices(72, 20))).toEqual(["2 days", "3 days", "5 days", "1 week", "2 weeks"]);
    expect(labels(overdueChoices(168, 68))).toEqual(["3 days", "5 days", "1 week", "2 weeks"]);
  });

  it("offers how long a backup waits before a less choosy moment is used", () => {
    expect(labels(unlockWaitChoices(4))).toEqual(["No time at all", "1 hour", "4 hours", "12 hours"]);
    expect(labels(chargerWaitChoices(24))).toEqual(["No time at all", "4 hours", "1 day", "2 days"]);
    expect(values(chargerWaitChoices(36))).toEqual([0, 4, 24, 36, 48]);
    expect(values(unlockWaitChoices(null))).toEqual([0, 1, 4, 12]);
  });

  it("offers every hour of the day, and a time that is not on the hour if that is set", () => {
    const choices = timeChoices("22:00");
    expect(choices).toHaveLength(24);
    expect(choices[0]).toEqual({ value: "00:00", label: "12 am" });
    expect(choices[22]).toEqual({ value: "22:00", label: "10 pm" });
    expect(values(timeChoices("07:30")).slice(7, 9)).toEqual(["07:00", "07:30"]);
  });
});

describe("hourLabel", () => {
  it.each([
    ["00:00", "12 am"],
    ["07:00", "7 am"],
    ["07:30", "7:30 am"],
    ["12:00", "12 pm"],
    ["22:00", "10 pm"],
  ])("%s reads as %s", (time, expected) => {
    expect(hourLabel(time)).toBe(expected);
  });
});

describe("withChange", () => {
  it("changes what was asked and nothing else", () => {
    expect(withChange(SETTINGS, { startWhenPluggedIn: false })).toEqual({
      ...SETTINGS,
      startWhenPluggedIn: false,
    });
  });

  it("moves the overdue warning later when the backup is wanted less often than it", () => {
    // Every week, with a warning after 3 days, would always be overdue.
    expect(withChange(SETTINGS, { dueAfterHours: 164 })).toMatchObject({
      dueAfterHours: 164,
      staleAfterHours: 168,
    });
  });

  it("still finds a later warning beyond the longest choice", () => {
    expect(withChange(SETTINGS, { dueAfterHours: 400 }).staleAfterHours).toBe(800);
  });
});

describe("problemsWith", () => {
  it("finds nothing wrong with ordinary settings", () => {
    expect(problemsWith(SETTINGS)).toEqual([]);
  });

  it("wants a name", () => {
    expect(problemsWith({ ...SETTINGS, name: "  " })).toEqual(["Give the phone a name."]);
  });

  it("wants at least one moment while backups are automatic, and none when they are not", () => {
    const none = {
      ...SETTINGS,
      startWhenPluggedIn: false,
      startWhenAppOpened: false,
      startWhenUnlockedAfterHours: null,
      startOnChargerAfterHours: null,
    };
    expect(problemsWith(none)).toEqual([
      "Switch on at least one moment, or turn automatic backups off.",
    ]);
    expect(problemsWith({ ...none, automatic: false })).toEqual([]);
  });

  it("wants quiet hours that start and end at different times", () => {
    const same = { ...SETTINGS, quietHours: { start: "22:00", end: "22:00" } };
    expect(problemsWith(same)).toEqual(["Quiet hours need a different start and end."]);
  });
});

describe("scheduleSummary", () => {
  it("puts the default schedule in a sentence", () => {
    expect(scheduleSummary(SETTINGS)).toBe(
      "Backs up every day: when you plug in at home, when you open this app on it, when you unlock it once it has waited 4 hours, or any time it is on a charger once it has waited 1 day. Shown as overdue after 3 days without a backup.",
    );
  });

  it("mentions quiet hours, and leaves out moments that are off", () => {
    const settings: DeviceSettings = {
      ...SETTINGS,
      dueAfterHours: 44,
      startWhenPluggedIn: false,
      startWhenAppOpened: false,
      startWhenUnlockedAfterHours: null,
      startOnChargerAfterHours: 0,
      quietHours: { start: "22:00", end: "07:00" },
      staleAfterHours: 168,
    };
    expect(scheduleSummary(settings)).toBe(
      "Backs up every 2 days: any time it is on a charger. Quiet from 10 pm to 7 am. Shown as overdue after 1 week without a backup.",
    );
  });

  it("says so when backups are only on request", () => {
    expect(scheduleSummary({ ...SETTINGS, automatic: false })).toBe(
      "Backs up only when you press Back up now. Shown as overdue after 3 days without a backup.",
    );
  });
});
