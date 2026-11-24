import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeviceSettingsSchema, type DeviceSettings } from "@pommedonjon/api-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/config/config.js";
import { PairRecordStore } from "../../src/credentials/PairRecordStore.js";
import { DeviceDirectory, fixedDevices, idFromName } from "../../src/settings/DeviceDirectory.js";
import { StateStore } from "../../src/state/StateStore.js";

const NOW = new Date("2026-11-25T08:00:00.000Z");
const MIKE_UDID = "00000000-0000000000000001";
const LAUREL_UDID = "00000000-0000000000000002";

/** What the app sends: everything it shows, changed or not. */
const WANTED: DeviceSettings = {
  name: "Mike's phone",
  automatic: true,
  dueAfterHours: 44,
  startWhenPluggedIn: false,
  pluggedInWindowMinutes: 15,
  startWhenAppOpened: false,
  startWhenUnlockedAfterHours: null,
  startOnChargerAfterHours: 0,
  quietHours: { start: "22:00", end: "07:00" },
  staleAfterHours: 120,
};

let state: StateStore;
let dir: string;
let pairRecords: PairRecordStore;
beforeEach(() => {
  state = new StateStore(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "pommedonjon-pairings-"));
  pairRecords = new PairRecordStore(path.join(dir, "pairings"));
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

const directory = () => new DeviceDirectory({ state, pairRecords });
const record = (text = "a pair record") => pairRecords.receive(Buffer.from(text));

/** A directory with Mike's phone, at a fixed address, in it. */
function withMike() {
  const phones = directory();
  const added = phones.add(
    { name: "Mike's iPhone", udid: MIKE_UDID, host: "10.0.0.7", receivedPairRecord: record() },
    NOW,
  );
  if (!added.ok) throw new Error(added.problems.join("; "));
  return phones;
}

describe("idFromName", () => {
  it.each([
    ["Mike's iPhone", "mikes-iphone"],
    ["Laurel’s iPhone 17 Pro", "laurels-iphone-17-pro"],
    ["  Spare  ", "spare"],
    ["Zoë", "zoe"],
    ["📱", "phone"],
    ["A name that goes on for a very long time indeed", "a-name-that-goes-on-for-a-ve"],
  ])("makes %j into %s", (name, id) => {
    expect(idFromName(name)).toBe(id);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
  });
});

describe("DeviceDirectory", () => {
  it("has no phones to begin with", () => {
    expect(directory().all()).toEqual([]);
  });

  it("adds a phone, on the default schedule, with its pair record put away", () => {
    const phones = directory();
    const received = record("secret");
    const added = phones.add(
      { name: " Mike's iPhone ", udid: MIKE_UDID, host: "10.0.0.7", receivedPairRecord: received },
      NOW,
    );
    expect(added).toEqual({
      ok: true,
      device: {
        id: "mikes-iphone",
        name: "Mike's iPhone",
        udid: MIKE_UDID,
        host: "10.0.0.7",
        port: undefined,
        pairRecordPath: pairRecords.pathFor("mikes-iphone"),
        policy: DEFAULT_POLICY,
      },
    });
    expect(phones.get("mikes-iphone")).toEqual(added.ok ? added.device : undefined);
    expect(readFileSync(pairRecords.pathFor("mikes-iphone"), "utf8")).toBe("secret");
    expect(existsSync(received)).toBe(false);
  });

  it("keeps phones across a restart", () => {
    withMike();
    expect(directory().all().map((device) => device.id)).toEqual(["mikes-iphone"]);
  });

  it("gives a second phone of the same name an id of its own", () => {
    const phones = withMike();
    const second = phones.add(
      { name: "Mike's iPhone", udid: LAUREL_UDID, host: "10.0.0.8", receivedPairRecord: record() },
      NOW,
    );
    expect(second).toMatchObject({ ok: true, device: { id: "mikes-iphone-2" } });
  });

  it("uses the id it is given, as a phone from a config file is", () => {
    const added = directory().add(
      { id: "mike", name: "Mike's iPhone", udid: MIKE_UDID, receivedPairRecord: record() },
      NOW,
    );
    expect(added).toMatchObject({ ok: true, device: { id: "mike", host: undefined } });
  });

  it("starts a phone on the policy it is given", () => {
    const added = directory().add(
      {
        name: "Mike's iPhone",
        udid: MIKE_UDID,
        receivedPairRecord: record(),
        policy: { dueAfterHours: 44, window: { start: "07:00", end: "22:00" } },
      },
      NOW,
    );
    expect(added.ok && added.device.policy).toMatchObject({
      dueAfterHours: 44,
      window: { startMinutes: 420, endMinutes: 1320 },
    });
  });

  it("will not add the same phone twice, and throws the second pair record away", () => {
    const phones = withMike();
    const received = record();
    expect(
      phones.add({ name: "Again", udid: MIKE_UDID.toLowerCase(), receivedPairRecord: received }, NOW),
    ).toMatchObject({ ok: false, reason: "already-added" });
    expect(existsSync(received)).toBe(false);
    expect(phones.all()).toHaveLength(1);
  });

  it.each([
    ["no name", { name: "  " }, "name must not be empty"],
    ["a name that goes on and on", { name: "x".repeat(61) }, "name must be 60 characters or fewer"],
    ["something that is not a UDID", { udid: "my phone" }, "udid does not look like a device UDID"],
    ["an id that is not one", { id: "Mike's" }, "id must be lower-case letters, digits and hyphens"],
  ])("refuses a phone with %s, and keeps nothing of it", (_what, change, problem) => {
    const phones = directory();
    const received = record();
    const result = phones.add(
      { name: "Mike's iPhone", udid: MIKE_UDID, receivedPairRecord: received, ...change },
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "invalid", problems: [problem] });
    expect(existsSync(received)).toBe(false);
    expect(phones.all()).toEqual([]);
  });

  it("removes a phone and destroys its pair record, leaving its history", () => {
    const phones = withMike();
    const run = state.startRun("mikes-iphone", NOW);
    state.finishRun(run, NOW, { outcome: "succeeded", durationMs: 1 });
    phones.change("mikes-iphone", WANTED, NOW);

    expect(phones.remove("mikes-iphone")).toBe(true);
    expect(phones.all()).toEqual([]);
    expect(existsSync(pairRecords.pathFor("mikes-iphone"))).toBe(false);
    expect(state.deviceSettings("mikes-iphone")).toBeUndefined();
    expect(state.recentRuns("mikes-iphone", 5)).toHaveLength(1);
    expect(phones.remove("mikes-iphone")).toBe(false);
  });

  it("picks a phone's backups up again when it is added back under the same name", () => {
    const phones = withMike();
    phones.remove("mikes-iphone");
    const again = phones.add(
      { name: "Mike's iPhone", udid: MIKE_UDID, receivedPairRecord: record() },
      NOW,
    );
    expect(again).toMatchObject({ ok: true, device: { id: "mikes-iphone" } });
  });

  it("describes what the app can change about a phone, in the contract's shape", () => {
    const settings = withMike().settingsOf("mikes-iphone");
    expect(settings).toEqual({
      name: "Mike's iPhone",
      automatic: true,
      dueAfterHours: 20,
      startWhenPluggedIn: true,
      pluggedInWindowMinutes: 30,
      startWhenAppOpened: true,
      startWhenUnlockedAfterHours: 4,
      startOnChargerAfterHours: 24,
      quietHours: null,
      staleAfterHours: 72,
    });
    expect(() => DeviceSettingsSchema.parse(settings)).not.toThrow();
    expect(directory().settingsOf("nobody")).toBeUndefined();
  });

  it("changes a phone's name and schedule, and says what they now are", () => {
    const phones = withMike();
    expect(phones.change("mikes-iphone", WANTED, NOW)).toEqual({ ok: true, settings: WANTED });

    expect(phones.get("mikes-iphone")).toMatchObject({
      id: "mikes-iphone",
      name: "Mike's phone",
      udid: MIKE_UDID,
      host: "10.0.0.7",
      policy: {
        ...DEFAULT_POLICY,
        dueAfterHours: 44,
        startWhenPluggedIn: false,
        pluggedInWindowMinutes: 15,
        startWhenAppOpened: false,
        startWhenUnlockedAfterHours: null,
        startOnChargerAfterHours: 0,
        // Quiet from 22:00 to 07:00: backups allowed from 07:00 to 22:00.
        window: { startMinutes: 7 * 60, endMinutes: 22 * 60 },
        staleAfterHours: 120,
      },
    });
    expect(phones.settingsOf("mikes-iphone")).toEqual(WANTED);
  });

  it("keeps the change across a restart", () => {
    withMike().change("mikes-iphone", WANTED, NOW);
    expect(directory().settingsOf("mikes-iphone")).toEqual(WANTED);
  });

  it("keeps what the app does not show when the app saves", () => {
    const phones = directory();
    phones.add(
      {
        name: "Mike's iPhone",
        udid: MIKE_UDID,
        receivedPairRecord: record(),
        policy: { retryAfterCancelMinutes: 60 },
      },
      NOW,
    );
    phones.change("mikes-iphone", WANTED, NOW);
    expect(phones.get("mikes-iphone")?.policy.retryAfterCancelMinutes).toBe(60);
  });

  it("can turn quiet hours off again", () => {
    const phones = withMike();
    phones.change("mikes-iphone", WANTED, NOW);
    phones.change("mikes-iphone", { ...WANTED, quietHours: null }, NOW);
    expect(phones.get("mikes-iphone")?.policy.window).toBeNull();
  });

  it("can switch automatic backups off, with or without moments set", () => {
    const phones = withMike();
    const manual = { ...WANTED, automatic: false, startOnChargerAfterHours: null };
    expect(phones.change("mikes-iphone", manual, NOW)).toMatchObject({ ok: true });
    expect(phones.get("mikes-iphone")?.policy.automatic).toBe(false);
  });

  it.each([
    ["an empty name", { name: "  " }, "name must not be empty"],
    ["a backup every zero hours", { dueAfterHours: 0 }, "dueAfterHours must be at least 1"],
    ["a switch that is neither on nor off", { startWhenPluggedIn: "sometimes" }, "startWhenPluggedIn"],
    [
      "automatic backups with no moment to start at",
      { startOnChargerAfterHours: null },
      "automatic needs at least one moment at which a backup may start",
    ],
    ["quiet hours that are no time at all", { quietHours: { start: "25:00", end: "07:00" } }, "quietHours.start"],
    ["quiet hours that start and end together", { quietHours: { start: "07:00", end: "07:00" } }, "quietHours start and end must differ"],
    ["an overdue warning sooner than the backup is wanted", { staleAfterHours: 44 }, "staleAfterHours must be longer than dueAfterHours"],
  ])("refuses %s, says why, and changes nothing", (_what, change, problem) => {
    const phones = withMike();
    const before = phones.get("mikes-iphone");
    const result = phones.change("mikes-iphone", { ...WANTED, ...change }, NOW);
    expect(result).toMatchObject({ ok: false });
    expect(result && !result.ok ? result.problems.join("\n") : "").toContain(problem);
    expect(phones.get("mikes-iphone")).toEqual(before);
  });

  it("refuses something that is not settings at all", () => {
    const phones = withMike();
    expect(phones.change("mikes-iphone", "back up more", NOW)).toMatchObject({ ok: false });
    expect(phones.change("mikes-iphone", { name: "Mike" }, NOW)).toMatchObject({ ok: false });
  });

  it("has nothing to change for a phone that is not here", () => {
    expect(directory().change("nobody", WANTED, NOW)).toBeUndefined();
    expect(state.deviceSettings("nobody")).toBeUndefined();
  });

  it("refuses to start on saved settings it cannot read, and says which phone", () => {
    withMike();
    state.saveDeviceSettings("mikes-iphone", { policy: { dueAfterHours: "often" } }, NOW);
    expect(() => directory()).toThrow(/settings for "mikes-iphone" this version cannot read/);
  });
});

describe("PairRecordStore", () => {
  it("keeps pair records where only the service can read them", () => {
    const received = pairRecords.receive(Buffer.from("secret"));
    expect(statSync(pairRecords.dir).mode & 0o777).toBe(0o700);
    expect(statSync(received).mode & 0o777).toBe(0o600);

    pairRecords.keep(received, "mike");
    expect(pairRecords.has("mike")).toBe(true);
    expect(statSync(pairRecords.pathFor("mike")).mode & 0o777).toBe(0o600);
    expect(path.dirname(pairRecords.pathFor("mike"))).toBe(pairRecords.dir);
  });

  it("replaces a phone's pair record with a newer one", () => {
    pairRecords.keep(pairRecords.receive(Buffer.from("old")), "mike");
    pairRecords.keep(pairRecords.receive(Buffer.from("new")), "mike");
    expect(readFileSync(pairRecords.pathFor("mike"), "utf8")).toBe("new");
  });

  it("destroys a pair record, and does not mind if there is none", () => {
    pairRecords.keep(pairRecords.receive(Buffer.from("secret")), "mike");
    pairRecords.remove("mike");
    expect(pairRecords.has("mike")).toBe(false);
    expect(() => pairRecords.remove("mike")).not.toThrow();
  });

  it("throws away a received file that turned out not to be wanted", () => {
    const received = pairRecords.receive(Buffer.from("junk"));
    pairRecords.discard(received);
    expect(existsSync(received)).toBe(false);
  });
});

describe("fixedDevices", () => {
  it("is a list of phones that never changes", () => {
    const mike = {
      id: "mike",
      name: "Mike",
      udid: MIKE_UDID,
      host: "10.0.0.7",
      port: undefined,
      pairRecordPath: "/secrets/mike.plist",
      policy: DEFAULT_POLICY,
    };
    const phones = fixedDevices([mike]);
    expect(phones.all()).toEqual([mike]);
    expect(phones.get("mike")).toEqual(mike);
    expect(phones.get("laurel")).toBeUndefined();
  });
});
