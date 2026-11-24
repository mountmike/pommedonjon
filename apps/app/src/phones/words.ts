import {
  PASSCODE_WINDOW_SECONDS,
  type DeviceSummary,
  type Waiting,
} from "@pommedonjon/api-contract";
import { ago, at, howLong, type TimeStyle } from "./time";

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

/** What the service is waiting for before it starts a backup. */
function waitingWords(waiting: Waiting | null, now: Date, style: TimeStyle): string | undefined {
  if (!waiting) return undefined;
  const until = waiting.until ? at(new Date(waiting.until), now, style) : undefined;
  switch (waiting.reason) {
    case "not-due":
      return until ? `Next backup when you plug in at home after ${until}.` : undefined;
    case "on-battery":
    case "waiting-for-plug-in":
      return "Will start when you plug in at home.";
    case "plug-in-window-passed":
      return "Will start the next time you plug in at home.";
    case "backing-off":
      return until ? `Will try again after ${until}.` : "Will try again soon.";
    case "outside-window":
      return until ? `Waiting until ${until}.` : "Waiting for the hours you allow.";
    case "unreachable":
      return "Will start when the phone is back at home.";
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
