/**
 * Working out, from a series of probes, whether a phone has just been
 * plugged in. A probe only says "on power" or "on battery" at one moment;
 * the moment of plugging in has to be inferred from what came before.
 */

/** What one probe found. */
export type PowerReading = "on-power" | "on-battery" | "unreachable";

type Settled =
  /** Nothing observed yet, e.g. the service has just started. */
  | { readonly kind: "unknown" }
  | { readonly kind: "on-battery" }
  | {
      readonly kind: "on-power";
      /** When this stretch on power was first observed. */
      readonly since: Date;
      /**
       * Whether the phone was seen going onto power. False when it was
       * already on power the first time it was observed, in which case
       * nobody knows how long it has been there.
       */
      readonly pluggedIn: boolean;
    };

export type PowerState =
  | Settled
  | {
      readonly kind: "unreachable";
      /** When probes started failing. */
      readonly since: Date;
      /** What was known before they did. */
      readonly before: Settled;
    };

export const INITIAL_POWER_STATE: PowerState = { kind: "unknown" };

/**
 * A phone that has not answered for this long has left, so finding it on
 * power afterwards counts as a fresh plug-in. A shorter gap is a missed
 * probe: the phone has been seen to take seconds to answer while charging.
 */
export const AWAY_AFTER_MS = 15 * 60 * 1000;

/** Fold one more probe result into what is known. */
export function observe(previous: PowerState, reading: PowerReading, at: Date): PowerState {
  if (reading === "on-battery") return { kind: "on-battery" };

  if (reading === "unreachable") {
    return previous.kind === "unreachable"
      ? previous
      : { kind: "unreachable", since: at, before: previous };
  }

  switch (previous.kind) {
    case "on-power":
      return previous;
    case "on-battery":
      return { kind: "on-power", since: at, pluggedIn: true };
    case "unknown":
      return { kind: "on-power", since: at, pluggedIn: false };
    case "unreachable":
      // Back after a real absence: it came home and went onto power.
      if (at.getTime() - previous.since.getTime() >= AWAY_AFTER_MS) {
        return { kind: "on-power", since: at, pluggedIn: true };
      }
      // A missed probe or two: carry on from what was known before.
      return observe(previous.before, reading, at);
  }
}
