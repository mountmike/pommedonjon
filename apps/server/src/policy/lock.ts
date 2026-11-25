/**
 * Working out, from a series of probes, when a phone was unlocked. A probe
 * only says "locked" or "unlocked" at one moment; a stretch of being
 * unlocked is one moment at which its owner is at the phone, however many
 * probes fall inside it.
 */

/** What one probe found. "unknown": the phone did not say, or did not answer. */
export type LockReading = "locked" | "unlocked" | "unknown";

export type LockState =
  | {
      readonly kind: "unknown";
      /**
       * The stretch of being unlocked that was under way when the phone
       * stopped saying, and when it stopped. Kept so that one missed probe
       * does not turn the same sitting into a second moment.
       */
      readonly interrupted?: { readonly since: Date; readonly lostAt: Date };
    }
  | { readonly kind: "locked" }
  | {
      readonly kind: "unlocked";
      /** When this stretch of being unlocked was first observed. */
      readonly since: Date;
    };

export const INITIAL_LOCK_STATE: LockState = { kind: "unknown" };

/**
 * A phone that has not said for this long has been put down, so finding it
 * unlocked afterwards is a new moment. A shorter gap is a missed probe:
 * the same reasoning, and the same length, as for power.
 */
export const LOCK_GAP_MS = 15 * 60 * 1000;

/** Fold one more probe result into what is known. */
export function observeLock(previous: LockState, reading: LockReading, at: Date): LockState {
  if (reading === "locked") return { kind: "locked" };
  if (reading === "unknown") {
    if (previous.kind === "unlocked") {
      return { kind: "unknown", interrupted: { since: previous.since, lostAt: at } };
    }
    // Still not saying: keep counting from when it first stopped.
    return previous.kind === "unknown" ? previous : { kind: "unknown" };
  }
  // Still the same stretch: its owner has not put the phone down since.
  if (previous.kind === "unlocked") return previous;
  if (
    previous.kind === "unknown" &&
    previous.interrupted &&
    at.getTime() - previous.interrupted.lostAt.getTime() < LOCK_GAP_MS
  ) {
    return { kind: "unlocked", since: previous.interrupted.since };
  }
  return { kind: "unlocked", since: at };
}
