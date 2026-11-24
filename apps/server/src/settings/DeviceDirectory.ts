import {
  DeviceSettingsChangeSchema,
  type DeviceSettings,
} from "@pommedonjon/api-contract";
import { z } from "zod";
import {
  layer,
  PolicyOverridesSchema,
  type DeviceConfig,
  type TimeWindow,
} from "../config/config.js";
import { describeIssues } from "../schema/issues.js";
import type { StateStore } from "../state/StateStore.js";

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
const SavedSettingsSchema = z.strictObject({
  name: z.string().min(1).optional(),
  policy: PolicyOverridesSchema.optional(),
});

export type ChangeResult =
  | { readonly ok: true; readonly settings: DeviceSettings }
  | { readonly ok: false; readonly problems: readonly string[] };

/** 420 as "07:00". */
function clockText(minutes: number): string {
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
    dueAfterHours: policy.dueAfterHours,
    trigger: policy.trigger,
    pluggedInWindowMinutes: policy.pluggedInWindowMinutes,
    quietHours: quietHours(policy.window),
    staleAfterHours: policy.staleAfterHours,
  };
}

/**
 * The phones from the config file, with what has been changed from the app
 * laid over them. The file says which phones there are and how to reach
 * them; the app's changes, kept in the database, win over the file for
 * everything the app can change.
 */
export class DeviceDirectory implements DeviceSource {
  readonly #configured: readonly DeviceConfig[];
  readonly #state: Pick<StateStore, "deviceSettings" | "saveDeviceSettings">;
  /** Worked out once and after each change, not on every look. */
  #current: readonly DeviceConfig[];

  constructor(deps: {
    /** The phones as the config file has them. */
    readonly devices: readonly DeviceConfig[];
    readonly state: Pick<StateStore, "deviceSettings" | "saveDeviceSettings">;
  }) {
    this.#configured = deps.devices;
    this.#state = deps.state;
    this.#current = this.#configured.map((device) => this.#resolve(device));
  }

  #resolve(device: DeviceConfig): DeviceConfig {
    const saved = this.#state.deviceSettings(device.id);
    if (saved === undefined) return device;
    const parsed = SavedSettingsSchema.safeParse(saved);
    if (!parsed.success) {
      // Written by a different version, or edited by hand: say so, loudly.
      throw new Error(
        `the state database holds settings for "${device.id}" this version cannot read: ` +
          describeIssues(parsed.error).join("; "),
      );
    }
    return {
      ...device,
      name: parsed.data.name ?? device.name,
      policy: layer(device.policy, parsed.data.policy),
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
   * on the screen even if the config file is edited later.
   *
   * Undefined for a phone that is not configured.
   */
  change(deviceId: string, wanted: unknown, at: Date): ChangeResult | undefined {
    const configured = this.#configured.find((device) => device.id === deviceId);
    if (!configured) return undefined;
    const parsed = DeviceSettingsChangeSchema.safeParse(wanted);
    if (!parsed.success) return { ok: false, problems: describeIssues(parsed.error) };

    const { name, quietHours: quiet, ...policy } = parsed.data;
    this.#state.saveDeviceSettings(
      deviceId,
      {
        name,
        policy: {
          ...policy,
          // Quiet from 22:00 to 07:00 is: backups allowed from 07:00 to 22:00.
          window: quiet === null ? null : { start: quiet.end, end: quiet.start },
        },
      },
      at,
    );
    this.#current = this.#configured.map((device) => this.#resolve(device));
    const settings = this.settingsOf(deviceId);
    return settings ? { ok: true, settings } : undefined;
  }
}
