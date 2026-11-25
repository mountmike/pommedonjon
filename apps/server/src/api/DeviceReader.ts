import type { DeviceDetail, DeviceSummary } from "@pommedonjon/api-contract";
import type { DeviceConfig } from "../config/config.js";
import type { Daemon } from "../daemon/Daemon.js";
import type { DeviceSource } from "../settings/DeviceDirectory.js";
import type { StateStore } from "../state/StateStore.js";
import { describeDevice, describeDeviceDetail, type DeviceFacts } from "./describeDevice.js";

/** How many past runs a phone's detail carries: weeks of history, at a backup or two a day. */
const RECENT_RUNS = 50;

export interface DeviceReader {
  list(): DeviceSummary[];
  /** Undefined for a phone that is not configured. */
  get(deviceId: string): DeviceDetail | undefined;
}

/** Gathers what the settings, the run history and the daemon know about each phone. */
export function createDeviceReader(deps: {
  readonly devices: DeviceSource;
  readonly state: Pick<StateStore, "lastSuccessAt" | "recentRuns" | "eventsFor">;
  readonly daemon: Pick<Daemon, "waitingFor" | "requestFor">;
  readonly clock: () => Date;
}): DeviceReader {
  const { devices, state, daemon, clock } = deps;

  function facts(device: DeviceConfig): DeviceFacts {
    const recentRuns = state.recentRuns(device.id, RECENT_RUNS);
    const running = recentRuns.find((run) => run.outcome === "running");
    return {
      device,
      now: clock(),
      lastSuccessAt: state.lastSuccessAt(device.id),
      recentRuns,
      runningEvents: running ? state.eventsFor(running.id) : [],
      waiting: daemon.waitingFor(device.id),
      request: daemon.requestFor(device.id),
    };
  }

  return {
    list: () => devices.all().map((device) => describeDevice(facts(device))),
    get: (deviceId) => {
      const device = devices.get(deviceId);
      return device ? describeDeviceDetail(facts(device)) : undefined;
    },
  };
}
