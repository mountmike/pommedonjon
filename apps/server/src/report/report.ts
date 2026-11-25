import type { DeviceEvent, RunEvent, RunRecord } from "../state/StateStore.js";

/**
 * What happened to one phone over a stretch of days, laid out to answer the
 * questions a trial of the schedule is run to answer: does a backup happen
 * every day the phone is charged at home, how often does a prompt arrive
 * when nobody is there, and how many prompts does a normal day produce.
 */

export type RunKind =
  | "backed-up"
  /** The passcode prompt was left for its full minute. */
  | "prompt-timed-out"
  /** The owner dismissed the prompt. */
  | "prompt-cancelled"
  | "failed"
  | "running";

export interface RunSummary {
  readonly startedAt: Date;
  readonly kind: RunKind;
  /** Why it failed, for the kinds that are failures. */
  readonly reason: string | undefined;
  /** When the phone showed its passcode prompt, if it did. */
  readonly promptAt: Date | undefined;
  /** How long the prompt was open before it was answered, dismissed or expired. */
  readonly promptOpenSeconds: number | undefined;
  readonly durationSeconds: number | undefined;
}

export interface DayReport {
  /** Local calendar date, "2026-11-24". */
  readonly date: string;
  readonly entries: readonly DayEntry[];
  /** The phone was seen going onto power. */
  readonly pluggedIn: boolean;
  readonly backedUp: boolean;
}

export type DayEntry =
  | {
      readonly at: Date;
      readonly type: "power";
      readonly from: string;
      readonly to: string;
      readonly sawPlugIn: boolean | undefined;
    }
  | { readonly at: Date; readonly type: "waiting"; readonly reason: string }
  /** A backup started because it was asked for, or the phone reported a plug-in. */
  | { readonly at: Date; readonly type: "requested"; readonly source: string }
  /** The phone reported a plug-in and the schedule said not now. */
  | { readonly at: Date; readonly type: "plug-in-reported"; readonly reason: string }
  | { readonly at: Date; readonly type: "run"; readonly run: RunSummary };

export interface ReportTotals {
  readonly days: number;
  readonly daysPluggedIn: number;
  readonly daysBackedUp: number;
  /** Dates on which a plug-in was seen and no backup succeeded. */
  readonly pluggedInNotBackedUp: readonly string[];
  readonly prompts: number;
  readonly promptsAnswered: number;
  readonly promptsTimedOut: number;
  readonly promptsCancelled: number;
  /** Local hour of day (0 to 23) to how many prompts timed out in it. */
  readonly timedOutByHour: Readonly<Record<number, number>>;
  /** Of the prompts that were answered, the middle time taken. */
  readonly medianAnswerSeconds: number | undefined;
  /** The longest stretch between one good backup and the next. */
  readonly longestGapHours: number | undefined;
}

export interface DeviceReport {
  readonly deviceId: string;
  readonly from: string;
  readonly to: string;
  readonly totals: ReportTotals;
  readonly days: readonly DayReport[];
}

export interface ReportInput {
  readonly deviceId: string;
  /** The first day to cover; the report runs from its start to `now`. */
  readonly since: Date;
  readonly now: Date;
  /** Runs started in that period, in any order. */
  readonly runs: readonly RunRecord[];
  readonly eventsFor: (runId: number) => readonly RunEvent[];
  readonly deviceEvents: readonly DeviceEvent[];
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The local calendar date of a moment. */
export function localDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function summarise(run: RunRecord, events: readonly RunEvent[]): RunSummary {
  const shown = events.find((event) => event.type === "passcode-required")?.at;
  const closed = events.find((event) => event.type === "passcode-dismissed")?.at;
  const kind: RunKind =
    run.outcome === "succeeded"
      ? "backed-up"
      : run.outcome === "running"
        ? "running"
        : run.failureReason === "device-locked"
          ? "prompt-timed-out"
          : run.failureReason === "passcode-cancelled"
            ? "prompt-cancelled"
            : "failed";
  return {
    startedAt: run.startedAt,
    kind,
    reason: run.outcome === "failed" ? (run.failureReason ?? "failed") : undefined,
    promptAt: shown,
    promptOpenSeconds:
      shown && closed ? Math.round((closed.getTime() - shown.getTime()) / 100) / 10 : undefined,
    durationSeconds: run.durationMs === undefined ? undefined : Math.round(run.durationMs / 1000),
  };
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);

export function buildReport(input: ReportInput): DeviceReport {
  const { deviceId, since, now } = input;
  const entriesByDate = new Map<string, DayEntry[]>();

  // Every calendar day in the period gets a row, so a day on which nothing
  // was seen shows as exactly that.
  const cursor = new Date(since.getFullYear(), since.getMonth(), since.getDate());
  while (cursor.getTime() <= now.getTime()) {
    entriesByDate.set(localDate(cursor), []);
    cursor.setDate(cursor.getDate() + 1);
  }
  const add = (entry: DayEntry) => entriesByDate.get(localDate(entry.at))?.push(entry);

  for (const event of input.deviceEvents) {
    if (event.kind === "power") {
      const saw = event.detail["sawPlugIn"];
      add({
        at: event.at,
        type: "power",
        from: text(event.detail["from"], "unknown"),
        to: text(event.detail["to"], "unknown"),
        sawPlugIn: typeof saw === "boolean" ? saw : undefined,
      });
    } else if (event.kind === "waiting") {
      add({ at: event.at, type: "waiting", reason: text(event.detail["reason"], "unknown") });
    } else if (event.kind === "requested") {
      add({ at: event.at, type: "requested", source: text(event.detail["source"], "request") });
    } else if (event.kind === "plug-in-reported") {
      add({
        at: event.at,
        type: "plug-in-reported",
        reason: text(event.detail["reason"], "unknown"),
      });
    }
  }

  const runs = [...input.runs].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const summaries = runs.map((run) => summarise(run, input.eventsFor(run.id)));
  for (const run of summaries) add({ at: run.startedAt, type: "run", run });

  const days = [...entriesByDate].map(([date, entries]): DayReport => {
    // Sorting is stable, so entries at the same instant keep the order above:
    // a plug-in is listed before the backup it set off.
    entries.sort((a, b) => a.at.getTime() - b.at.getTime());
    return {
      date,
      entries,
      pluggedIn: entries.some(
        (entry) => entry.type === "power" && entry.to === "on-power" && entry.sawPlugIn === true,
      ),
      backedUp: entries.some((entry) => entry.type === "run" && entry.run.kind === "backed-up"),
    };
  });

  const prompted = summaries.filter((run) => run.promptAt !== undefined);
  const timedOut = prompted.filter((run) => run.kind === "prompt-timed-out");
  const cancelled = prompted.filter((run) => run.kind === "prompt-cancelled");
  const answered = prompted.filter(
    (run) => run.kind !== "prompt-timed-out" && run.kind !== "prompt-cancelled",
  );
  const timedOutByHour: Record<number, number> = {};
  for (const run of timedOut) {
    const hour = (run.promptAt as Date).getHours();
    timedOutByHour[hour] = (timedOutByHour[hour] ?? 0) + 1;
  }

  const good = runs
    .filter((run) => run.outcome === "succeeded" && run.finishedAt)
    .map((run) => (run.finishedAt as Date).getTime());
  let longestGapMs: number | undefined;
  for (let index = 1; index < good.length; index += 1) {
    const gap = (good[index] as number) - (good[index - 1] as number);
    if (longestGapMs === undefined || gap > longestGapMs) longestGapMs = gap;
  }

  return {
    deviceId,
    from: days[0]?.date ?? localDate(since),
    to: days.at(-1)?.date ?? localDate(now),
    totals: {
      days: days.length,
      daysPluggedIn: days.filter((day) => day.pluggedIn).length,
      daysBackedUp: days.filter((day) => day.backedUp).length,
      pluggedInNotBackedUp: days
        .filter((day) => day.pluggedIn && !day.backedUp)
        .map((day) => day.date),
      prompts: prompted.length,
      promptsAnswered: answered.length,
      promptsTimedOut: timedOut.length,
      promptsCancelled: cancelled.length,
      timedOutByHour,
      medianAnswerSeconds: median(
        answered
          .map((run) => run.promptOpenSeconds)
          .filter((seconds): seconds is number => seconds !== undefined),
      ),
      longestGapHours:
        longestGapMs === undefined ? undefined : Math.round(longestGapMs / 360_000) / 10,
    },
    days,
  };
}

const clock = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

function duration(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function describeRun(run: RunSummary): string {
  const prompt =
    run.promptAt === undefined
      ? "no prompt shown"
      : `prompt at ${clock(run.promptAt)}` +
        (run.promptOpenSeconds === undefined ? "" : `, open ${run.promptOpenSeconds} s`);
  switch (run.kind) {
    case "backed-up":
      return `backed up${run.durationSeconds === undefined ? "" : ` in ${duration(run.durationSeconds)}`} (${prompt})`;
    case "prompt-timed-out":
      return `prompt went unanswered (${prompt})`;
    case "prompt-cancelled":
      return `prompt was cancelled on the phone (${prompt})`;
    case "running":
      return `backup still running (${prompt})`;
    case "failed":
      return `backup failed: ${run.reason ?? "failed"} (${prompt})`;
  }
}

function describePower(entry: Extract<DayEntry, { type: "power" }>): string {
  if (entry.to === "on-power") {
    return entry.sawPlugIn === false
      ? "on power (already charging when first seen)"
      : entry.from === "unreachable"
        ? "back, and on power"
        : "plugged in";
  }
  if (entry.to === "on-battery") {
    return entry.from === "on-power" ? "unplugged" : "seen, on battery";
  }
  if (entry.to === "unreachable") return "stopped answering";
  return `power: ${entry.from} to ${entry.to}`;
}

/** The report as text for a person to read. */
export function formatReport(report: DeviceReport): string {
  const { totals } = report;
  const lines = [
    `${report.deviceId}: ${report.from} to ${report.to} (${totals.days} days)`,
    `  backed up on ${totals.daysBackedUp} of ${totals.days} days; seen plugged in on ${totals.daysPluggedIn}`,
    `  prompts: ${totals.prompts} shown, ${totals.promptsAnswered} answered` +
      (totals.medianAnswerSeconds === undefined
        ? ""
        : ` (median ${totals.medianAnswerSeconds} s)`) +
      `, ${totals.promptsTimedOut} unanswered, ${totals.promptsCancelled} cancelled`,
  ];
  const hours = Object.entries(totals.timedOutByHour);
  if (hours.length > 0) {
    lines.push(
      `  unanswered prompts by hour: ${hours.map(([hour, count]) => `${pad(Number(hour))}:00 x${count}`).join(", ")}`,
    );
  }
  if (totals.pluggedInNotBackedUp.length > 0) {
    lines.push(`  plugged in but not backed up: ${totals.pluggedInNotBackedUp.join(", ")}`);
  }
  if (totals.longestGapHours !== undefined) {
    lines.push(`  longest gap between good backups: ${totals.longestGapHours} hours`);
  }

  for (const day of report.days) {
    lines.push("", day.date);
    if (day.entries.length === 0) lines.push("  nothing seen");
    for (const entry of day.entries) {
      const what =
        entry.type === "run"
          ? describeRun(entry.run)
          : entry.type === "power"
            ? describePower(entry)
            : entry.type === "requested"
              ? entry.source === "plug-in"
                ? "phone said it was plugged in: backup due"
                : entry.source === "app-open"
                  ? "app opened on the phone: backup due"
                  : "backup requested"
              : entry.type === "plug-in-reported"
                ? `phone said it was plugged in: no backup (${entry.reason})`
                : `waiting: ${entry.reason}`;
      lines.push(`  ${clock(entry.at)}  ${what}`);
    }
  }
  return lines.join("\n");
}
