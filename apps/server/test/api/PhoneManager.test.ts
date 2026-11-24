import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeviceCheckSchema } from "@pommedonjon/api-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPhoneManager } from "../../src/api/PhoneManager.js";
import { PairRecordStore } from "../../src/credentials/PairRecordStore.js";
import type { LogLevel } from "../../src/log.js";
import { DeviceDirectory } from "../../src/settings/DeviceDirectory.js";
import { ServerSettingsStore } from "../../src/settings/ServerSettings.js";
import { StateStore } from "../../src/state/StateStore.js";
import { DeviceError, type DeviceStatus } from "../../src/transport/DeviceTransport.js";
import { fakeStatus } from "../support/fakeTransport.js";

const NOW = new Date("2026-11-25T08:00:00.000Z");
const UDID = "00000000-0000000000000001";
const SECRET = "the pair record's secret contents";
const encoded = (text: string) => Buffer.from(text).toString("base64");

let state: StateStore;
let dir: string;
beforeEach(() => {
  state = new StateStore(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "pommedonjon-manager-"));
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function setUp(
  options: {
    problem?: string;
    located?: DeviceStatus | Error;
    /** The phone the pairing belongs to, if it can be found on the network. */
    findable?: { udid: string; name: string; host: string };
  } = {},
) {
  const pairRecords = new PairRecordStore(path.join(dir, "pairings"));
  const directory = new DeviceDirectory({ state, pairRecords });
  const serverSettings = new ServerSettingsStore(state);
  const logs: { level: LogLevel; message: string; fields: unknown }[] = [];
  const inspected: string[] = [];
  const searched: { file: string; host: string | undefined }[] = [];
  const busy = new Set<string>();
  let changes = 0;
  const manager = createPhoneManager({
    directory,
    pairRecords,
    inspector: {
      problemWith: (file) => {
        inspected.push(file);
        return Promise.resolve(options.problem);
      },
    },
    locator: {
      locate: () => {
        const located = options.located ?? fakeStatus({ udid: UDID });
        return located instanceof Error
          ? Promise.reject(located)
          : Promise.resolve({ host: "10.0.0.7", status: located });
      },
    },
    finder: {
      find: (file, host) => {
        searched.push({ file, host });
        return Promise.resolve(options.findable);
      },
    },
    addresses: state,
    daemon: { devicesChanged: () => void (changes += 1), isBusy: (id) => busy.has(id) },
    serverSettings,
    version: "0.3.0 (build test)",
    backupRoot: "/backups",
    log: (level, message, fields) => logs.push({ level, message, fields }),
    clock: () => NOW,
  });
  const phone = { name: "Mike's iPhone", udid: UDID, host: "10.0.0.7", pairRecord: encoded(SECRET) };
  return {
    manager,
    pairRecords,
    directory,
    serverSettings,
    logs,
    inspected,
    searched,
    busy,
    phone,
    changes: () => changes,
  };
}

/** Whatever is left in the pair record directory. */
const leftBehind = () => {
  const pairings = path.join(dir, "pairings");
  return existsSync(pairings) ? readdirSync(pairings) : [];
};

describe("adding a phone", () => {
  it("adds it, puts its pair record away, and tells the daemon", async () => {
    const h = setUp();
    expect(await h.manager.add(h.phone)).toEqual({ outcome: "added", id: "mikes-iphone" });
    expect(h.directory.get("mikes-iphone")).toMatchObject({ name: "Mike's iPhone", udid: UDID });
    expect(leftBehind()).toEqual(["mikes-iphone.plist"]);
    expect(h.changes()).toBe(1);
  });

  it("looks at the pair record before it keeps it", async () => {
    const h = setUp({ problem: "it is not a pair record: no HostID" });
    expect(await h.manager.add(h.phone)).toEqual({
      outcome: "invalid",
      problems: ["that file is not usable: it is not a pair record: no HostID"],
    });
    expect(h.inspected).toHaveLength(1);
    expect(leftBehind()).toEqual([]);
    expect(h.directory.all()).toEqual([]);
    expect(h.changes()).toBe(0);
  });

  it("never logs the pair record, or anything from it", async () => {
    const h = setUp();
    await h.manager.add(h.phone);
    expect(h.logs).toEqual([
      { level: "info", message: "phone added", fields: { device: "mikes-iphone", name: "Mike's iPhone" } },
    ]);
    expect(JSON.stringify(h.logs)).not.toContain(SECRET);
    expect(JSON.stringify(h.logs)).not.toContain(encoded(SECRET));
  });

  it("needs a way to find the phone: an address, or a network range to look in", async () => {
    const h = setUp();
    const { host: _none, ...noAddress } = h.phone;
    expect(await h.manager.add(noAddress)).toMatchObject({ outcome: "invalid" });
    expect(await h.manager.add({ ...h.phone, host: "  " })).toMatchObject({ outcome: "invalid" });
    expect(leftBehind()).toEqual([]);

    h.serverSettings.change({ discoveryRanges: ["10.0.0.0/24"] });
    expect(await h.manager.add(noAddress)).toMatchObject({ outcome: "added" });
    expect(h.directory.get("mikes-iphone")?.host).toBeUndefined();
  });

  it.each([
    ["nothing at all", null],
    ["no pair record", { name: "Mike", udid: UDID, host: "h" }],
    ["a pair record that is not base64", { name: "Mike", udid: UDID, host: "h", pairRecord: "<plist>" }],
    ["an empty pair record", { name: "Mike", udid: UDID, host: "h", pairRecord: "" }],
    ["a file far too large", { name: "Mike", udid: UDID, host: "h", pairRecord: encoded("x".repeat(70_000)) }],
    ["a UDID that is not one", { name: "Mike", udid: "mine", host: "h", pairRecord: encoded("x") }],
  ])("refuses %s, and keeps nothing", async (_what, wanted) => {
    const h = setUp();
    expect(await h.manager.add(wanted)).toMatchObject({ outcome: "invalid" });
    expect(leftBehind()).toEqual([]);
  });

  it("needs only the pairing when the phone can be found: it asks the phone the rest", async () => {
    const h = setUp({ findable: { udid: UDID, name: "Mike's iPhone", host: "10.0.0.42" } });
    h.serverSettings.change({ discoveryRanges: ["10.0.0.0/24"] });

    expect(await h.manager.add({ pairRecord: encoded(SECRET) })).toEqual({
      outcome: "added",
      id: "mikes-iphone",
    });
    expect(h.directory.get("mikes-iphone")).toMatchObject({
      name: "Mike's iPhone",
      udid: UDID,
      host: undefined,
    });
    expect(h.searched).toHaveLength(1);
    // Where it answered is where it is looked for first from now on.
    expect(state.lastAddress("mikes-iphone")).toBe("10.0.0.42");
  });

  it("keeps a name that was given, and asks the phone only for what is missing", async () => {
    const h = setUp({ findable: { udid: UDID, name: "iPhone", host: "10.0.0.7" } });
    await h.manager.add({ name: "Mike's phone", host: "10.0.0.7", pairRecord: encoded(SECRET) });
    expect(h.directory.all()[0]).toMatchObject({ id: "mikes-phone", name: "Mike's phone", udid: UDID });
    expect(h.searched[0]?.host).toBe("10.0.0.7");
  });

  it("does not go looking when the name and identifier are both given", async () => {
    const h = setUp();
    await h.manager.add(h.phone);
    expect(h.searched).toEqual([]);
  });

  it("says what to do when the phone cannot be found to ask", async () => {
    const h = setUp();
    const result = await h.manager.add({ host: "10.0.0.7", pairRecord: encoded(SECRET) });
    expect(result).toMatchObject({ outcome: "invalid" });
    expect(result.outcome === "invalid" ? result.problems[0] : "").toContain(
      "the phone could not be found",
    );
    expect(leftBehind()).toEqual([]);
    expect(h.directory.all()).toEqual([]);
  });

  it("will not add the same phone twice", async () => {
    const h = setUp();
    await h.manager.add(h.phone);
    expect(await h.manager.add({ ...h.phone, name: "Again" })).toEqual({ outcome: "already-added" });
    expect(leftBehind()).toEqual(["mikes-iphone.plist"]);
  });
});

describe("removing a phone", () => {
  it("removes it, destroys its pair record, and tells the daemon", async () => {
    const h = setUp();
    await h.manager.add(h.phone);
    expect(h.manager.remove("mikes-iphone")).toBe("removed");
    expect(h.directory.all()).toEqual([]);
    expect(leftBehind()).toEqual([]);
    expect(h.changes()).toBe(2);
  });

  it("will not remove a phone in the middle of a backup", async () => {
    const h = setUp();
    await h.manager.add(h.phone);
    h.busy.add("mikes-iphone");
    expect(h.manager.remove("mikes-iphone")).toBe("already-running");
    expect(h.directory.all()).toHaveLength(1);
  });

  it("says so for a phone that is not here", () => {
    expect(setUp().manager.remove("nobody")).toBe("unknown-device");
  });
});

describe("checking a phone", () => {
  const added = async (options: Parameters<typeof setUp>[0] = {}) => {
    const h = setUp(options);
    await h.manager.add(h.phone);
    return h;
  };

  it("says what a phone that is ready reported", async () => {
    const h = await added({ located: fakeStatus({ udid: UDID, locked: true }) });
    const check = await h.manager.check("mikes-iphone");
    expect(check).toEqual({
      reachable: true,
      paired: true,
      encryptionOn: true,
      model: "iPhone17,5",
      osVersion: "26.6.1",
      batteryPercent: 80,
      onCharger: true,
      locked: true,
      problem: null,
    });
    expect(() => DeviceCheckSchema.parse(check)).not.toThrow();
  });

  it.each([
    ["with backup encryption off", fakeStatus({ udid: UDID, backupEncryptionEnabled: false }), { reachable: true, paired: true, problem: "encryption-off" }],
    ["that turns out to be a different phone", fakeStatus({ udid: "00000000-0000000000000009" }), { reachable: true, problem: "wrong-phone" }],
    ["that is not at home", new DeviceError("no answer", "unreachable"), { reachable: false, paired: null, problem: "unreachable" }],
    ["that refuses its pairing", new DeviceError("refused", "not-paired"), { reachable: true, paired: false, problem: "not-paired" }],
    ["that could not be asked", new DeviceError("garbled", "failed"), { reachable: false, problem: "probe-failed" }],
  ])("says what is in the way for a phone %s", async (_what, located, expected) => {
    const h = await added({ located });
    const check = await h.manager.check("mikes-iphone");
    expect(check).toMatchObject(expected);
    expect(() => DeviceCheckSchema.parse(check)).not.toThrow();
  });

  it("leaves a phone alone in the middle of a backup", async () => {
    const h = await added();
    h.busy.add("mikes-iphone");
    expect(await h.manager.check("mikes-iphone")).toBe("already-running");
  });

  it("has nothing to say about a phone that is not here", async () => {
    expect(await setUp().manager.check("nobody")).toBeUndefined();
  });
});

describe("the server's own settings", () => {
  it("says which build this is, where backups go and how many phones there are", async () => {
    const h = setUp();
    await h.manager.add(h.phone);
    expect(h.manager.info()).toEqual({ version: "0.3.0 (build test)", backupRoot: "/backups", phones: 1 });
  });

  it("shows and changes the settings the app is given", () => {
    const h = setUp();
    expect(h.manager.settings()).toEqual({ discoveryRanges: [], pollIntervalSeconds: 120 });
    expect(h.manager.changeSettings({ discoveryRanges: ["192.168.1.0/24"] })).toEqual({
      ok: true,
      settings: { discoveryRanges: ["192.168.1.0/24"], pollIntervalSeconds: 120 },
    });
    expect(h.serverSettings.get().discoveryRanges).toEqual(["192.168.1.0/24"]);
  });

  it("does not let the app change what it is not shown", () => {
    const h = setUp();
    h.manager.changeSettings({ scanIntervalSeconds: 30, discoveryRanges: [] });
    expect(h.serverSettings.get().scanIntervalSeconds).toBe(300);
  });

  it("says what is wrong with settings it will not take", () => {
    const result = setUp().manager.changeSettings({ discoveryRanges: ["everywhere"] });
    expect(result.ok).toBe(false);
  });
});
