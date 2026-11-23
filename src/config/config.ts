import { readFile } from "node:fs/promises";
import path from "node:path";

/** A daily time window in the daemon's local time, e.g. 18:00 to 22:30. */
export interface TimeWindow {
  /** Minutes after midnight, inclusive. */
  readonly startMinutes: number;
  /** Minutes after midnight, exclusive. May be less than start: wraps midnight. */
  readonly endMinutes: number;
}

export interface DevicePolicy {
  /** A backup is due once the last good one is older than this. */
  readonly minIntervalHours: number;
  /**
   * Only start backups inside this window. Starting a backup wakes the phone
   * and shows a passcode prompt, so this should be when its owner is awake.
   */
  readonly window: TimeWindow | undefined;
  /** Only start when the phone is on a charger. */
  readonly requireExternalPower: boolean;
  /** When on battery (and that is allowed), the level needed to start. */
  readonly minBatteryPercent: number;
  /**
   * How many passcode prompts may go unanswered in 24 hours before the
   * service stops asking until the next day.
   */
  readonly maxUnansweredPromptsPerDay: number;
  /** How long to leave the phone alone after any failed attempt. */
  readonly retryAfterMinutes: number;
  /** Raise a stale-backup alert once the last good backup is older than this. */
  readonly staleAfterHours: number;
}

export interface DeviceConfig {
  /** Short name used in paths, logs and commands, e.g. "mike". */
  readonly id: string;
  /** Display name for notifications. */
  readonly name: string;
  readonly udid: string;
  /** Address or resolvable name of the phone on the network. */
  readonly host: string;
  readonly port: number | undefined;
  /** Pair record plist for this phone. A secret: grants full device access. */
  readonly pairRecordPath: string;
  readonly policy: DevicePolicy;
}

export type SnapshotStrategyName = "none" | "copy";

export interface NightstandConfig {
  /** Where backups live: one directory per device id underneath. */
  readonly backupRoot: string;
  /** Where the daemon keeps its SQLite database. */
  readonly stateDir: string;
  /** How often each device is considered for a backup. */
  readonly pollIntervalSeconds: number;
  /** Gap between the heads-up notification and the backup starting. */
  readonly headsUpLeadSeconds: number;
  readonly snapshots: {
    readonly strategy: SnapshotStrategyName;
    /** How many snapshots to keep per device (strategy "copy"). */
    readonly keep: number;
  };
  readonly sidecar: {
    readonly pythonPath: string | undefined;
    readonly scriptPath: string | undefined;
  };
  readonly devices: readonly DeviceConfig[];
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

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

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads fields from one JSON object, naming the full path in every error. */
class Reader {
  readonly #seen = new Set<string>();

  constructor(
    private readonly source: Json,
    private readonly where: string,
  ) {}

  #path(key: string): string {
    return this.where === "" ? key : `${this.where}.${key}`;
  }

  #raw(key: string): unknown {
    this.#seen.add(key);
    return this.source[key];
  }

  string(key: string): string {
    const value = this.#raw(key);
    if (typeof value !== "string" || value.trim() === "") {
      throw new ConfigError(`${this.#path(key)} must be a non-empty string`);
    }
    return value;
  }

  optionalString(key: string): string | undefined {
    return this.#raw(key) === undefined ? undefined : this.string(key);
  }

  number(key: string, fallback: number, range: { min: number; max?: number }): number {
    const value = this.#raw(key);
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ConfigError(`${this.#path(key)} must be a number`);
    }
    if (value < range.min || (range.max !== undefined && value > range.max)) {
      const upper = range.max === undefined ? "" : ` and ${range.max}`;
      throw new ConfigError(
        `${this.#path(key)} must be ${range.max === undefined ? "at least" : "between"} ${range.min}${upper}`,
      );
    }
    return value;
  }

  optionalNumber(key: string, range: { min: number; max?: number }): number | undefined {
    return this.#raw(key) === undefined ? undefined : this.number(key, 0, range);
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.#raw(key);
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
      throw new ConfigError(`${this.#path(key)} must be true or false`);
    }
    return value;
  }

  object(key: string): Reader | undefined {
    const value = this.#raw(key);
    if (value === undefined) return undefined;
    if (!isObject(value)) {
      throw new ConfigError(`${this.#path(key)} must be an object`);
    }
    return new Reader(value, this.#path(key));
  }

  array(key: string): Reader[] {
    const value = this.#raw(key);
    if (!Array.isArray(value)) {
      throw new ConfigError(`${this.#path(key)} must be an array`);
    }
    return value.map((item, index) => {
      if (!isObject(item)) {
        throw new ConfigError(`${this.#path(key)}[${index}] must be an object`);
      }
      return new Reader(item, `${this.#path(key)}[${index}]`);
    });
  }

  raw(key: string): unknown {
    return this.#raw(key);
  }

  /** A misspelt key silently falling back to a default is a trap; refuse it. */
  rejectUnknownKeys(): void {
    for (const key of Object.keys(this.source)) {
      if (!this.#seen.has(key)) {
        throw new ConfigError(`${this.#path(key)} is not a recognised setting`);
      }
    }
  }
}

function parseClock(value: unknown, where: string): number {
  const match = typeof value === "string" ? /^(\d{1,2}):(\d{2})$/.exec(value) : null;
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 23 || minutes > 59) {
    throw new ConfigError(`${where} must be a time like "18:30"`);
  }
  return hours * 60 + minutes;
}

function parseWindow(reader: Reader, fallback: TimeWindow | undefined): TimeWindow | undefined {
  const raw = reader.raw("window");
  if (raw === undefined) return fallback;
  // An explicit null means "any time of day".
  if (raw === null) return undefined;
  const window = reader.object("window");
  if (!window) return fallback;
  const where = "window";
  const startMinutes = parseClock(window.raw("start"), `${where}.start`);
  const endMinutes = parseClock(window.raw("end"), `${where}.end`);
  window.rejectUnknownKeys();
  if (startMinutes === endMinutes) {
    throw new ConfigError(`${where} start and end must differ`);
  }
  return { startMinutes, endMinutes };
}

function parsePolicy(reader: Reader | undefined, base: DevicePolicy): DevicePolicy {
  if (!reader) return base;
  const policy: DevicePolicy = {
    minIntervalHours: reader.number("minIntervalHours", base.minIntervalHours, { min: 1 }),
    window: parseWindow(reader, base.window),
    requireExternalPower: reader.boolean("requireExternalPower", base.requireExternalPower),
    minBatteryPercent: reader.number("minBatteryPercent", base.minBatteryPercent, {
      min: 0,
      max: 100,
    }),
    maxUnansweredPromptsPerDay: reader.number(
      "maxUnansweredPromptsPerDay",
      base.maxUnansweredPromptsPerDay,
      { min: 1 },
    ),
    retryAfterMinutes: reader.number("retryAfterMinutes", base.retryAfterMinutes, { min: 1 }),
    staleAfterHours: reader.number("staleAfterHours", base.staleAfterHours, { min: 1 }),
  };
  reader.rejectUnknownKeys();
  return policy;
}

const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const UDID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$|^[0-9a-f]{40}$/;

/**
 * Validate a parsed config document. Relative paths are resolved against
 * `baseDir`, normally the directory holding the config file.
 */
export function parseConfig(document: unknown, baseDir: string): NightstandConfig {
  if (!isObject(document)) {
    throw new ConfigError("the config must be a JSON object");
  }
  const root = new Reader(document, "");
  const resolve = (p: string) => path.resolve(baseDir, p);

  const defaultPolicy = parsePolicy(root.object("defaultPolicy"), DEFAULT_POLICY);

  const snapshotsReader = root.object("snapshots");
  const strategy = snapshotsReader?.optionalString("strategy") ?? "none";
  if (strategy !== "none" && strategy !== "copy") {
    throw new ConfigError('snapshots.strategy must be "none" or "copy"');
  }
  const keep = snapshotsReader?.number("keep", 7, { min: 1 }) ?? 7;
  snapshotsReader?.rejectUnknownKeys();

  const sidecarReader = root.object("sidecar");
  const pythonPath = sidecarReader?.optionalString("pythonPath");
  const scriptPath = sidecarReader?.optionalString("scriptPath");
  sidecarReader?.rejectUnknownKeys();

  const devices = root.array("devices").map((reader): DeviceConfig => {
    const id = reader.string("id");
    if (!DEVICE_ID.test(id)) {
      throw new ConfigError(
        `device id "${id}" must be lower-case letters, digits and hyphens`,
      );
    }
    const udid = reader.string("udid");
    if (!UDID.test(udid)) {
      throw new ConfigError(`devices "${id}": udid does not look like a device UDID`);
    }
    const device: DeviceConfig = {
      id,
      name: reader.optionalString("name") ?? id,
      udid,
      host: reader.string("host"),
      port: reader.optionalNumber("port", { min: 1, max: 65535 }),
      pairRecordPath: resolve(reader.string("pairRecordPath")),
      policy: parsePolicy(reader.object("policy"), defaultPolicy),
    };
    reader.rejectUnknownKeys();
    return device;
  });

  if (devices.length === 0) {
    throw new ConfigError("devices must list at least one device");
  }
  for (const field of ["id", "udid"] as const) {
    const values = devices.map((device) => device[field]);
    const repeated = values.find((value, index) => values.indexOf(value) !== index);
    if (repeated !== undefined) {
      throw new ConfigError(`two devices share the ${field} "${repeated}"`);
    }
  }

  const config: NightstandConfig = {
    backupRoot: resolve(root.string("backupRoot")),
    stateDir: resolve(root.string("stateDir")),
    pollIntervalSeconds: root.number("pollIntervalSeconds", 120, { min: 10 }),
    headsUpLeadSeconds: root.number("headsUpLeadSeconds", 5, { min: 0, max: 300 }),
    snapshots: { strategy, keep },
    sidecar: {
      pythonPath,
      scriptPath: scriptPath === undefined ? undefined : resolve(scriptPath),
    },
    devices,
  };
  root.rejectUnknownKeys();
  return config;
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
