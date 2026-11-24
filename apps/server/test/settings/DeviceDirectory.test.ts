import { DeviceSettingsSchema, type DeviceSettings } from "@pommedonjon/api-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type DeviceConfig } from "../../src/config/config.js";
import { DeviceDirectory, fixedDevices } from "../../src/settings/DeviceDirectory.js";
import { StateStore } from "../../src/state/StateStore.js";

const NOW = new Date("2026-11-25T08:00:00.000Z");

const MIKE: DeviceConfig = {
  id: "mike",
  name: "mike",
  udid: "00000000-0000000000000001",
  host: "10.0.0.7",
  port: undefined,
  pairRecordPath: "/secrets/mike.plist",
  policy: DEFAULT_POLICY,
};
const LAUREL: DeviceConfig = { ...MIKE, id: "laurel", name: "Laurel's iPhone", host: "10.0.0.8" };

/** What the app sends: everything it shows, changed or not. */
const WANTED: DeviceSettings = {
  name: "Mike's iPhone",
  dueAfterHours: 44,
  trigger: "on-charger",
  pluggedInWindowMinutes: 15,
  quietHours: { start: "22:00", end: "07:00" },
  staleAfterHours: 120,
};

let state: StateStore;
beforeEach(() => {
  state = new StateStore(":memory:");
});
afterEach(() => {
  state.close();
});

const directory = (devices: readonly DeviceConfig[] = [MIKE, LAUREL]) =>
  new DeviceDirectory({ devices, state });

describe("DeviceDirectory", () => {
  it("gives the phones as the config file has them until the app changes something", () => {
    const phones = directory();
    expect(phones.all()).toEqual([MIKE, LAUREL]);
    expect(phones.get("laurel")).toEqual(LAUREL);
    expect(phones.get("nobody")).toBeUndefined();
  });

  it("describes what the app can change about a phone, in the contract's shape", () => {
    const settings = directory().settingsOf("mike");
    expect(settings).toEqual({
      name: "mike",
      dueAfterHours: 20,
      trigger: "plugged-in",
      pluggedInWindowMinutes: 30,
      quietHours: null,
      staleAfterHours: 72,
    });
    expect(() => DeviceSettingsSchema.parse(settings)).not.toThrow();
    expect(directory().settingsOf("nobody")).toBeUndefined();
  });

  it("shows the hours backups are allowed in as the quiet hours outside them", () => {
    const allowedByDay: DeviceConfig = {
      ...MIKE,
      policy: { ...DEFAULT_POLICY, window: { startMinutes: 7 * 60, endMinutes: 22 * 60 + 30 } },
    };
    expect(directory([allowedByDay]).settingsOf("mike")?.quietHours).toEqual({
      start: "22:30",
      end: "07:00",
    });
  });

  it("changes a phone's name and schedule, and says what they now are", () => {
    const phones = directory();
    expect(phones.change("mike", WANTED, NOW)).toEqual({ ok: true, settings: WANTED });

    expect(phones.get("mike")).toEqual({
      ...MIKE,
      name: "Mike's iPhone",
      policy: {
        ...DEFAULT_POLICY,
        dueAfterHours: 44,
        trigger: "on-charger",
        pluggedInWindowMinutes: 15,
        // Quiet from 22:00 to 07:00: backups allowed from 07:00 to 22:00.
        window: { startMinutes: 7 * 60, endMinutes: 22 * 60 },
        staleAfterHours: 120,
      },
    });
    expect(phones.settingsOf("mike")).toEqual(WANTED);
  });

  it("leaves alone what the app cannot change, and every other phone", () => {
    const phones = directory();
    phones.change("mike", WANTED, NOW);
    const mike = phones.get("mike");
    expect(mike).toMatchObject({ udid: MIKE.udid, host: MIKE.host, pairRecordPath: MIKE.pairRecordPath });
    expect(mike?.policy.retryAfterCancelMinutes).toBe(DEFAULT_POLICY.retryAfterCancelMinutes);
    expect(phones.get("laurel")).toEqual(LAUREL);
  });

  it("keeps the change across a restart", () => {
    directory().change("mike", WANTED, NOW);
    expect(directory().settingsOf("mike")).toEqual(WANTED);
  });

  it("puts the app's change above the config file, even if the file changes later", () => {
    directory().change("mike", WANTED, NOW);
    const edited: DeviceConfig = { ...MIKE, name: "renamed in the file", policy: { ...DEFAULT_POLICY, dueAfterHours: 5 } };
    expect(directory([edited]).settingsOf("mike")).toEqual(WANTED);
  });

  it("can turn quiet hours off again", () => {
    const phones = directory();
    phones.change("mike", WANTED, NOW);
    phones.change("mike", { ...WANTED, quietHours: null }, NOW);
    expect(phones.get("mike")?.policy.window).toBeNull();
  });

  it.each([
    ["an empty name", { name: "  " }, "name must not be empty"],
    ["a backup every zero hours", { dueAfterHours: 0 }, "dueAfterHours must be at least 1"],
    ["a trigger that does not exist", { trigger: "whenever" }, "trigger"],
    ["quiet hours that are no time at all", { quietHours: { start: "25:00", end: "07:00" } }, "quietHours.start"],
    ["quiet hours that start and end together", { quietHours: { start: "07:00", end: "07:00" } }, "quietHours start and end must differ"],
    ["an overdue warning sooner than the backup is wanted", { staleAfterHours: 44 }, "staleAfterHours must be longer than dueAfterHours"],
  ])("refuses %s, says why, and changes nothing", (_what, change, problem) => {
    const phones = directory();
    const result = phones.change("mike", { ...WANTED, ...change }, NOW);
    expect(result).toMatchObject({ ok: false });
    expect(result && !result.ok ? result.problems.join("\n") : "").toContain(problem);
    expect(phones.get("mike")).toEqual(MIKE);
    expect(state.deviceSettings("mike")).toBeUndefined();
  });

  it("refuses something that is not settings at all", () => {
    expect(directory().change("mike", "back up more", NOW)).toMatchObject({ ok: false });
    expect(directory().change("mike", { name: "Mike" }, NOW)).toMatchObject({ ok: false });
  });

  it("has nothing to change for a phone that is not configured", () => {
    expect(directory().change("nobody", WANTED, NOW)).toBeUndefined();
    expect(state.deviceSettings("nobody")).toBeUndefined();
  });

  it("refuses to start on saved settings it cannot read, and says which phone", () => {
    state.saveDeviceSettings("mike", { policy: { dueAfterHours: "often" } }, NOW);
    expect(() => directory()).toThrow(/settings for "mike" this version cannot read/);
  });
});

describe("fixedDevices", () => {
  it("is a list of phones that never changes", () => {
    const phones = fixedDevices([MIKE]);
    expect(phones.all()).toEqual([MIKE]);
    expect(phones.get("mike")).toEqual(MIKE);
    expect(phones.get("laurel")).toBeUndefined();
  });
});
