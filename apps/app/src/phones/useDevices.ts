import { useEffect, useState } from "react";
import type { DeviceSummary } from "@pommedonjon/api-contract";
import { ApiError, fetchDevices } from "../api/client";

export type DevicesState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly devices: readonly DeviceSummary[]; readonly stale: boolean }
  | { readonly status: "failed"; readonly message: string };

/** Often while a backup is running, so its steps are seen as they happen. */
const BUSY_INTERVAL_MS = 2000;
const IDLE_INTERVAL_MS = 10_000;

/**
 * The phones, kept fresh. A failed refresh keeps showing what was last
 * known, marked as stale, instead of blanking the screen.
 */
export function useDevices(): { state: DevicesState; now: Date } {
  const [state, setState] = useState<DevicesState>({ status: "loading" });
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      let busy = false;
      try {
        const devices = await fetchDevices();
        if (stopped) return;
        busy = devices.some((device) => device.state === "backing-up");
        setState({ status: "ready", devices, stale: false });
      } catch (error) {
        if (stopped) return;
        const message = error instanceof ApiError ? error.message : "Something went wrong.";
        setState((previous) =>
          previous.status === "ready" ? { ...previous, stale: true } : { status: "failed", message },
        );
      }
      setNow(new Date());
      timer = setTimeout(refresh, busy ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS);
    }
    void refresh();

    // The countdown and "2 hours ago" move on between refreshes.
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, []);

  return { state, now };
}
