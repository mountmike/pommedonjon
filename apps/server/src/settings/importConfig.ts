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
 * Nothing is imported if any phone is here already: from then on the
 * database is the only place settings live, and the file is not read.
 * Returns how many phones were brought in.
 */
export function importConfig(
  config: PommedonjonConfig,
  deps: {
    readonly state: Pick<StateStore, "deviceSettings">;
    readonly directory: Pick<DeviceDirectory, "all" | "add">;
    readonly pairRecords: Pick<PairRecordStore, "receive">;
    readonly serverSettings: Pick<ServerSettingsStore, "change">;
    readonly log: Logger;
    readonly clock: () => Date;
    /** Test seam: how a pair record file is read. */
    readonly readFile?: (file: string) => Uint8Array;
  },
): number {
  const { state, directory, pairRecords, serverSettings, log, clock } = deps;
  const read = deps.readFile ?? ((file: string) => readFileSync(file));
  if (directory.all().length > 0) return 0;

  const changed = serverSettings.change({
    discoveryRanges: config.discovery.ranges,
    scanIntervalSeconds: config.discovery.scanIntervalSeconds,
    pollIntervalSeconds: config.pollIntervalSeconds,
  });
  if (!changed.ok) {
    log("warning", "could not bring in the config file's server settings", {
      problems: changed.problems,
    });
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
