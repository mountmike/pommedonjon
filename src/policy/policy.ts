import type { DevicePolicy, TimeWindow } from "../config/config.js";
import type { DeviceStatus } from "../transport/DeviceTransport.js";

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
  /** Outside the hours when prompting the owner is acceptable. */
  | "outside-window"
  /** A recent attempt failed; leave the phone alone for a while. */
  | "backing-off"
  /** Too many passcode prompts went unanswered in the last 24 hours. */
  | "prompt-budget-spent"
  /** Another attempt for this device has not finished. */
  | "already-running";

export type AttemptDecision =
  | { readonly attempt: true }
  | {
      readonly attempt: false;
      readonly reason: WaitReason;
      /** When the answer could change, where that is knowable. */
      readonly until?: Date;
    };

export type ReadinessDecision =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: "on-battery" | "battery-low" };

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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
 * Decide, from the clock and history alone, whether to try a backup now.
 * Nothing here contacts the phone, so the daemon can call it freely and only
 * probe the device when the answer is yes.
 */
export function shouldAttempt(input: {
  readonly now: Date;
  readonly policy: DevicePolicy;
  /** When the last verified backup finished, if there has ever been one. */
  readonly lastSuccessAt: Date | undefined;
  /** Attempts from at least the last 24 hours, in any order. */
  readonly recentAttempts: readonly AttemptSummary[];
}): AttemptDecision {
  const { now, policy, lastSuccessAt, recentAttempts } = input;
  const nowMs = now.getTime();

  if (recentAttempts.some((attempt) => attempt.outcome === "running")) {
    return { attempt: false, reason: "already-running" };
  }

  if (lastSuccessAt) {
    const dueAt = lastSuccessAt.getTime() + policy.minIntervalHours * HOUR_MS;
    if (nowMs < dueAt) {
      return { attempt: false, reason: "not-due", until: new Date(dueAt) };
    }
  }

  if (policy.window && !inWindow(policy.window, now)) {
    return {
      attempt: false,
      reason: "outside-window",
      until: nextWindowStart(policy.window, now),
    };
  }

  // Each unanswered prompt lit up someone's phone for a minute. Ration them.
  const unanswered = recentAttempts
    .filter(
      (attempt) =>
        attempt.failureReason === "device-locked" &&
        attempt.startedAt.getTime() > nowMs - DAY_MS,
    )
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  if (unanswered.length >= policy.maxUnansweredPromptsPerDay) {
    // The budget frees up when the oldest counted prompt ages out.
    const oldestCounted = unanswered[unanswered.length - policy.maxUnansweredPromptsPerDay];
    return {
      attempt: false,
      reason: "prompt-budget-spent",
      ...(oldestCounted && {
        until: new Date(oldestCounted.startedAt.getTime() + DAY_MS),
      }),
    };
  }

  const lastFailure = recentAttempts
    .filter((attempt) => attempt.outcome === "failed" && attempt.finishedAt)
    .map((attempt) => (attempt.finishedAt as Date).getTime())
    .reduce<number | undefined>(
      (latest, at) => (latest === undefined || at > latest ? at : latest),
      undefined,
    );
  if (lastFailure !== undefined) {
    const retryAt = lastFailure + policy.retryAfterMinutes * MINUTE_MS;
    if (nowMs < retryAt) {
      return { attempt: false, reason: "backing-off", until: new Date(retryAt) };
    }
  }

  return { attempt: true };
}

/** Decide whether a reachable device is in a fit state to back up. */
export function deviceReady(
  policy: DevicePolicy,
  status: Pick<DeviceStatus, "battery">,
): ReadinessDecision {
  if (status.battery.externalPowerConnected) return { ready: true };
  if (policy.requireExternalPower) return { ready: false, reason: "on-battery" };
  if (status.battery.levelPercent < policy.minBatteryPercent) {
    return { ready: false, reason: "battery-low" };
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
