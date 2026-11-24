import {
  PASSCODE_WINDOW_SECONDS,
  type DeviceSummary,
  type RunSummary,
  type Waiting,
} from "@pommedonjon/api-contract";
import { ago, at, howLong, timeOfDay, took, type TimeStyle } from "./time";

/** Which of the theme's state colours a phone's state is shown in. */
export type Tone = "safe" | "due" | "overdue" | "busy" | "neutral";

/** A phone's state in words, as the design brief sets them out. */
export interface StateWords {
  /** The state itself: "Backed up", "Backup due". */
  readonly title: string;
  /** The line under it: when, or what to do. */
  readonly detail: string;
  /** What would make a backup start, when there is something to say. */
  readonly next?: string;
  readonly tone: Tone;
  /** One character standing for the state, so colour is never the only cue. */
  readonly glyph: string;
}

/**
 * The moments that would start a backup, as the end of "Will start the
 * next time ...". Undefined when there are none to name.
 */
function momentWords(moments: readonly string[] | undefined): string | undefined {
  const has = (moment: string) => moments?.includes(moment) ?? false;
  // Any time on a charger takes in plugging in.
  if (has("on-charger")) {
    return has("unlocked")
      ? "the phone is on a charger or unlocked at home"
      : "the phone is on a charger at home";
  }
  if (has("plugged-in")) {
    return has("unlocked") ? "you plug in or unlock the phone at home" : "you plug in at home";
  }
  return has("unlocked") ? "you unlock the phone at home" : undefined;
}

/** What the service is waiting for before it starts a backup. */
function waitingWords(waiting: Waiting | null, now: Date, style: TimeStyle): string | undefined {
  if (!waiting) return undefined;
  const until = waiting.until ? at(new Date(waiting.until), now, style) : undefined;
  const moment = momentWords(waiting.moments);
  switch (waiting.reason) {
    case "manual-only":
      return "Backs up only when you ask.";
    case "not-due":
      return until ? `Next backup due after ${until}.` : undefined;
    case "on-battery":
    case "waiting-for-plug-in":
    case "plug-in-window-passed":
    case "moment-used":
    case "waiting-for-moment":
      return moment ? `Will start the next time ${moment}.` : "Waiting for a good moment.";
    case "backing-off":
      return until ? `Will try again after ${until}.` : "Will try again soon.";
    case "outside-window":
      return until ? `Quiet hours. Waiting until ${until}.` : "Quiet hours.";
    case "unreachable":
      return "Will start when the phone is back at home.";
    case "wrong-device":
      return "A different phone answered at this phone's address.";
    case "probe-failed":
    case "error":
      return "Couldn't check on the phone just now. It will keep trying.";
    default:
      return "Waiting for a good moment.";
  }
}

function lastBackup(device: DeviceSummary, now: Date, style: TimeStyle): string {
  return device.lastBackupAt
    ? `Last backed up ${ago(new Date(device.lastBackupAt), now, style)}.`
    : "Not backed up yet.";
}

function runWords(device: DeviceSummary, now: Date): StateWords {
  const run = device.run;
  const base = { tone: "busy", glyph: "↻" } as const;
  switch (run?.stage) {
    case "passcode": {
      const since = run.passcodeSince ? new Date(run.passcodeSince) : now;
      const left = Math.max(
        0,
        PASSCODE_WINDOW_SECONDS - Math.floor((now.getTime() - since.getTime()) / 1000),
      );
      return {
        ...base,
        title: "Enter your passcode on the phone",
        detail: `The phone waits ${PASSCODE_WINDOW_SECONDS} seconds. ${left} ${left === 1 ? "second" : "seconds"} left.`,
      };
    }
    case "transferring":
      return {
        ...base,
        title: "Backing up",
        detail:
          run.percent === undefined
            ? "You can put the phone down."
            : `${Math.floor(run.percent)}%. You can put the phone down.`,
      };
    case "checking":
      return { ...base, title: "Checking the backup", detail: "Nearly done." };
    default:
      return { ...base, title: "Connecting to your phone", detail: "This takes a few seconds." };
  }
}

/** Put one phone's state into words. */
export function describeState(
  device: DeviceSummary,
  now: Date,
  style: TimeStyle = {},
): StateWords {
  const next = waitingWords(device.waiting, now, style);
  switch (device.state) {
    case "backing-up":
      return runWords(device, now);
    case "backed-up":
      return {
        title: "Backed up",
        detail: device.lastBackupAt ? ago(new Date(device.lastBackupAt), now, style) : "",
        ...(next && { next }),
        tone: "safe",
        glyph: "✓",
      };
    case "due":
      return {
        title: "Backup due",
        detail: lastBackup(device, now, style),
        ...(next && { next }),
        tone: "due",
        glyph: "…",
      };
    case "away":
      return {
        title: "Not at home",
        detail: lastBackup(device, now, style),
        next: "Will start when the phone is back at home.",
        tone: "neutral",
        glyph: "→",
      };
    case "overdue":
      return {
        title: device.lastBackupAt
          ? `No backup for ${howLong(new Date(device.lastBackupAt), now)}`
          : "No backup for a long time",
        detail: lastBackup(device, now, style),
        ...(next && { next }),
        tone: "overdue",
        glyph: "!",
      };
    case "needs-you":
      return device.problem === "not-paired"
        ? {
            title: "This phone needs pairing again",
            detail: "It no longer accepts the pairing it was added with.",
            tone: "overdue",
            glyph: "!",
          }
        : {
            title: "Backup encryption is off",
            detail: "Turn it back on for this phone, and backups will start again.",
            tone: "overdue",
            glyph: "!",
          };
    case "never":
      return {
        title: "Not backed up yet",
        detail: "The first backup takes the longest.",
        ...(next && { next }),
        tone: "due",
        glyph: "…",
      };
  }
}

/** Why a backup did not count, as a sentence and as a few words for a list. */
function failureWords(run: RunSummary): { readonly sentence: string; readonly short: string } {
  switch (run.reason) {
    case "device-locked":
      return {
        sentence: "The phone asked for your passcode and nobody answered.",
        short: "Nobody typed the passcode",
      };
    case "passcode-cancelled":
      return { sentence: "You cancelled on the phone.", short: "Cancelled on the phone" };
    case "unreachable":
    case "probe-failed":
      // Reaching the passcode prompt means the phone was there to begin with.
      return run.prompted
        ? { sentence: "Lost contact with the phone part-way.", short: "Lost contact part-way" }
        : { sentence: "Couldn't reach the phone.", short: "Couldn't reach the phone" };
    case "encryption-off":
      return {
        sentence: "Backup encryption is off on this phone.",
        short: "Backup encryption is off",
      };
    case "verification-failed":
      return {
        sentence: "The backup finished but did not pass its checks, so it does not count.",
        short: "Did not pass its checks",
      };
    case "not-paired":
      return { sentence: "The phone did not accept its pairing.", short: "Pairing not accepted" };
    case "interrupted":
      return { sentence: "The server stopped part-way.", short: "Server stopped part-way" };
    case "wrong-device":
      return {
        sentence: "A different phone answered at this phone's address.",
        short: "A different phone answered",
      };
    case "stopped":
      return { sentence: "You stopped it.", short: "Stopped from the app" };
    case "cancelled":
      return { sentence: "The backup was stopped.", short: "Stopped" };
    default:
      return { sentence: "The backup did not work.", short: "Did not work" };
  }
}

/**
 * What to say under a phone's state about its last try, or undefined when
 * there is nothing to add: it worked, or a good backup has been made since.
 */
export function lastTryWords(
  device: DeviceSummary,
  now: Date,
  style: TimeStyle = {},
): string | undefined {
  const attempt = device.lastAttempt;
  if (!attempt || attempt.outcome !== "failed" || device.state === "backing-up") return undefined;
  const ended = new Date(attempt.finishedAt ?? attempt.startedAt);
  if (device.lastBackupAt && new Date(device.lastBackupAt).getTime() >= ended.getTime()) {
    return undefined;
  }
  const safe = device.lastBackupAt ? " Your last good backup is safe." : "";
  return `Tried ${ago(ended, now, style)}. ${failureWords(attempt).sentence}${safe}`;
}

/** One past backup, as a row of the history. */
export interface AttemptWords {
  readonly title: string;
  /** When, and for a good one how long it took. */
  readonly detail: string;
  readonly tone: Tone;
  readonly glyph: string;
}

/** What started a backup, to follow its time in the history. */
function startedWords(startedBy: string | null): string | undefined {
  switch (startedBy) {
    case "request":
      return "asked for";
    case "plugged-in":
      return "after a plug-in";
    case "unlocked":
      return "after an unlock";
    case "on-charger":
      return "while on a charger";
    case "app-open":
      return "on opening the app";
    case "command":
      return "from the command line";
    default:
      return undefined;
  }
}

export function describeAttempt(run: RunSummary, style: TimeStyle = {}): AttemptWords {
  const started = startedWords(run.startedBy);
  const parts = (...texts: (string | undefined)[]) =>
    texts.filter((text) => text !== undefined).join(", ");
  if (run.outcome === "running") {
    return {
      title: "Backing up now",
      detail: parts(`Started ${timeOfDay(new Date(run.startedAt), style)}`, started),
      tone: "busy",
      glyph: "↻",
    };
  }
  const when = timeOfDay(new Date(run.finishedAt ?? run.startedAt), style);
  if (run.outcome === "succeeded") {
    return {
      title: "Backed up",
      detail: parts(
        when,
        run.durationMs === null ? undefined : `took ${took(run.durationMs)}`,
        started,
      ),
      tone: "safe",
      glyph: "✓",
    };
  }
  return { title: failureWords(run).short, detail: parts(when, started), tone: "due", glyph: "×" };
}
