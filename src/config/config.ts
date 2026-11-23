import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
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
    minIntervalHours: number({ min: 1 }),
    /**
     * Only start backups inside this window; null means any time of day.
     * Starting a backup wakes the phone and shows a passcode prompt, so this
     * should be when its owner is awake.
     */
    window: TimeWindowSchema.nullable(),
    /** Only start when the phone is on a charger. */
    requireExternalPower: flag,
    /** When on battery (and that is allowed), the level needed to start. */
    minBatteryPercent: number({ min: 0, max: 100 }),
    /**
     * How many passcode prompts may go unanswered in 24 hours before the
     * service stops asking until the next day.
     */
    maxUnansweredPromptsPerDay: number({ min: 1 }),
    /** How long to leave the phone alone after any failed attempt. */
    retryAfterMinutes: number({ min: 1 }),
    /** Raise a stale-backup alert once the last good backup is older than this. */
    staleAfterHours: number({ min: 1 }),
  },
  { error: "must be an object" },
);
export type DevicePolicy = Readonly<z.infer<typeof DevicePolicySchema>>;

/** What a config file may say about policy: any subset of the settings. */
const PolicyOverridesSchema = DevicePolicySchema.partial();
type PolicyOverrides = z.infer<typeof PolicyOverridesSchema>;

export const DEFAULT_POLICY: DevicePolicy = {
  minIntervalHours: 20,
  // Waking hours: a prompt outside these would light the phone up at night.
  window: { startMinutes: 7 * 60, endMinutes: 22 * 60 },
  requireExternalPower: true,
  minBatteryPercent: 50,
  maxUnansweredPromptsPerDay: 2,
  retryAfterMinutes: 60,
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
    /** Address or resolvable name of the phone on the network. */
    host: text,
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
     * runs nightstand.
     */
    backupRoot: text,
    /** Where the daemon keeps its SQLite database. */
    stateDir: text,
    /** How often each device is considered for a backup. */
    pollIntervalSeconds: number({ min: 10 }).default(120),
    /** Gap between the heads-up notification and the backup starting. */
    headsUpLeadSeconds: number({ min: 0, max: 300 }).default(5),
    sidecar: z
      .strictObject(
        { pythonPath: text.optional(), scriptPath: text.optional() },
        { error: "must be an object" },
      )
      .prefault({}),
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
export type NightstandConfig = Readonly<
  Omit<ConfigFile, "defaultPolicy" | "devices"> & { devices: readonly DeviceConfig[] }
>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function layer(base: DevicePolicy, overrides: PolicyOverrides | undefined): DevicePolicy {
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
export function parseConfig(document: unknown, baseDir: string): NightstandConfig {
  const parsed = ConfigFileSchema.safeParse(document);
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

export async function loadConfig(file: string): Promise<NightstandConfig> {
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
