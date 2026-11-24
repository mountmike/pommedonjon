import {
  NewDeviceSchema,
  type DeviceCheck,
  type ServerInfo,
  type ServerSettings,
} from "@pommedonjon/api-contract";
import type { PairRecordInspector } from "../credentials/PairRecordInspector.js";
import type { PairRecordStore } from "../credentials/PairRecordStore.js";
import type { Daemon } from "../daemon/Daemon.js";
import type { DeviceLocator } from "../discovery/DeviceLocator.js";
import type { PhoneFinder } from "../discovery/PhoneFinder.js";
import type { Logger } from "../log.js";
import type { DeviceDirectory } from "../settings/DeviceDirectory.js";
import type { ServerSettingsStore } from "../settings/ServerSettings.js";
import type { StateStore } from "../state/StateStore.js";
import { DeviceError } from "../transport/DeviceTransport.js";

/** A pair record is a few kilobytes. Anything far larger is not one. */
const MAX_PAIR_RECORD_BYTES = 64 * 1024;

export type AddOutcome =
  | { readonly outcome: "added"; readonly id: string }
  | { readonly outcome: "invalid"; readonly problems: readonly string[] }
  | { readonly outcome: "already-added" };

export type RemoveOutcome = "removed" | "unknown-device" | "already-running";

export type SettingsOutcome =
  | { readonly ok: true; readonly settings: ServerSettings }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Looking after the phones and the server's settings, as the app asks for it. */
export interface PhoneManager {
  add(wanted: unknown): Promise<AddOutcome>;
  remove(deviceId: string): RemoveOutcome;
  /** Undefined for a phone that is not here; "already-running" mid-backup. */
  check(deviceId: string): Promise<DeviceCheck | "already-running" | undefined>;
  info(): ServerInfo;
  settings(): ServerSettings;
  changeSettings(wanted: unknown): SettingsOutcome;
}

const NOTHING_KNOWN = {
  paired: null,
  encryptionOn: null,
  model: null,
  osVersion: null,
  batteryPercent: null,
  onCharger: null,
  locked: null,
} as const;

function decodeBase64(text: string): Buffer | undefined {
  const tidy = text.replace(/\s+/g, "");
  if (tidy === "" || !/^[A-Za-z0-9+/]*={0,2}$/.test(tidy)) return undefined;
  return Buffer.from(tidy, "base64");
}

export function createPhoneManager(deps: {
  readonly directory: Pick<DeviceDirectory, "all" | "get" | "add" | "remove">;
  readonly pairRecords: Pick<PairRecordStore, "receive" | "discard">;
  readonly inspector: PairRecordInspector;
  readonly locator: Pick<DeviceLocator, "locate">;
  /** Finds a phone from its pair record alone, when it is added without a UDID. */
  readonly finder: PhoneFinder;
  /** Where a phone was found, kept so it is looked for there first. */
  readonly addresses: Pick<StateStore, "rememberAddress">;
  readonly daemon: Pick<Daemon, "devicesChanged" | "isBusy">;
  readonly serverSettings: Pick<ServerSettingsStore, "get" | "change">;
  readonly version: string;
  readonly backupRoot: string;
  readonly log: Logger;
  readonly clock: () => Date;
}): PhoneManager {
  const { directory, pairRecords, inspector, locator, daemon, serverSettings, log, clock } = deps;
  const { finder, addresses } = deps;

  const shownSettings = (): ServerSettings => {
    const { discoveryRanges, pollIntervalSeconds } = serverSettings.get();
    return { discoveryRanges: [...discoveryRanges], pollIntervalSeconds };
  };

  return {
    async add(wanted) {
      const parsed = NewDeviceSchema.safeParse(wanted);
      if (!parsed.success) {
        return { outcome: "invalid", problems: ["a pair record is needed"] };
      }
      const stated = (text: string | undefined) =>
        text === undefined || text.trim() === "" ? undefined : text.trim();
      const host = stated(parsed.data.host);
      let name = stated(parsed.data.name);
      let udid = stated(parsed.data.udid);

      const bytes = decodeBase64(parsed.data.pairRecord);
      if (!bytes) return { outcome: "invalid", problems: ["the pair record could not be read"] };
      if (bytes.length > MAX_PAIR_RECORD_BYTES) {
        return { outcome: "invalid", problems: ["that file is too large to be a pair record"] };
      }
      if (host === undefined && serverSettings.get().discoveryRanges.length === 0) {
        return {
          outcome: "invalid",
          problems: [
            "give the phone's address, or set the network range in the server's settings, so it can be found",
          ],
        };
      }

      const received = pairRecords.receive(bytes);
      let foundAt: string | undefined;
      try {
        const problem = await inspector.problemWith(received);
        if (problem !== undefined) {
          pairRecords.discard(received);
          return { outcome: "invalid", problems: [`that file is not usable: ${problem}`] };
        }
        if (udid === undefined || name === undefined) {
          // The pairing says which phone it is for only to that phone: so
          // find the phone that accepts it, and ask.
          const found = await finder.find(received, host);
          if (!found) {
            pairRecords.discard(received);
            return {
              outcome: "invalid",
              problems: [
                "the phone could not be found to ask its name and identifier: " +
                  "have it at home and awake and try again, or give both yourself",
              ],
            };
          }
          udid ??= found.udid;
          name ??= found.name;
          foundAt = found.host;
        }
      } catch (error) {
        pairRecords.discard(received);
        throw error;
      }

      const result = directory.add({ name, udid, host, receivedPairRecord: received }, clock());
      if (!result.ok) {
        return result.reason === "already-added"
          ? { outcome: "already-added" }
          : { outcome: "invalid", problems: result.problems };
      }
      if (foundAt !== undefined) addresses.rememberAddress(result.device.id, foundAt, clock());
      // Never the pair record, nor anything read from it.
      log("info", "phone added", { device: result.device.id, name: result.device.name });
      daemon.devicesChanged();
      return { outcome: "added", id: result.device.id };
    },

    remove(deviceId) {
      if (!directory.get(deviceId)) return "unknown-device";
      if (daemon.isBusy(deviceId)) return "already-running";
      directory.remove(deviceId);
      log("info", "phone removed", { device: deviceId });
      daemon.devicesChanged();
      return "removed";
    },

    async check(deviceId) {
      const device = directory.get(deviceId);
      if (!device) return undefined;
      // A second connection during a backup is one more thing to go wrong.
      if (daemon.isBusy(deviceId)) return "already-running";
      try {
        const { status } = await locator.locate(device);
        const wrongPhone = status.udid.toLowerCase() !== device.udid.toLowerCase();
        return {
          reachable: true,
          paired: true,
          encryptionOn: status.backupEncryptionEnabled,
          model: status.productType,
          osVersion: status.osVersion,
          batteryPercent: status.battery.levelPercent,
          onCharger: status.battery.externalPowerConnected,
          locked: status.locked ?? null,
          problem: wrongPhone
            ? "wrong-phone"
            : status.backupEncryptionEnabled
              ? null
              : "encryption-off",
        };
      } catch (error) {
        if (!(error instanceof DeviceError)) throw error;
        if (error.reason === "not-paired") {
          return { ...NOTHING_KNOWN, reachable: true, paired: false, problem: "not-paired" };
        }
        return {
          ...NOTHING_KNOWN,
          reachable: false,
          problem: error.reason === "unreachable" ? "unreachable" : "probe-failed",
        };
      }
    },

    info: () => ({
      version: deps.version,
      backupRoot: deps.backupRoot,
      phones: directory.all().length,
    }),

    settings: shownSettings,

    changeSettings(wanted) {
      // Only what the app is shown can be changed through it.
      const allowed: Record<string, unknown> = {};
      if (typeof wanted === "object" && wanted !== null) {
        for (const key of ["discoveryRanges", "pollIntervalSeconds"] as const) {
          const value = (wanted as Record<string, unknown>)[key];
          if (value !== undefined) allowed[key] = value;
        }
      }
      const result = serverSettings.change(allowed);
      if (!result.ok) return result;
      log("info", "server settings changed", { settings: shownSettings() });
      return { ok: true, settings: shownSettings() };
    },
  };
}
