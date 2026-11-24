import type { DevicePolicy, TimeWindow } from "../config/config.js";
import type { LockState } from "./lock.js";
import type { PowerState } from "./power.js";

/** What the policy needs to know about one earlier attempt. */
export interface AttemptSummary {
  readonly startedAt: Date;
  /** Undefined while the attempt is still running. */
  readonly finishedAt: Date | undefined;
  readonly outcome: "running" | "succeeded" | "failed";
  /** Why it failed, e.g. "device-locked" for an unanswered passcode prompt. */
  readonly failureReason: string | undefined;
}

export type WaitReason =
  /** Backups only start when someone asks for one. */
  | "manual-only"
  /** The last good backup is recent enough. */
  | "not-due"
  /** Outside the hours when starting a backup is allowed. */
  | "outside-window"
  /** A recent attempt failed; leave the phone alone for a while. */
  | "backing-off"
  /** Another attempt for this device has not finished. */
  | "already-running";

export interface Schedule {
  /**
   * Whether to probe the phone now. True from shortly before a backup is due,
   * so that by the time one is due it is known whether the phone has just
   * been plugged in or has been charging for hours.
   */
  readonly observe: boolean;
  readonly start:
    | { readonly allowed: true }
    | {
        readonly allowed: false;
        readonly reason: WaitReason;
        /** When the answer could change, where that is knowable. */
        readonly until?: Date;
      };
}

/** A moment at which a wanted backup may start. */
export type Moment =
  /** In the minutes after the phone went onto a charger. */
  | "plugged-in"
  /** The phone is unlocked: its owner is using it. */
  | "unlocked"
  /** The phone is on a charger, however long it has been there. */
  | "on-charger";

export type ReadinessDecision =
  | {
      readonly ready: true;
      /** Which moment this is. */
      readonly moment: Moment;
    }
  | {
      readonly ready: false;
      readonly reason:
        /** Not on a charger. */
        | "on-battery"
        /** On a charger, but nobody saw it go on, so the owner may be away. */
        | "waiting-for-plug-in"
        /** Plugged in too long ago; wait for the next time. */
        | "plug-in-window-passed"
        /** This moment already led to a prompt nobody answered; wait for the next. */
        | "moment-used"
        /** None of the moments in play has come. */
        | "waiting-for-moment";
      /** The moments that would start a backup now, were one to come. */
      readonly moments: readonly Moment[];
    };

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * With "any time on a charger", how long after an unanswered prompt before
 * asking again. That rung has no moment to wait for, so it waits this long.
 */
export const ON_CHARGER_REASK_MS = 4 * HOUR_MS;

const DAY_MS = 24 * HOUR_MS;

/** How long before a backup is due the phone starts being watched. */
export const WATCH_LEAD_MS = 30 * MINUTE_MS;

/** Whether a local time of day falls inside a window (which may wrap midnight). */
export function inWindow(window: TimeWindow, now: Date): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return window.startMinutes < window.endMinutes
    ? minutes >= window.startMinutes && minutes < window.endMinutes
    : minutes >= window.startMinutes || minutes < window.endMinutes;
}

/** The next moment the window opens, at or after `now`. */
function nextWindowStart(window: TimeWindow, now: Date): Date {
  const start = new Date(now);
  start.setHours(Math.floor(window.startMinutes / 60), window.startMinutes % 60, 0, 0);
  if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + 1);
  return start;
}

/**
 * Decide, from the clock and history alone, whether to look at the phone and
 * whether a backup may start. Nothing here contacts the phone.
 */
export function schedule(input: {
  readonly now: Date;
  readonly policy: DevicePolicy;
  /** When the last verified backup finished, if there has ever been one. */
  readonly lastSuccessAt: Date | undefined;
  /** Recent attempts, in any order. */
  readonly recentAttempts: readonly AttemptSummary[];
}): Schedule {
  const { now, policy, lastSuccessAt, recentAttempts } = input;
  const nowMs = now.getTime();

  if (recentAttempts.some((attempt) => attempt.outcome === "running")) {
    return { observe: false, start: { allowed: false, reason: "already-running" } };
  }

  if (!policy.automatic) {
    // Nothing to watch for: a backup starts only when someone asks.
    return { observe: false, start: { allowed: false, reason: "manual-only" } };
  }

  if (lastSuccessAt) {
    const dueAt = lastSuccessAt.getTime() + policy.dueAfterHours * HOUR_MS;
    if (nowMs < dueAt) {
      return {
        observe: nowMs >= dueAt - WATCH_LEAD_MS,
        start: { allowed: false, reason: "not-due", until: new Date(dueAt) },
      };
    }
  }

  if (policy.window && !inWindow(policy.window, now)) {
    return {
      observe: true,
      start: {
        allowed: false,
        reason: "outside-window",
        until: nextWindowStart(policy.window, now),
      },
    };
  }

  // Enough prompts have gone unanswered for one day: stop until the oldest
  // of them is a day old.
  const unanswered = recentAttempts
    .filter((attempt) => attempt.outcome === "failed" && attempt.failureReason === "device-locked")
    .flatMap((attempt) => (attempt.finishedAt ? [attempt.finishedAt.getTime()] : []))
    .filter((finishedAt) => finishedAt > nowMs - DAY_MS)
    .sort((a, b) => b - a);
  const oldestCounted = unanswered[policy.maxUnansweredPerDay - 1];
  if (oldestCounted !== undefined) {
    return {
      observe: true,
      start: { allowed: false, reason: "backing-off", until: new Date(oldestCounted + DAY_MS) },
    };
  }

  // After an unanswered prompt there is a short pause, and then a fresh
  // moment is needed (see readyToStart): the owner was simply not there. A
  // dismissed one means "not now" and is respected for much longer.
  // Anything else gets its own, separately set, pause.
  let lastFailure: AttemptSummary | undefined;
  for (const attempt of recentAttempts) {
    if (attempt.outcome !== "failed" || !attempt.finishedAt) continue;
    if (!lastFailure?.finishedAt || attempt.finishedAt > lastFailure.finishedAt) {
      lastFailure = attempt;
    }
  }
  if (lastFailure?.finishedAt) {
    const pauseMinutes =
      lastFailure.failureReason === "device-locked"
        ? policy.retryAfterTimeoutMinutes
        : lastFailure.failureReason === "passcode-cancelled"
          ? policy.retryAfterCancelMinutes
          : policy.retryAfterFailureMinutes;
    const retryAt = lastFailure.finishedAt.getTime() + pauseMinutes * MINUTE_MS;
    if (nowMs < retryAt) {
      return {
        observe: true,
        start: { allowed: false, reason: "backing-off", until: new Date(retryAt) },
      };
    }
  }

  return { observe: true, start: { allowed: true } };
}

/**
 * How long a backup has been wanted: since the last good one became older
 * than "how often". Zero while none is wanted.
 *
 * Zero, too, for a phone that has never been backed up: there is nothing
 * to measure from, and a phone just added should not be prompted at the
 * first moment the service gets less choosy about. Its first backup comes
 * at a plug-in, or when its owner asks.
 */
export function wantedForMs(
  policy: Pick<DevicePolicy, "dueAfterHours">,
  lastSuccessAt: Date | undefined,
  now: Date,
): number {
  if (!lastSuccessAt) return 0;
  return Math.max(0, now.getTime() - lastSuccessAt.getTime() - policy.dueAfterHours * HOUR_MS);
}

/** When the most recent passcode prompt went unanswered, if any did. */
export function lastUnansweredAt(recentAttempts: readonly AttemptSummary[]): Date | undefined {
  let latest: Date | undefined;
  for (const attempt of recentAttempts) {
    if (attempt.failureReason !== "device-locked" || !attempt.finishedAt) continue;
    if (!latest || attempt.finishedAt > latest) latest = attempt.finishedAt;
  }
  return latest;
}

type MomentSettings = Pick<
  DevicePolicy,
  | "startWhenPluggedIn"
  | "pluggedInWindowMinutes"
  | "startWhenUnlockedAfterHours"
  | "startOnChargerAfterHours"
>;

/**
 * The moments in play, given how long a backup has been wanted. The longer
 * it has waited, the more of them there are.
 */
export function momentsInPlay(policy: MomentSettings, wantedMs: number): Moment[] {
  const waited = (hours: number | null) => hours !== null && wantedMs >= hours * HOUR_MS;
  return [
    ...(policy.startWhenPluggedIn ? (["plugged-in"] as const) : []),
    ...(waited(policy.startWhenUnlockedAfterHours) ? (["unlocked"] as const) : []),
    ...(waited(policy.startOnChargerAfterHours) ? (["on-charger"] as const) : []),
  ];
}

/**
 * Decide whether what is known about the phone means "start now": whether
 * one of the moments in play has come, and has not already been spent on a
 * prompt nobody answered.
 */
export function readyToStart(input: {
  readonly policy: MomentSettings;
  readonly power: PowerState;
  readonly lock: LockState;
  /** How long a backup has been wanted; see {@link wantedForMs}. */
  readonly wantedMs: number;
  /** When the most recent passcode prompt went unanswered, if any did. */
  readonly lastUnansweredAt: Date | undefined;
  readonly now: Date;
}): ReadinessDecision {
  const { policy, power, lock, wantedMs, lastUnansweredAt: unanswered, now } = input;
  const moments = momentsInPlay(policy, wantedMs);
  const nowMs = now.getTime();
  /** Whether something that began at `since` is news since the last unanswered prompt. */
  const fresh = (since: Date) => !unanswered || since.getTime() > unanswered.getTime();
  let used = false;

  const pluggedInNow =
    power.kind === "on-power" &&
    power.pluggedIn &&
    nowMs - power.since.getTime() <= policy.pluggedInWindowMinutes * MINUTE_MS;
  if (moments.includes("plugged-in") && power.kind === "on-power" && pluggedInNow) {
    if (fresh(power.since)) return { ready: true, moment: "plugged-in" };
    used = true;
  }
  if (moments.includes("unlocked") && lock.kind === "unlocked") {
    if (fresh(lock.since)) return { ready: true, moment: "unlocked" };
    used = true;
  }
  if (moments.includes("on-charger") && power.kind === "on-power") {
    if (!unanswered || nowMs - unanswered.getTime() >= ON_CHARGER_REASK_MS) {
      return { ready: true, moment: "on-charger" };
    }
    used = true;
  }

  if (used) return { ready: false, reason: "moment-used", moments };
  if (!moments.includes("plugged-in")) return { ready: false, reason: "waiting-for-moment", moments };
  if (power.kind !== "on-power") return { ready: false, reason: "on-battery", moments };
  if (!power.pluggedIn) return { ready: false, reason: "waiting-for-plug-in", moments };
  return { ready: false, reason: "plug-in-window-passed", moments };
}

/** Whether the last good backup is old enough to warn about. */
export function isStale(
  policy: DevicePolicy,
  lastSuccessAt: Date | undefined,
  now: Date,
): boolean {
  if (!lastSuccessAt) return false;
  return now.getTime() - lastSuccessAt.getTime() > policy.staleAfterHours * HOUR_MS;
}
