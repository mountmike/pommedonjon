import type { DeviceDetail, DeviceSettings, DeviceSummary } from "@pommedonjon/api-contract";
import { fetchDevice, fetchDevices, fetchSettings } from "../api/client";
import { useLive } from "./useLive";

const anyBackingUp = (devices: readonly DeviceSummary[]) =>
  devices.some((device) => device.state === "backing-up");

/** Every phone, kept fresh. */
export function useDevices() {
  return useLive<DeviceSummary[]>("devices", () => fetchDevices(), anyBackingUp);
}

/** One phone and its recent backups, kept fresh. */
export function useDevice(deviceId: string) {
  return useLive<DeviceDetail>(
    `device:${deviceId}`,
    () => fetchDevice(deviceId),
    (device) => device.state === "backing-up",
  );
}

/** What can be changed about one phone, kept fresh. */
export function useSettings(deviceId: string) {
  return useLive<DeviceSettings>(
    `settings:${deviceId}`,
    () => fetchSettings(deviceId),
    () => false,
  );
}
