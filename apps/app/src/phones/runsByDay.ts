import type { RunSummary } from "@pommedonjon/api-contract";
import { dayHeading, dayNumber, type TimeStyle } from "./time";

/** The backups of one calendar day, most recent first. */
export interface HistoryDay {
  /** "Today", "Yesterday", a weekday, then the date. */
  readonly heading: string;
  readonly runs: readonly RunSummary[];
}

/** When a backup belongs in the history: when it ended, or began if it has not. */
export function happenedAt(run: RunSummary): Date {
  return new Date(run.finishedAt ?? run.startedAt);
}

/** Runs, most recent first, gathered under the day each happened on. */
export function groupByDay(
  runs: readonly RunSummary[],
  now: Date,
  style: TimeStyle = {},
): HistoryDay[] {
  const days: { day: number; heading: string; runs: RunSummary[] }[] = [];
  for (const run of runs) {
    const when = happenedAt(run);
    const day = dayNumber(when, style);
    const last = days.at(-1);
    if (last && last.day === day) last.runs.push(run);
    else days.push({ day, heading: dayHeading(when, now, style), runs: [run] });
  }
  return days.map(({ heading, runs: ofDay }) => ({ heading, runs: ofDay }));
}
