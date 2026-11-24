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
  /**
   * The moments that would start a backup, where it is waiting for one:
   * "plugged-in" (just after going onto a charger), "unlocked", "on-charger"
   * (any time on one). Not a closed list.
   */
  moments: z.array(z.string()).optional(),
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

/** A time of day on a 24-hour clock, in the server's time zone: "22:00". */
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * Hours in which no backup is started, because starting one wakes the
 * phone and asks for its passcode. May run past midnight: 22:00 to 07:00.
 */
export const QuietHoursSchema = z.object({ start: timeOfDay, end: timeOfDay });
export type QuietHours = z.infer<typeof QuietHoursSchema>;

/**
 * What can be changed about one phone from the app.
 * `GET /api/devices/<id>/settings`
 */
export const DeviceSettingsSchema = z.object({
  /** Name to show, e.g. "Mike's iPhone". */
  name: z.string(),
  /** Whether backups start by themselves. False: only when asked for. */
  automatic: z.boolean(),
  /** A backup is wanted once the last good one is older than this. */
  dueAfterHours: z.number(),
  /**
   * The moments at which a wanted backup may start; each is a time the
   * phone's owner is likely holding it, because every backup needs the
   * passcode. First: in the minutes after it goes onto a charger.
   */
  startWhenPluggedIn: z.boolean(),
  /** With `startWhenPluggedIn`: how long after going onto a charger. */
  pluggedInWindowMinutes: z.number(),
  /**
   * Once a backup has been wanted this long: also when the phone is found
   * unlocked. Null for never.
   */
  startWhenUnlockedAfterHours: z.number().nullable(),
  /**
   * Once a backup has been wanted this long: also any time the phone is on
   * a charger. Null for never; 0 for from the start.
   */
  startOnChargerAfterHours: z.number().nullable(),
  /** Null for none. */
  quietHours: QuietHoursSchema.nullable(),
  /** The phone is shown as overdue once its last good backup is older than this. */
  staleAfterHours: z.number(),
});
export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>;

/**
 * The same, as the server will accept it: the body of
 * `PUT /api/devices/<id>/settings`. Everything is sent, changed or not.
 */
export const DeviceSettingsChangeSchema = DeviceSettingsSchema.extend({
  name: z
    .string()
    .trim()
    .min(1, { error: "must not be empty" })
    .max(60, { error: "must be 60 characters or fewer" }),
  dueAfterHours: z
    .number()
    .min(1, { error: "must be at least 1" })
    .max(24 * 60, { error: "must be 60 days or less" }),
  pluggedInWindowMinutes: z
    .number()
    .min(1, { error: "must be at least 1" })
    .max(24 * 60, { error: "must be a day or less" }),
  startWhenUnlockedAfterHours: z
    .number()
    .min(0, { error: "must not be negative" })
    .max(24 * 60, { error: "must be 60 days or less" })
    .nullable(),
  startOnChargerAfterHours: z
    .number()
    .min(0, { error: "must not be negative" })
    .max(24 * 60, { error: "must be 60 days or less" })
    .nullable(),
  quietHours: QuietHoursSchema.refine((hours) => hours.start !== hours.end, {
    error: "start and end must differ",
  }).nullable(),
  staleAfterHours: z
    .number()
    .min(1, { error: "must be at least 1" })
    .max(24 * 365, { error: "must be a year or less" }),
})
  .refine((settings) => settings.staleAfterHours > settings.dueAfterHours, {
    path: ["staleAfterHours"],
    error: "must be longer than dueAfterHours",
  })
  .refine(
    (settings) =>
      !settings.automatic ||
      settings.startWhenPluggedIn ||
      settings.startWhenUnlockedAfterHours !== null ||
      settings.startOnChargerAfterHours !== null,
    { path: ["automatic"], error: "needs at least one moment at which a backup may start" },
  );

/**
 * A phone to add: the body of `POST /api/devices`.
 *
 * The pair record is what lets the server talk to the phone. It goes in
 * and never comes back out: no reply carries one.
 */
export const NewDeviceSchema = z.object({
  /**
   * Name to show, e.g. "Mike's iPhone". Left out, the phone's own name is
   * used, which means the server has to find the phone first.
   */
  name: z.string().optional(),
  /**
   * The phone's UDID. Left out, the server finds the phone the pair record
   * belongs to and asks it, so the phone has to be at home.
   */
  udid: z.string().optional(),
  /** A fixed address or name for the phone, if it is not to be found by looking. */
  host: z.string().optional(),
  /** The pair record file's bytes, in base64. */
  pairRecord: z.string(),
});
export type NewDevice = z.infer<typeof NewDeviceSchema>;

/** `POST /api/devices`, when the phone was added (201). */
export const DeviceAddedSchema = z.object({
  /** The short id it was given, for its address in the app and the API. */
  id: z.string(),
});
export type DeviceAdded = z.infer<typeof DeviceAddedSchema>;

/**
 * What a phone said when the server looked for it just now, without
 * starting anything: `POST /api/devices/<id>/check`. Nothing appears on
 * the phone.
 */
export const DeviceCheckSchema = z.object({
  /** Whether the phone answered on the network. */
  reachable: z.boolean(),
  /** Whether it accepted its pairing. Null when it did not answer. */
  paired: z.boolean().nullable(),
  /** Whether its backups are encrypted. Null when that could not be asked. */
  encryptionOn: z.boolean().nullable(),
  /** Apple's model identifier, e.g. "iPhone17,5". */
  model: z.string().nullable(),
  osVersion: z.string().nullable(),
  batteryPercent: z.number().nullable(),
  onCharger: z.boolean().nullable(),
  /** Whether it is locked right now. Null when it did not say. */
  locked: z.boolean().nullable(),
  /**
   * What is in the way of a backup, if anything: "unreachable",
   * "not-paired", "wrong-phone", "encryption-off" or "probe-failed". Not a
   * closed list.
   */
  problem: z.string().nullable(),
});
export type DeviceCheck = z.infer<typeof DeviceCheckSchema>;

/**
 * The settings that belong to the server as a whole.
 * `GET /api/settings`; `PUT /api/settings` takes any subset of them.
 */
export const ServerSettingsSchema = z.object({
  /**
   * The network ranges the phones live on, e.g. ["192.168.1.0/24"]. The
   * server looks through them for a phone that has no fixed address.
   */
  discoveryRanges: z.array(z.string()),
  /** How often each phone is considered for a backup. */
  pollIntervalSeconds: z.number(),
});
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;

/** `GET /api/server`: what this server is. */
export const ServerInfoSchema = z.object({
  /** Which build is running, e.g. "0.3.0 (build 1a2b3c4)". */
  version: z.string(),
  /** Where backups are kept, as the server sees it. */
  backupRoot: z.string(),
  /** How many phones it looks after. */
  phones: z.number(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

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
  /** With "invalid-settings" and "invalid-phone": what is wrong, one sentence each. */
  problems: z.array(z.string()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
