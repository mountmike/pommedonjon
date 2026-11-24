import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { rangeProblem } from "../discovery/ranges.js";
import { describeIssues } from "../schema/issues.js";

// Messages are phrased to follow the setting's path: "<path> must be ...".

const NON_EMPTY = "must be a non-empty string";
const text = z
  .string({ error: NON_EMPTY })
  .refine((value) => value.trim() !== "", { error: NON_EMPTY });

function number(range: { min: number; max?: number }) {
  const error =
    range.max === undefined
      ? `must be at least ${range.min}`
      : `must be between ${range.min} and ${range.max}`;
  const schema = z.number({ error: "must be a number" }).min(range.min, { error });
  return range.max === undefined ? schema : schema.max(range.max, { error });
}

const flag = z.boolean({ error: "must be true or false" });

/** "18:30" as minutes after midnight. */
const clock = z.string({ error: 'must be a time like "18:30"' }).transform((value, ctx) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 23 || minutes > 59) {
    ctx.issues.push({ code: "custom", message: 'must be a time like "18:30"', input: value });
    return z.NEVER;
  }
  return hours * 60 + minutes;
});

/** An IPv4 range in CIDR form, small enough to sweep. */
const range = z.string({ error: 'must be an IPv4 range like "192.168.1.0/24"' }).transform(
  (value, ctx) => {
    const problem = rangeProblem(value);
    if (problem !== undefined) {
      ctx.issues.push({ code: "custom", message: problem, input: value });
      return z.NEVER;
    }
    return value;
  },
);

/** A daily time window in the daemon's local time, e.g. 18:00 to 22:30. */
const TimeWindowSchema = z
  .strictObject({ start: clock, end: clock }, { error: "must be an object" })
  .refine((window) => window.start !== window.end, { error: "start and end must differ" })
  .transform((window) => ({
    /** Minutes after midnight, inclusive. */
    startMinutes: window.start,
    /** Minutes after midnight, exclusive. May be less than start: wraps midnight. */
    endMinutes: window.end,
  }));
export type TimeWindow = Readonly<z.infer<typeof TimeWindowSchema>>;

const DevicePolicySchema = z.strictObject(
  {
    /** A backup is due once the last good one is older than this. */
    dueAfterHours: number({ min: 1 }),
    /**
     * Whether backups start by themselves. False means only when someone
     * asks for one.
     */
    automatic: flag,
    /**
     * The moments at which a wanted backup may start. Every backup needs
     * the passcode typed on the phone, so each is a moment its owner is
     * likely to be holding it. The longer a backup has been wanted, the
     * less choosy the service gets (DESIGN.md, "Automatic mode").
     *
     * In the minutes after the phone goes onto a charger.
     */
    startWhenPluggedIn: flag,
    /** With `startWhenPluggedIn`: how long after going onto power a backup may start. */
    pluggedInWindowMinutes: number({ min: 1 }),
    /**
     * When its owner opens the app on the phone itself: they are certainly
     * holding it. Needs the server to know which phone a request came from.
     */
    startWhenAppOpened: flag,
    /**
     * Once a backup has been wanted for this long: also when the phone is
     * found unlocked. Null means never.
     */
    startWhenUnlockedAfterHours: number({ min: 0 }).nullable(),
    /**
     * Once a backup has been wanted for this long: also any time the phone
     * is on a charger. Null means never; 0 means from the start.
     */
    startOnChargerAfterHours: number({ min: 0 }).nullable(),
    /**
     * Only start backups inside these hours; null means any time of day.
     * Starting a backup wakes the phone and shows a passcode prompt.
     */
    window: TimeWindowSchema.nullable(),
    /**
     * The least time between a passcode prompt that went unanswered and the
     * next one. A fresh moment is needed as well: the plug-in or unlock
     * that led to the unanswered prompt is not used twice.
     */
    retryAfterTimeoutMinutes: number({ min: 1 }),
    /** After this many unanswered prompts in 24 hours, no more are shown that day. */
    maxUnansweredPerDay: number({ min: 1 }),
    /** How long to leave the phone alone after its owner dismissed the prompt. */
    retryAfterCancelMinutes: number({ min: 1 }),
    /** How soon to try again after a run failed for any other reason. */
    retryAfterFailureMinutes: number({ min: 1 }),
    /** Raise a stale-backup alert once the last good backup is older than this. */
    staleAfterHours: number({ min: 1 }),
  },
  { error: "must be an object" },
);
export type DevicePolicy = Readonly<z.infer<typeof DevicePolicySchema>>;

/** What a config file may say about policy: any subset of the settings. */
export const PolicyOverridesSchema = DevicePolicySchema.partial();
export type PolicyOverrides = z.infer<typeof PolicyOverridesSchema>;
/** The same, as it is written in a file or saved: hours as "07:00", not minutes. */
export type PolicyOverridesAsWritten = z.input<typeof PolicyOverridesSchema>;

export const DEFAULT_POLICY: DevicePolicy = {
  // Not 24: with a daily habit, plugging in ten minutes earlier than
  // yesterday would otherwise skip a day.
  dueAfterHours: 20,
  automatic: true,
  startWhenPluggedIn: true,
  pluggedInWindowMinutes: 30,
  startWhenAppOpened: true,
  // An unlock interrupts someone about to use the phone, so it is held
  // back until the backup has waited a while.
  startWhenUnlockedAfterHours: 4,
  startOnChargerAfterHours: 24,
  window: null,
  retryAfterTimeoutMinutes: 10,
  maxUnansweredPerDay: 3,
  // A cancel is the owner saying "not now", so it buys a much longer pause.
  retryAfterCancelMinutes: 240,
  retryAfterFailureMinutes: 10,
  staleAfterHours: 72,
};

const DeviceEntrySchema = z.strictObject(
  {
    /** Short name used in paths, logs and commands, e.g. "mike". */
    id: text.refine((id) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(id), {
      error: "must be lower-case letters, digits and hyphens",
    }),
    /** Display name for notifications. Defaults to the id. */
    name: text.optional(),
    udid: text.refine((udid) => /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$|^[0-9a-f]{40}$/.test(udid), {
      error: "does not look like a device UDID",
    }),
    /**
     * Pins the phone to one address or resolvable name. Optional: without
     * it the phone is found by discovery. With it, nowhere else is tried.
     */
    host: text.optional(),
    port: number({ min: 1, max: 65535 }).optional(),
    /** Pair record plist for this phone. A secret: grants full device access. */
    pairRecordPath: text,
    policy: PolicyOverridesSchema.optional(),
  },
  { error: "must be an object" },
);

const ConfigFileSchema = z.strictObject(
  {
    /**
     * Where backups live: one directory per device id underneath. Which disk
     * or share is behind it, and keeping history of it, are up to whoever
     * runs pommedonjon.
     */
    backupRoot: text,
    /** Where the daemon keeps its SQLite database. */
    stateDir: text,
    /** How often each device is considered for a backup. */
    pollIntervalSeconds: number({ min: 10 }).default(120),
    sidecar: z
      .strictObject(
        { pythonPath: text.optional(), scriptPath: text.optional() },
        { error: "must be an object" },
      )
      .prefault({}),
    discovery: z
      .strictObject(
        {
          /**
           * The network ranges the phones live on, e.g. ["192.168.1.0/24"].
           * Swept for the lockdown port when a phone is not where it was
           * last reached.
           */
          ranges: z.array(range, { error: "must be an array" }).default([]),
          /** A sweep is not repeated more often than this. */
          scanIntervalSeconds: number({ min: 30 }).default(300),
        },
        { error: "must be an object" },
      )
      .prefault({}),
    /**
     * The HTTP interface, through which a phone can ask to be backed up
     * now. Left out, the daemon does not listen on the network at all.
     *
     * It has no authentication yet: anything that can reach the port can
     * make a phone show its passcode prompt. Publish it only on a network
     * you trust.
     */
    api: z
      .strictObject({ port: number({ min: 1, max: 65535 }) }, { error: "must be an object" })
      .optional(),
    defaultPolicy: PolicyOverridesSchema.optional(),
    devices: z
      .array(DeviceEntrySchema, { error: "must be an array" })
      .min(1, { error: "must list at least one device" }),
  },
  { error: "the config must be a JSON object" },
);
type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** One phone, with its policy fully resolved. */
export type DeviceConfig = Readonly<
  Omit<ConfigFile["devices"][number], "name" | "policy"> & {
    name: string;
    policy: DevicePolicy;
  }
>;

/** The config as the rest of the program sees it: defaults filled in, paths absolute. */
export type PommedonjonConfig = Readonly<
  Omit<ConfigFile, "defaultPolicy" | "devices"> & { devices: readonly DeviceConfig[] }
>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** A policy with some settings replaced: what is left out keeps the base's value. */
export function layer(base: DevicePolicy, overrides: PolicyOverrides | undefined): DevicePolicy {
  // A setting that was left out inherits; an explicit null (window) does not.
  const stated = Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<DevicePolicy>;
  return { ...base, ...stated };
}

/**
 * Validate a parsed config document. Relative paths are resolved against
 * `baseDir`, normally the directory holding the config file. Every problem
 * found is reported, one per line.
 */
/**
 * A policy as an earlier version wrote it, brought up to date. `trigger`
 * became the moments a backup may start at: "on-charger" meant any time on
 * a charger from the start, and "plugged-in" is what the defaults now say.
 */
function modernPolicy(policy: unknown): unknown {
  if (typeof policy !== "object" || policy === null || !("trigger" in policy)) return policy;
  const { trigger, ...rest } = policy as Record<string, unknown>;
  return trigger === "on-charger" && !("startOnChargerAfterHours" in rest)
    ? { ...rest, startOnChargerAfterHours: 0 }
    : rest;
}

/** A config document with every policy in it brought up to date. */
function modernConfig(document: unknown): unknown {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return document;
  const file = document as Record<string, unknown>;
  return {
    ...file,
    ...("defaultPolicy" in file && { defaultPolicy: modernPolicy(file["defaultPolicy"]) }),
    ...(Array.isArray(file["devices"]) && {
      devices: file["devices"].map((device: unknown) =>
        typeof device === "object" && device !== null && "policy" in device
          ? { ...device, policy: modernPolicy((device as Record<string, unknown>)["policy"]) }
          : device,
      ),
    }),
  };
}

export function parseConfig(document: unknown, baseDir: string): PommedonjonConfig {
  const parsed = ConfigFileSchema.safeParse(modernConfig(document));
  if (!parsed.success) {
    throw new ConfigError(describeIssues(parsed.error).join("\n"));
  }
  const { defaultPolicy: overrides, devices: entries, ...rest } = parsed.data;
  const resolve = (p: string) => path.resolve(baseDir, p);
  const defaultPolicy = layer(DEFAULT_POLICY, overrides);

  const devices = entries.map(
    ({ name, policy, ...entry }): DeviceConfig => ({
      ...entry,
      name: name ?? entry.id,
      pairRecordPath: resolve(entry.pairRecordPath),
      policy: layer(defaultPolicy, policy),
    }),
  );
  if (rest.discovery.ranges.length === 0) {
    const unfindable = devices.find((device) => device.host === undefined);
    if (unfindable) {
      throw new ConfigError(
        `devices "${unfindable.id}" has no host, and discovery.ranges is empty, so it could never be found`,
      );
    }
  }
  for (const field of ["id", "udid"] as const) {
    const values = devices.map((device) => device[field]);
    const repeated = values.find((value, index) => values.indexOf(value) !== index);
    if (repeated !== undefined) {
      throw new ConfigError(`two devices share the ${field} "${repeated}"`);
    }
  }

  return {
    ...rest,
    backupRoot: resolve(rest.backupRoot),
    stateDir: resolve(rest.stateDir),
    sidecar: {
      ...rest.sidecar,
      ...(rest.sidecar.scriptPath !== undefined && {
        scriptPath: resolve(rest.sidecar.scriptPath),
      }),
    },
    devices,
  };
}

export async function loadConfig(file: string): Promise<PommedonjonConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new ConfigError(`cannot read config file ${file}`, { cause });
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(`config file ${file} is not valid JSON`, { cause });
  }
  return parseConfig(document, path.dirname(path.resolve(file)));
}
