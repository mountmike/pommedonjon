import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsStore } from "../../src/settings/ServerSettings.js";
import { StateStore } from "../../src/state/StateStore.js";

let state: StateStore;
beforeEach(() => {
  state = new StateStore(":memory:");
});
afterEach(() => {
  state.close();
});

describe("ServerSettingsStore", () => {
  it("starts with the defaults: no ranges, a poll every two minutes", () => {
    expect(new ServerSettingsStore(state).get()).toEqual({
      discoveryRanges: [],
      scanIntervalSeconds: 300,
      pollIntervalSeconds: 120,
    });
  });

  it("changes some settings, leaves the rest, and keeps them across a restart", () => {
    const settings = new ServerSettingsStore(state);
    expect(settings.change({ discoveryRanges: [" 192.168.1.0/24 "] })).toEqual({
      ok: true,
      settings: { ...DEFAULT_SERVER_SETTINGS, discoveryRanges: ["192.168.1.0/24"] },
    });
    expect(new ServerSettingsStore(state).get().discoveryRanges).toEqual(["192.168.1.0/24"]);
    expect(new ServerSettingsStore(state).get().pollIntervalSeconds).toBe(120);
  });

  it.each([
    ["a range that is not one", { discoveryRanges: ["my network"] }, "discoveryRanges[0]"],
    ["a range too large to sweep", { discoveryRanges: ["10.0.0.0/8"] }, "discoveryRanges[0]"],
    ["a poll every second", { pollIntervalSeconds: 1 }, "pollIntervalSeconds must be at least 10"],
    ["a setting that does not exist", { backupRoot: "/elsewhere" }, "backupRoot is not a recognised setting"],
    ["ranges that are not a list", { discoveryRanges: "192.168.1.0/24" }, "discoveryRanges must be a list"],
  ])("refuses %s, says why, and changes nothing", (_what, change, problem) => {
    const settings = new ServerSettingsStore(state);
    const result = settings.change(change);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.problems.join("\n")).toContain(problem);
    expect(settings.get()).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(state.serverSetting("server")).toBeUndefined();
  });

  it("refuses something that is not settings at all", () => {
    expect(new ServerSettingsStore(state).change("faster")).toMatchObject({ ok: false });
    expect(new ServerSettingsStore(state).change(["192.168.1.0/24"])).toMatchObject({ ok: false });
  });

  it("gives a setting added since they were saved its default", () => {
    state.saveServerSetting("server", { discoveryRanges: ["192.168.1.0/24"] });
    expect(new ServerSettingsStore(state).get()).toEqual({
      ...DEFAULT_SERVER_SETTINGS,
      discoveryRanges: ["192.168.1.0/24"],
    });
  });

  it("refuses to start on saved settings it cannot read", () => {
    state.saveServerSetting("server", { pollIntervalSeconds: "often" });
    expect(() => new ServerSettingsStore(state)).toThrow(/server settings this version cannot read/);
  });
});
