import { useSyncExternalStore } from "react";
import { reportAppOpened } from "../api/client";

/**
 * Which of the server's phones this app is running on, if any. The server
 * works that out from where the app's requests come from; the app only
 * has to say when it is opened.
 */
let thisPhone: string | undefined;
const listeners = new Set<() => void>();

function set(deviceId: string | undefined): void {
  if (deviceId === thisPhone) return;
  thisPhone = deviceId;
  for (const listener of listeners) listener();
}

/**
 * Tell the server the app is in front of someone. If this is one of its
 * phones and a backup is wanted, that starts one: see DESIGN.md,
 * "Automatic mode". Never throws: this is a courtesy, not a step anything
 * waits on.
 */
export async function appOpened(): Promise<void> {
  try {
    set((await reportAppOpened()).deviceId ?? undefined);
  } catch {
    // The screens say so themselves when the server cannot be reached.
  }
}

/** The id of the phone this app is running on, once the server has said. */
export function useThisPhone(): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => thisPhone,
    () => undefined,
  );
}

/** This phone first, the rest in the order the server gave them. */
export function thisPhoneFirst<T extends { readonly id: string }>(
  phones: readonly T[],
  thisPhoneId: string | undefined,
): T[] {
  return [...phones].sort(
    (a, b) => Number(b.id === thisPhoneId) - Number(a.id === thisPhoneId),
  );
}
