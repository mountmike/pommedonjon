import type { DevicePolicy, TimeWindow } from "../config/config.js";
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

export type ReadinessDecision =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly reason:
        /** Not on a charger. */
        | "on-battery"
        /** On a charger, but nobody saw it go on, so the owner may be away. */
        | "waiting-for-plug-in"
        /** Plugged in too long ago; wait for the next time. */
        | "plug-in-window-passed";
    };

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

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

  // An unanswered prompt may be asked again soon: the owner was simply not
  // there. A dismissed one means "not now" and is respected for much
  // longer. Anything else gets its own, separately set, pause.
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

/** Decide whether what is known about the phone's power means "start now". */
export function readyToStart(
  policy: Pick<DevicePolicy, "trigger" | "pluggedInWindowMinutes">,
  power: PowerState,
  now: Date,
): ReadinessDecision {
  if (power.kind !== "on-power") return { ready: false, reason: "on-battery" };
  if (policy.trigger === "on-charger") return { ready: true };

  if (!power.pluggedIn) return { ready: false, reason: "waiting-for-plug-in" };
  const sincePlugIn = now.getTime() - power.since.getTime();
  if (sincePlugIn > policy.pluggedInWindowMinutes * MINUTE_MS) {
    return { ready: false, reason: "plug-in-window-passed" };
  }
  return { ready: true };
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
