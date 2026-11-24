import {
  DeviceSettingsChangeSchema,
  type DeviceSettings,
} from "@pommedonjon/api-contract";
import { z } from "zod";
import {
  DEFAULT_POLICY,
  layer,
  PolicyOverridesSchema,
  type DeviceConfig,
  type PolicyOverridesAsWritten,
  type TimeWindow,
} from "../config/config.js";
import type { PairRecordStore } from "../credentials/PairRecordStore.js";
import { describeIssues } from "../schema/issues.js";
import type { DeviceRow, StateStore } from "../state/StateStore.js";

/** The phones, as whoever backs them up should see them right now. */
export interface DeviceSource {
  all(): readonly DeviceConfig[];
  /** Undefined for a phone that is not configured. */
  get(deviceId: string): DeviceConfig | undefined;
}

/** A list of phones that never changes: for one-off commands and tests. */
export function fixedDevices(devices: readonly DeviceConfig[]): DeviceSource {
  return {
    all: () => devices,
    get: (deviceId) => devices.find((device) => device.id === deviceId),
  };
}

/**
 * What the app has changed about a phone, as it is kept: in the config
 * file's own notation, so the same rules read both.
 */
const SavedSettingsSchema = z.object({
  policy: PolicyOverridesSchema.optional(),
});

export type ChangeResult =
  | { readonly ok: true; readonly settings: DeviceSettings }
  | { readonly ok: false; readonly problems: readonly string[] };

/** 420 as "07:00". */
export function clockText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * The policy allows backups inside a window; the app speaks of the hours
 * outside it. They are the same thing seen from either side.
 */
function quietHours(window: TimeWindow | null): DeviceSettings["quietHours"] {
  return window === null
    ? null
    : { start: clockText(window.endMinutes), end: clockText(window.startMinutes) };
}

function describe(device: DeviceConfig): DeviceSettings {
  const { policy } = device;
  return {
    name: device.name,
    automatic: policy.automatic,
    dueAfterHours: policy.dueAfterHours,
    startWhenPluggedIn: policy.startWhenPluggedIn,
    pluggedInWindowMinutes: policy.pluggedInWindowMinutes,
    startWhenUnlockedAfterHours: policy.startWhenUnlockedAfterHours,
    startOnChargerAfterHours: policy.startOnChargerAfterHours,
    quietHours: quietHours(policy.window),
    staleAfterHours: policy.staleAfterHours,
  };
}

/** What is needed to add a phone. */
export interface NewPhone {
  /**
   * The short id to give it, where there is a reason to choose: a phone
   * brought in from a config file keeps the id its backups are filed under.
   * Otherwise one is made from the name.
   */
  readonly id?: string | undefined;
  readonly name: string;
  readonly udid: string;
  /** A fixed address or name. Without one the phone is found by discovery. */
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  /** The pair record, as received: see PairRecordStore.receive. */
  readonly receivedPairRecord: string;
  /** The policy to start it on, where that is not the default, as it is saved. */
  readonly policy?: PolicyOverridesAsWritten | undefined;
}

export type AddResult =
  | { readonly ok: true; readonly device: DeviceConfig }
  | {
      readonly ok: false;
      /** "already-added": a phone with this UDID is here already. */
      readonly reason: "invalid" | "already-added";
      readonly problems: readonly string[];
    };

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const UDID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$|^[0-9a-f]{40}$/;

/** "Mike's iPhone" as "mikes-iphone": short, and safe in a path or an address. */
export function idFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28)
    .replace(/-+$/, "");
  return slug === "" ? "phone" : slug;
}

type DirectoryState = Pick<
  StateStore,
  "devices" | "addDevice" | "removeDevice" | "renameDevice" | "deviceSettings" | "saveDeviceSettings"
>;
type DirectoryPairRecords = Pick<PairRecordStore, "pathFor" | "keep" | "discard" | "remove">;

/**
 * The phones: who they are, from the database, with what has been changed
 * about each one's name and schedule laid over the built-in defaults.
 * Phones can be added and removed while the service runs.
 */
export class DeviceDirectory implements DeviceSource {
  readonly #state: DirectoryState;
  readonly #pairRecords: DirectoryPairRecords;
  /** Worked out once and after each change, not on every look. */
  #current: readonly DeviceConfig[];

  constructor(deps: {
    readonly state: DirectoryState;
    readonly pairRecords: DirectoryPairRecords;
  }) {
    this.#state = deps.state;
    this.#pairRecords = deps.pairRecords;
    this.#current = this.#load();
  }

  #load(): DeviceConfig[] {
    return this.#state.devices().map((row) => this.#resolve(row));
  }

  #resolve(row: DeviceRow): DeviceConfig {
    const saved = this.#state.deviceSettings(row.id);
    const parsed = SavedSettingsSchema.safeParse(saved ?? {});
    if (!parsed.success) {
      // Written by a different version, or edited by hand: say so, loudly.
      throw new Error(
        `the state database holds settings for "${row.id}" this version cannot read: ` +
          describeIssues(parsed.error).join("; "),
      );
    }
    return {
      id: row.id,
      name: row.name,
      udid: row.udid,
      host: row.host,
      port: row.port,
      pairRecordPath: this.#pairRecords.pathFor(row.id),
      policy: layer(DEFAULT_POLICY, parsed.data.policy),
    };
  }

  all(): readonly DeviceConfig[] {
    return this.#current;
  }

  get(deviceId: string): DeviceConfig | undefined {
    return this.#current.find((device) => device.id === deviceId);
  }

  /** What the app can change about a phone, as it stands. */
  settingsOf(deviceId: string): DeviceSettings | undefined {
    const device = this.get(deviceId);
    return device ? describe(device) : undefined;
  }

  /**
   * Change a phone's settings to what the app sent. Everything the app can
   * change is saved, changed or not, so the phone keeps what its owner saw
   * on the screen.
   *
   * Undefined for a phone that is not here.
   */
  change(deviceId: string, wanted: unknown, at: Date): ChangeResult | undefined {
    if (!this.get(deviceId)) return undefined;
    const parsed = DeviceSettingsChangeSchema.safeParse(wanted);
    if (!parsed.success) return { ok: false, problems: describeIssues(parsed.error) };

    const { name, quietHours: quiet, ...policy } = parsed.data;
    // What the app does not show (the pauses after a failed try) stays.
    const kept = savedPolicy(this.#state.deviceSettings(deviceId));
    this.#state.renameDevice(deviceId, name);
    this.#state.saveDeviceSettings(
      deviceId,
      {
        policy: {
          ...kept,
          ...policy,
          // Quiet from 22:00 to 07:00 is: backups allowed from 07:00 to 22:00.
          window: quiet === null ? null : { start: quiet.end, end: quiet.start },
        },
      },
      at,
    );
    this.#current = this.#load();
    const settings = this.settingsOf(deviceId);
    return settings ? { ok: true, settings } : undefined;
  }

  /**
   * Add a phone. Its short id is made from its name, and kept if a phone of
   * that name was here before, so its backups carry on where they left off.
   */
  add(phone: NewPhone, at: Date): AddResult {
    const name = phone.name.trim();
    const udid = phone.udid.trim();
    const host = phone.host?.trim() === "" ? undefined : phone.host?.trim();
    const problems: string[] = [];
    if (name === "") problems.push("name must not be empty");
    if (name.length > 60) problems.push("name must be 60 characters or fewer");
    if (!UDID_PATTERN.test(udid)) problems.push("udid does not look like a device UDID");
    if (phone.id !== undefined && !ID_PATTERN.test(phone.id)) {
      problems.push("id must be lower-case letters, digits and hyphens");
    }
    if (phone.id !== undefined && this.get(phone.id)) {
      problems.push(`there is already a phone with the id "${phone.id}"`);
    }
    if (problems.length > 0) {
      this.#pairRecords.discard(phone.receivedPairRecord);
      return { ok: false, reason: "invalid", problems };
    }
    if (this.#current.some((device) => device.udid.toLowerCase() === udid.toLowerCase())) {
      this.#pairRecords.discard(phone.receivedPairRecord);
      return {
        ok: false,
        reason: "already-added",
        problems: ["a phone with this UDID has already been added"],
      };
    }

    const taken = new Set(this.#current.map((device) => device.id));
    const base = phone.id ?? idFromName(name);
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    if (!ID_PATTERN.test(id)) throw new Error(`could not make an id from "${name}"`);

    this.#pairRecords.keep(phone.receivedPairRecord, id);
    try {
      this.#state.addDevice({ id, name, udid, host, port: phone.port }, at);
      if (phone.policy) this.#state.saveDeviceSettings(id, { policy: phone.policy }, at);
    } catch (error) {
      this.#pairRecords.remove(id);
      throw error;
    }
    this.#current = this.#load();
    const device = this.get(id);
    if (!device) throw new Error(`"${id}" was added and cannot be found`);
    return { ok: true, device };
  }

  /**
   * Remove a phone: it is no longer backed up, and its pair record is
   * destroyed. The backups already made stay where they are, and so does
   * the history of its runs. False for a phone that is not here.
   */
  remove(deviceId: string): boolean {
    if (!this.get(deviceId)) return false;
    this.#state.removeDevice(deviceId);
    this.#pairRecords.remove(deviceId);
    this.#current = this.#load();
    return true;
  }
}

/** The policy part of saved settings, in the notation it was saved in. */
function savedPolicy(saved: unknown): Record<string, unknown> {
  if (typeof saved !== "object" || saved === null) return {};
  const policy = (saved as { policy?: unknown }).policy;
  return typeof policy === "object" && policy !== null ? { ...policy } : {};
}
