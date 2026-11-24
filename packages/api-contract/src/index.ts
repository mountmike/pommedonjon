/**
 * The contract between the pommedonjon server and its app: the shape of
 * every reply, as Zod schemas with their types derived from them. The
 * server builds its replies to these and the app parses what it receives
 * with them, so a mismatch between the two shows up as an error at the
 * boundary and not as a wrong screen.
 *
 * Times are ISO 8601 strings, as they travel in JSON.
 */

import { z } from "zod";

const timestamp = z.iso.datetime();

/** How long the phone waits for its passcode before giving up. */
export const PASSCODE_WINDOW_SECONDS = 60;

/**
 * What a phone can be, as its owner should see it. One at a time; the
 * order here is roughly from "nothing to do" to "needs attention".
 */
export const DeviceStateSchema = z.enum([
  /** The last good backup is recent enough. */
  "backed-up",
  /** A backup is wanted and the service is waiting for a good moment. */
  "due",
  /** A backup is wanted and the phone is not answering at home. Not a fault. */
  "away",
  /** No good backup for too long. */
  "overdue",
  /** A backup is running now; see `run`. */
  "backing-up",
  /** Something only the phone's owner can fix; see `problem`. */
  "needs-you",
  /** Added, and no good backup so far. */
  "never",
]);
export type DeviceState = z.infer<typeof DeviceStateSchema>;

/** Where a running backup has got to. */
export const RunStageSchema = z.enum([
  /** Reaching the phone. */
  "connecting",
  /** The phone is asking for its passcode. */
  "passcode",
  /** Files are being copied. */
  "transferring",
  /** The copy is done and the backup is being checked. */
  "checking",
]);
export type RunStage = z.infer<typeof RunStageSchema>;

export const RunProgressSchema = z.object({
  stage: RunStageSchema,
  startedAt: timestamp,
  /** When the phone began asking for its passcode, while it still is. */
  passcodeSince: timestamp.optional(),
  /** 0 to 100, once the phone has reported any. Not linear in time. */
  percent: z.number().min(0).max(100).optional(),
});
export type RunProgress = z.infer<typeof RunProgressSchema>;

/** Why no backup is starting right now. */
export const WaitingSchema = z.object({
  /**
   * A machine-readable reason, such as "not-due", "on-battery",
   * "waiting-for-plug-in", "backing-off" or "unreachable". New reasons may
   * appear, so this is not a closed list: show unknown ones plainly.
   */
  reason: z.string(),
  /** When that could change, where it is knowable. */
  until: timestamp.optional(),
});
export type Waiting = z.infer<typeof WaitingSchema>;

export const DeviceProblemSchema = z.enum([
  /** Backup encryption is turned off on the phone. */
  "encryption-off",
  /** The phone no longer accepts the pairing. */
  "not-paired",
]);
export type DeviceProblem = z.infer<typeof DeviceProblemSchema>;

export const RunSummarySchema = z.object({
  startedAt: timestamp,
  /** Null while it is still running. */
  finishedAt: timestamp.nullable(),
  outcome: z.enum(["running", "succeeded", "failed"]),
  /** Why it failed, e.g. "device-locked" or "passcode-cancelled". */
  reason: z.string().nullable(),
  /** Whether the phone asked for its passcode during this run. */
  prompted: z.boolean(),
  /** How long the copy took, for a run that succeeded. */
  durationMs: z.number().nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const DeviceSummarySchema = z.object({
  /** Short name used in addresses, e.g. "mike". */
  id: z.string(),
  /** Name to show, e.g. "Mike's iPhone". */
  name: z.string(),
  state: DeviceStateSchema,
  /** When the last good backup finished. Null if there has never been one. */
  lastBackupAt: timestamp.nullable(),
  /** When a backup becomes, or became, wanted. Null if never backed up. */
  dueAt: timestamp.nullable(),
  /** Null while a backup is running, or when nothing is known yet. */
  waiting: WaitingSchema.nullable(),
  /** Set while `state` is "backing-up". */
  run: RunProgressSchema.nullable(),
  /** Set while `state` is "needs-you". */
  problem: DeviceProblemSchema.nullable(),
  /**
   * The most recent backup that has ended, good or bad, so a failure can be
   * explained where the phone is shown. Null if none has ended yet, and
   * when an older server does not say.
   */
  lastAttempt: RunSummarySchema.nullable().default(null),
});
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;

/** `GET /api/devices` */
export const DeviceListSchema = z.object({
  devices: z.array(DeviceSummarySchema),
});
export type DeviceList = z.infer<typeof DeviceListSchema>;

/** `GET /api/devices/<id>` */
export const DeviceDetailSchema = DeviceSummarySchema.extend({
  /** Most recent first. */
  recentRuns: z.array(RunSummarySchema),
});
export type DeviceDetail = z.infer<typeof DeviceDetailSchema>;

/** `POST /api/devices/<id>/backup-now`, when a backup was started (202). */
export const BackupStartedSchema = z.object({
  status: z.literal("started"),
});
export type BackupStarted = z.infer<typeof BackupStartedSchema>;

/** The body of any reply that is not a success. */
export const ApiErrorSchema = z.object({
  /**
   * A machine-readable code, e.g. "unknown-device", "already-running" or
   * "not-found".
   */
  error: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
