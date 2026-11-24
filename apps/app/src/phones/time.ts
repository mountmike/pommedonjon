/** How times are written. Passed in so tests do not depend on the machine. */
export interface TimeStyle {
  readonly locale?: string;
  readonly timeZone?: string;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function clock(at: Date, style: TimeStyle): string {
  return new Intl.DateTimeFormat(style.locale, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: style.timeZone,
  })
    .format(at)
    .replace(/\s/g, " ")
    .toLowerCase();
}

/** The calendar day a moment falls on, as a number that counts days. */
function dayNumber(at: Date, style: TimeStyle): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: style.timeZone,
  }).format(at);
  return Math.round(Date.parse(`${parts}T00:00:00Z`) / (24 * HOUR));
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** A named day near `now`: "today", "tomorrow", "yesterday", else the weekday or the date. */
function dayName(at: Date, now: Date, style: TimeStyle): string | undefined {
  const days = dayNumber(at, style) - dayNumber(now, style);
  if (days === 0) return undefined;
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (Math.abs(days) < 7) {
    return new Intl.DateTimeFormat(style.locale, {
      weekday: "long",
      timeZone: style.timeZone,
    }).format(at);
  }
  return new Intl.DateTimeFormat(style.locale, {
    day: "numeric",
    month: "long",
    timeZone: style.timeZone,
  }).format(at);
}

/**
 * When something happened, for a person: "just now", "5 minutes ago",
 * "2 hours ago", then "yesterday at 9:01 pm", a weekday, and a date once
 * it is more than a week old.
 */
export function ago(at: Date, now: Date, style: TimeStyle = {}): string {
  const elapsed = now.getTime() - at.getTime();
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${plural(Math.floor(elapsed / MINUTE), "minute")} ago`;
  const day = dayName(at, now, style);
  if (day === undefined || elapsed < 6 * HOUR) {
    return `${plural(Math.floor(elapsed / HOUR), "hour")} ago`;
  }
  if (day === "yesterday" || Math.abs(dayNumber(at, style) - dayNumber(now, style)) < 7) {
    return `${day} at ${clock(at, style)}`;
  }
  return day;
}

/** A moment still to come: "5:24 pm", "5:24 pm tomorrow", "5:24 pm on Friday". */
export function at(when: Date, now: Date, style: TimeStyle = {}): string {
  const day = dayName(when, now, style);
  const time = clock(when, style);
  if (day === undefined) return time;
  return day === "tomorrow" || day === "yesterday" ? `${time} ${day}` : `${time} on ${day}`;
}

/** How long it has been, in the largest whole unit: "4 days", "20 hours". */
export function howLong(since: Date, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - since.getTime());
  if (elapsed >= 48 * HOUR) return plural(Math.floor(elapsed / (24 * HOUR)), "day");
  if (elapsed >= HOUR) return plural(Math.floor(elapsed / HOUR), "hour");
  return plural(Math.max(1, Math.floor(elapsed / MINUTE)), "minute");
}
