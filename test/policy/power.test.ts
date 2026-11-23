import { describe, expect, it } from "vitest";
import {
  AWAY_AFTER_MS,
  INITIAL_POWER_STATE,
  observe,
  type PowerReading,
  type PowerState,
} from "../../src/policy/power.js";

const t0 = new Date("2026-11-24T19:00:00Z").getTime();
const minute = (n: number) => new Date(t0 + n * 60_000);

/** Run a series of readings, two minutes apart unless a time is given. */
function after(...readings: (PowerReading | [PowerReading, number])[]): PowerState {
  let state = INITIAL_POWER_STATE;
  let clock = 0;
  for (const entry of readings) {
    const [reading, atMinute] = typeof entry === "string" ? [entry, clock] : entry;
    state = observe(state, reading, minute(atMinute));
    clock = atMinute + 2;
  }
  return state;
}

describe("observe", () => {
  it("sees a plug-in when a phone on battery is next found on power", () => {
    expect(after("on-battery", "on-battery", "on-power")).toEqual({
      kind: "on-power",
      since: minute(4),
      pluggedIn: true,
    });
  });

  it("keeps the moment of plugging in while the phone stays on power", () => {
    expect(after("on-battery", "on-power", "on-power", "on-power")).toEqual({
      kind: "on-power",
      since: minute(2),
      pluggedIn: true,
    });
  });

  it("does not claim a plug-in for a phone already charging when first seen", () => {
    // The service has just started; the phone may have been charging for hours.
    expect(after("on-power", "on-power")).toEqual({
      kind: "on-power",
      since: minute(0),
      pluggedIn: false,
    });
  });

  it("sees a fresh plug-in after the phone is unplugged and plugged back in", () => {
    expect(after("on-power", "on-battery", "on-power")).toEqual({
      kind: "on-power",
      since: minute(4),
      pluggedIn: true,
    });
  });

  it("does not mistake a missed probe for a fresh plug-in", () => {
    // Charging since minute 2; one probe goes unanswered at minute 6.
    expect(after("on-battery", "on-power", "on-power", "unreachable", "on-power")).toEqual({
      kind: "on-power",
      since: minute(2),
      pluggedIn: true,
    });
  });

  it("does not invent a plug-in from a missed probe on a phone already charging at start", () => {
    expect(after("on-power", "unreachable", "unreachable", "on-power")).toEqual({
      kind: "on-power",
      since: minute(0),
      pluggedIn: false,
    });
  });

  it("sees a plug-in when a phone on battery is plugged in during a missed probe", () => {
    expect(after("on-battery", "unreachable", "on-power")).toEqual({
      kind: "on-power",
      since: minute(4),
      pluggedIn: true,
    });
  });

  it("counts coming home onto a charger as a plug-in after a real absence", () => {
    const awayMinutes = AWAY_AFTER_MS / 60_000;
    expect(after("on-power", ["unreachable", 10], ["on-power", 10 + awayMinutes])).toEqual({
      kind: "on-power",
      since: minute(10 + awayMinutes),
      pluggedIn: true,
    });
    // One minute short of that, it is still the same stretch on power.
    expect(after("on-power", ["unreachable", 10], ["on-power", 9 + awayMinutes])).toEqual({
      kind: "on-power",
      since: minute(0),
      pluggedIn: false,
    });
  });

  it("measures an absence from the first failed probe, not the latest", () => {
    const state = after("on-battery", ["unreachable", 2], ["unreachable", 30], ["unreachable", 60]);
    expect(state).toEqual({
      kind: "unreachable",
      since: minute(2),
      before: { kind: "on-battery" },
    });
  });

  it("treats a phone seen on battery as on battery, whatever came before", () => {
    expect(after("on-power", "unreachable", "on-battery")).toEqual({ kind: "on-battery" });
    expect(after("on-battery")).toEqual({ kind: "on-battery" });
  });
});
