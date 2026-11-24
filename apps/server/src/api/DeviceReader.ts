import type { DeviceDetail, DeviceSummary } from "@pommedonjon/api-contract";
import type { PommedonjonConfig } from "../config/config.js";
import type { Daemon } from "../daemon/Daemon.js";
import type { StateStore } from "../state/StateStore.js";
import { describeDevice, describeDeviceDetail, type DeviceFacts } from "./describeDevice.js";

/** How many past runs a phone's detail carries. */
const RECENT_RUNS = 10;

export interface DeviceReader {
  list(): DeviceSummary[];
  /** Undefined for a phone that is not configured. */
  get(deviceId: string): DeviceDetail | undefined;
}

/** Gathers what the config, the run history and the daemon know about each phone. */
export function createDeviceReader(deps: {
  readonly config: Pick<PommedonjonConfig, "devices">;
  readonly state: Pick<StateStore, "lastSuccessAt" | "recentRuns" | "eventsFor">;
  readonly daemon: Pick<Daemon, "waitingFor">;
  readonly clock: () => Date;
}): DeviceReader {
  const { config, state, daemon, clock } = deps;

  function facts(device: PommedonjonConfig["devices"][number]): DeviceFacts {
    const recentRuns = state.recentRuns(device.id, RECENT_RUNS);
    const running = recentRuns.find((run) => run.outcome === "running");
    return {
      device,
      now: clock(),
      lastSuccessAt: state.lastSuccessAt(device.id),
      recentRuns,
      runningEvents: running ? state.eventsFor(running.id) : [],
      waiting: daemon.waitingFor(device.id),
    };
  }

  return {
    list: () => config.devices.map((device) => describeDevice(facts(device))),
    get: (deviceId) => {
      const device = config.devices.find((candidate) => candidate.id === deviceId);
      return device ? describeDeviceDetail(facts(device)) : undefined;
    },
  };
}
