import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/config.js";
import { PairRecordStore } from "../../src/credentials/PairRecordStore.js";
import type { LogLevel } from "../../src/log.js";
import { DeviceDirectory } from "../../src/settings/DeviceDirectory.js";
import { importConfig } from "../../src/settings/importConfig.js";
import { ServerSettingsStore } from "../../src/settings/ServerSettings.js";
import { StateStore } from "../../src/state/StateStore.js";

const NOW = new Date("2026-11-25T08:00:00.000Z");

/** A config file as an earlier version read it. */
const FILE = {
  backupRoot: "/backups",
  stateDir: "/state",
  pollIntervalSeconds: 90,
  discovery: { ranges: ["192.168.1.0/24"], scanIntervalSeconds: 600 },
  api: { port: 8377 },
  defaultPolicy: { dueAfterHours: 44 },
  devices: [
    {
      id: "mike",
      name: "Mike's iPhone",
      udid: "00000000-0000000000000001",
      pairRecordPath: "/run/secrets/mike.plist",
    },
    {
      id: "laurel",
      udid: "00000000-0000000000000002",
      host: "192.168.1.60",
      pairRecordPath: "/run/secrets/laurel.plist",
      policy: { window: { start: "07:00", end: "22:00" }, startOnChargerAfterHours: 0 },
    },
  ],
};

let state: StateStore;
let dir: string;
beforeEach(() => {
  state = new StateStore(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "pommedonjon-import-"));
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function setUp(readFile = (file: string): Uint8Array => Buffer.from(`pair record at ${file}`)) {
  const pairRecords = new PairRecordStore(path.join(dir, "pairings"));
  const directory = new DeviceDirectory({ state, pairRecords });
  const serverSettings = new ServerSettingsStore(state);
  const logs: { level: LogLevel; message: string; fields: unknown }[] = [];
  const run = (document: unknown = FILE) =>
    importConfig(parseConfig(document, "/config"), {
      state,
      directory,
      pairRecords,
      serverSettings,
      log: (level, message, fields) => logs.push({ level, message, fields }),
      clock: () => NOW,
      readFile,
    });
  return { pairRecords, directory, serverSettings, logs, run };
}

describe("importConfig", () => {
  it("brings in the file's phones under the ids they had, with their pair records", () => {
    const h = setUp();
    expect(h.run()).toBe(2);

    expect(h.directory.all().map((device) => [device.id, device.name, device.host])).toEqual([
      ["mike", "Mike's iPhone", undefined],
      ["laurel", "laurel", "192.168.1.60"],
    ]);
    expect(readFileSync(h.pairRecords.pathFor("mike"), "utf8")).toBe(
      "pair record at /run/secrets/mike.plist",
    );
    expect(h.directory.get("mike")?.pairRecordPath).toBe(h.pairRecords.pathFor("mike"));
  });

  it("brings in each phone's policy as the file resolved it", () => {
    const h = setUp();
    h.run();
    expect(h.directory.get("mike")?.policy).toMatchObject({ dueAfterHours: 44, window: null });
    expect(h.directory.get("laurel")?.policy).toMatchObject({
      dueAfterHours: 44,
      startOnChargerAfterHours: 0,
      window: { startMinutes: 7 * 60, endMinutes: 22 * 60 },
    });
  });

  it("brings in the server's settings", () => {
    const h = setUp();
    h.run();
    expect(h.serverSettings.get()).toEqual({
      discoveryRanges: ["192.168.1.0/24"],
      scanIntervalSeconds: 600,
      pollIntervalSeconds: 90,
    });
  });

  it("lets what was already changed in the app win over the file", () => {
    // As an earlier version saved a change made in the app.
    state.saveDeviceSettings("mike", { name: "Mike's phone", policy: { dueAfterHours: 68 } }, NOW);
    const h = setUp();
    h.run();
    expect(h.directory.get("mike")).toMatchObject({
      name: "Mike's phone",
      policy: { dueAfterHours: 68 },
    });
  });

  it("happens once: with phones here already, the file is not read", () => {
    const h = setUp();
    h.run();
    h.directory.remove("laurel");
    expect(h.run({ ...FILE, pollIntervalSeconds: 30 })).toBe(0);
    expect(h.directory.all().map((device) => device.id)).toEqual(["mike"]);
    expect(h.serverSettings.get().pollIntervalSeconds).toBe(90);
  });

  it("does not bring a phone back that was removed in the app, while the old file is still there", () => {
    const h = setUp();
    h.run({ ...FILE, devices: [FILE.devices[0]] });
    h.directory.remove("mike");
    // The service restarts with the file and the pair record still mounted.
    expect(h.run({ ...FILE, devices: [FILE.devices[0]] })).toBe(0);
    expect(h.directory.all()).toEqual([]);
  });

  it("brings in the settings it can when the app's rules will not take one of them", () => {
    const h = setUp();
    // An hour and a half between polls is more than the app allows.
    h.run({ ...FILE, pollIntervalSeconds: 5400 });
    expect(h.serverSettings.get()).toMatchObject({
      discoveryRanges: ["192.168.1.0/24"],
      scanIntervalSeconds: 600,
      pollIntervalSeconds: 120,
    });
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: "warning",
        fields: expect.objectContaining({ setting: "pollIntervalSeconds" }),
      }),
    );
  });

  it("reads a file from before the moments, where a trigger said when to start", () => {
    const h = setUp();
    h.run({
      ...FILE,
      defaultPolicy: { trigger: "plugged-in" },
      devices: [
        { ...FILE.devices[0], policy: { trigger: "on-charger" } },
        { ...FILE.devices[1], policy: {} },
      ],
    });
    expect(h.directory.get("mike")?.policy.startOnChargerAfterHours).toBe(0);
    expect(h.directory.get("laurel")?.policy.startOnChargerAfterHours).toBe(24);
  });

  it("says so in the log, without anything from a pair record", () => {
    const h = setUp();
    h.run();
    expect(h.logs).toContainEqual({
      level: "info",
      message: "brought in the config file's phones and settings; the file is no longer read",
      fields: { phones: 2 },
    });
    expect(JSON.stringify(h.logs)).not.toContain("pair record at");
  });

  it("skips a phone whose pair record cannot be read, and brings in the rest", () => {
    const h = setUp((file) => {
      if (file.includes("mike")) throw new Error("ENOENT");
      return Buffer.from("laurel's");
    });
    expect(h.run()).toBe(1);
    expect(h.directory.all().map((device) => device.id)).toEqual(["laurel"]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: "error", fields: { device: "mike", error: "ENOENT" } }),
    );
  });
});
