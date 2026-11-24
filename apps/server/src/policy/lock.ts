/**
 * Working out, from a series of probes, when a phone was unlocked. A probe
 * only says "locked" or "unlocked" at one moment; a stretch of being
 * unlocked is one moment at which its owner is at the phone, however many
 * probes fall inside it.
 */

/** What one probe found. "unknown": the phone did not say, or did not answer. */
export type LockReading = "locked" | "unlocked" | "unknown";

export type LockState =
  | { readonly kind: "unknown" }
  | { readonly kind: "locked" }
  | {
      readonly kind: "unlocked";
      /** When this stretch of being unlocked was first observed. */
      readonly since: Date;
    };

export const INITIAL_LOCK_STATE: LockState = { kind: "unknown" };

/** Fold one more probe result into what is known. */
export function observeLock(previous: LockState, reading: LockReading, at: Date): LockState {
  if (reading === "unknown") return { kind: "unknown" };
  if (reading === "locked") return { kind: "locked" };
  // Still the same stretch: its owner has not put the phone down since.
  return previous.kind === "unlocked" ? previous : { kind: "unlocked", since: at };
}
