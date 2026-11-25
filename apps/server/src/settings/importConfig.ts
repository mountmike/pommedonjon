import { readFileSync } from "node:fs";
import type {
  DevicePolicy,
  PolicyOverridesAsWritten,
  PommedonjonConfig,
} from "../config/config.js";
import type { PairRecordStore } from "../credentials/PairRecordStore.js";
import type { Logger } from "../log.js";
import type { StateStore } from "../state/StateStore.js";
import { clockText, type DeviceDirectory } from "./DeviceDirectory.js";
import type { ServerSettingsStore } from "./ServerSettings.js";

/** Where it is noted that a config file has been brought in. */
const IMPORTED = "imported-config";

/** A resolved policy, back in the notation it is written and saved in. */
function asSaved(policy: DevicePolicy): PolicyOverridesAsWritten {
  const { window, ...rest } = policy;
  return {
    ...rest,
    window:
      window === null
        ? null
        : { start: clockText(window.startMinutes), end: clockText(window.endMinutes) },
  };
}

/**
 * Bring the phones and settings of a config file into the database. Config
 * files are how pommedonjon was set up before the app could do it; this is
 * the way over, and it happens once.
 *
 * It happens once. Nothing is imported if any phone is here already, or if
 * a file has been brought in before: from then on the database is the only
 * place settings live, and the file is not read.
 * Returns how many phones were brought in.
 */
export function importConfig(
  config: PommedonjonConfig,
  deps: {
    readonly state: Pick<StateStore, "deviceSettings" | "serverSetting" | "saveServerSetting">;
    readonly directory: Pick<DeviceDirectory, "all" | "add">;
    readonly pairRecords: Pick<PairRecordStore, "receive">;
    readonly serverSettings: Pick<ServerSettingsStore, "change">;
    readonly log: Logger;
    readonly clock: () => Date;
    /** Test seam: how a pair record file is read. */
    readonly readFile?: (file: string) => Uint8Array;
    /**
     * Bring the file in even if one was brought in before. For someone
     * asking for it by name; the service starting up never does.
     */
    readonly again?: boolean;
  },
): number {
  const { state, directory, pairRecords, serverSettings, log, clock } = deps;
  const read = deps.readFile ?? ((file: string) => readFileSync(file));
  if (directory.all().length > 0) return 0;
  // Once is once. Without this, a phone removed in the app would come back
  // at the next start for as long as the old file stayed mounted.
  if (!deps.again && state.serverSetting(IMPORTED) !== undefined) return 0;
  state.saveServerSetting(IMPORTED, { at: clock().toISOString() });

  // One at a time, so that one the app's rules will not take does not cost
  // the others: a phone with no address cannot be found without its ranges.
  for (const [key, value] of [
    ["discoveryRanges", config.discovery.ranges],
    ["scanIntervalSeconds", config.discovery.scanIntervalSeconds],
    ["pollIntervalSeconds", config.pollIntervalSeconds],
  ] as const) {
    const changed = serverSettings.change({ [key]: value });
    if (!changed.ok) {
      log("warning", "could not bring in one of the config file's server settings", {
        setting: key,
        problems: changed.problems,
      });
    }
  }

  let imported = 0;
  for (const device of config.devices) {
    let received: string;
    try {
      received = pairRecords.receive(read(device.pairRecordPath));
    } catch (error) {
      log("error", "could not bring in a phone from the config file: its pair record cannot be read", {
        device: device.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    // What was already changed from the app for this phone wins over the file.
    const saved = state.deviceSettings(device.id);
    const savedPolicy =
      typeof saved === "object" && saved !== null && "policy" in saved
        ? (saved.policy as PolicyOverridesAsWritten)
        : {};
    const savedName =
      typeof saved === "object" && saved !== null && "name" in saved && typeof saved.name === "string"
        ? saved.name
        : undefined;
    const result = directory.add(
      {
        // The file's id is kept, so backups and history carry on under it.
        id: device.id,
        name: savedName ?? device.name,
        udid: device.udid,
        host: device.host,
        port: device.port,
        receivedPairRecord: received,
        policy: { ...asSaved(device.policy), ...savedPolicy },
      },
      clock(),
    );
    if (result.ok) imported += 1;
    else {
      log("error", "could not bring in a phone from the config file", {
        device: device.id,
        problems: result.problems,
      });
    }
  }
  if (imported > 0) {
    log("info", "brought in the config file's phones and settings; the file is no longer read", {
      phones: imported,
    });
  }
  return imported;
}
