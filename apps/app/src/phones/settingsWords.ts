import type { DeviceSettings } from "@pommedonjon/api-contract";

/** One option of a picker. */
export interface Choice<T extends string | number> {
  readonly value: T;
  readonly label: string;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** 44 as "44 hours"; 48 as "2 days"; 168 as "1 week". */
function span(hours: number): string {
  if (hours % (7 * 24) === 0) return plural(hours / (7 * 24), "week");
  if (hours % 24 === 0) return plural(hours / 24, "day");
  return plural(hours, "hour");
}

/**
 * How often a backup is wanted. Each is a little under its round number,
 * so plugging in slightly earlier than last time still counts.
 */
const HOW_OFTEN: readonly Choice<number>[] = [
  { value: 20, label: "Every day" },
  { value: 44, label: "Every 2 days" },
  { value: 68, label: "Every 3 days" },
  { value: 164, label: "Every week" },
];

const PLUG_IN_MINUTES = [10, 15, 30, 60];
const OVERDUE_HOURS = [48, 72, 120, 168, 336];

/** The choices, with the current value added if it is not one of them. */
function including<T extends string | number>(
  choices: readonly Choice<T>[],
  current: T,
  label: (value: T) => string,
): Choice<T>[] {
  if (choices.some((choice) => choice.value === current)) return [...choices];
  return [...choices, { value: current, label: label(current) }].sort((a, b) =>
    a.value < b.value ? -1 : a.value > b.value ? 1 : 0,
  );
}

export function howOftenChoices(current: number): Choice<number>[] {
  return including(HOW_OFTEN, current, (hours) => `Every ${span(hours)}`);
}

export const TRIGGER_CHOICES: readonly Choice<DeviceSettings["trigger"]>[] = [
  { value: "plugged-in", label: "Just after I plug it in" },
  { value: "on-charger", label: "Any time it's on a charger" },
];

export function plugInChoices(current: number): Choice<number>[] {
  return including(
    PLUG_IN_MINUTES.map((minutes) => ({ value: minutes, label: plural(minutes, "minute") })),
    current,
    (minutes) => plural(minutes, "minute"),
  );
}

/** Only waits longer than the backup itself is wanted make sense. */
export function overdueChoices(current: number, dueAfterHours: number): Choice<number>[] {
  return including(
    OVERDUE_HOURS.map((hours) => ({ value: hours, label: span(hours) })),
    current,
    span,
  ).filter((choice) => choice.value > dueAfterHours);
}

/** "22:00" as "10 pm"; "07:30" as "7:30 am". */
export function hourLabel(time: string): string {
  const [hoursText = "0", minutes = "00"] = time.split(":");
  const hours = Number(hoursText);
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  const half = hours < 12 ? "am" : "pm";
  return minutes === "00" ? `${twelve} ${half}` : `${twelve}:${minutes} ${half}`;
}

const ON_THE_HOUR: readonly Choice<string>[] = Array.from({ length: 24 }, (_unused, hour) => {
  const value = `${String(hour).padStart(2, "0")}:00`;
  return { value, label: hourLabel(value) };
});

export function timeChoices(current: string): Choice<string>[] {
  return including(ON_THE_HOUR, current, hourLabel);
}

/** Quiet hours as first switched on: the night (DESIGN.md, "Automatic mode"). */
export const DEFAULT_QUIET_HOURS = { start: "22:00", end: "07:00" } as const;

/**
 * Settings after one of them was changed, kept consistent: the overdue
 * warning always comes later than the backup is wanted.
 */
export function withChange(
  settings: DeviceSettings,
  change: Partial<DeviceSettings>,
): DeviceSettings {
  const next = { ...settings, ...change };
  if (next.staleAfterHours > next.dueAfterHours) return next;
  const later = OVERDUE_HOURS.find((hours) => hours > next.dueAfterHours);
  return { ...next, staleAfterHours: later ?? next.dueAfterHours * 2 };
}

/** What is wrong with settings as typed, before the server is asked. */
export function problemsWith(settings: DeviceSettings): string[] {
  const problems: string[] = [];
  if (settings.name.trim() === "") problems.push("Give the phone a name.");
  if (settings.quietHours && settings.quietHours.start === settings.quietHours.end) {
    problems.push("Quiet hours need a different start and end.");
  }
  return problems;
}

/** A phone's schedule in a sentence or two, for its page. */
export function scheduleSummary(settings: DeviceSettings): string {
  const often = howOftenChoices(settings.dueAfterHours)
    .find((choice) => choice.value === settings.dueAfterHours)
    ?.label.toLowerCase();
  const when =
    settings.trigger === "plugged-in"
      ? `within ${plural(settings.pluggedInWindowMinutes, "minute")} of plugging in at home`
      : "any time it is on a charger at home";
  const quiet = settings.quietHours
    ? ` Quiet from ${hourLabel(settings.quietHours.start)} to ${hourLabel(settings.quietHours.end)}.`
    : "";
  return `Backs up ${often ?? "regularly"}, ${when}.${quiet} Shown as overdue after ${span(settings.staleAfterHours)} without a backup.`;
}
