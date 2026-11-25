import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

export type Live<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T; readonly stale: boolean }
  | {
      readonly status: "failed";
      readonly message: string;
      /** The server answered, and said there is no such thing. */
      readonly missing: boolean;
    };

/** Often while a backup is running, so its steps are seen as they happen. */
const BUSY_INTERVAL_MS = 2000;
const IDLE_INTERVAL_MS = 10_000;

/**
 * Something from the server, kept fresh. A failed refresh keeps showing
 * what was last known, marked as stale, instead of blanking the screen.
 *
 * `key` names what is being loaded; a different key starts over.
 */
export function useLive<T>(
  key: string,
  load: () => Promise<T>,
  isBusy: (data: T) => boolean,
): { state: Live<T>; now: Date; refresh: () => void } {
  const [state, setState] = useState<Live<T>>({ status: "loading" });
  const [now, setNow] = useState(() => new Date());
  // The latest of each, so the loop below does not restart when they change.
  const latest = useRef({ load, isBusy });
  useEffect(() => {
    latest.current = { load, isBusy };
  });
  const refreshNow = useRef<() => void>(() => {});
  // A screen that is underneath another is not being read. It stops asking
  // the server, and starts again, at once, when it comes back to the front.
  const focused = useIsFocused();
  const loadedKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!focused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only the newest request may write: an older, slower one is out of date.
    let newest = 0;
    // Coming back to the front keeps what was showing while it is refreshed;
    // only something different to load starts from nothing.
    if (loadedKey.current !== key) setState({ status: "loading" });
    loadedKey.current = key;

    async function refresh() {
      clearTimeout(timer);
      const mine = ++newest;
      let busy = false;
      try {
        const data = await latest.current.load();
        if (stopped || mine !== newest) return;
        busy = latest.current.isBusy(data);
        setState({ status: "ready", data, stale: false });
      } catch (error) {
        if (stopped || mine !== newest) return;
        const known = error instanceof ApiError;
        const message = known ? error.message : "Something went wrong.";
        const missing = known && error.status === 404;
        setState((previous) =>
          previous.status === "ready" && !missing
            ? { ...previous, stale: true }
            : { status: "failed", message, missing },
        );
      }
      setNow(new Date());
      timer = setTimeout(refresh, busy ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS);
    }
    refreshNow.current = () => void refresh();
    void refresh();

    // The countdown and "2 hours ago" move on between refreshes.
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [key, focused]);

  const refresh = useCallback(() => refreshNow.current(), []);
  return { state, now, refresh };
}
