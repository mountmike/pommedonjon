import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../src/state/StateStore.js";

const t = (iso: string) => new Date(iso);

let store: StateStore;
beforeEach(() => {
  store = new StateStore(":memory:");
});
afterEach(() => {
  store.close();
});

describe("StateStore runs", () => {
  it("records a successful run from start to finish", () => {
    const id = store.startRun("mike", t("2026-11-24T08:00:00Z"));
    expect(store.getRun(id)).toMatchObject({
      deviceId: "mike",
      outcome: "running",
      finishedAt: undefined,
      prompted: false,
    });

    store.finishRun(id, t("2026-11-24T08:06:00Z"), {
      outcome: "succeeded",
      durationMs: 355_000,
    });

    expect(store.getRun(id)).toEqual({
      id,
      deviceId: "mike",
      startedAt: t("2026-11-24T08:00:00Z"),
      finishedAt: t("2026-11-24T08:06:00Z"),
      outcome: "succeeded",
      failureReason: undefined,
      message: undefined,
      prompted: false,
      durationMs: 355_000,
    });
  });

  it("records why a run failed", () => {
    const id = store.startRun("mike", t("2026-11-24T08:00:00Z"));
    store.finishRun(id, t("2026-11-24T08:01:00Z"), {
      outcome: "failed",
      reason: "device-locked",
      message: "Device locked (MBErrorDomain/208)",
    });
    expect(store.getRun(id)).toMatchObject({
      outcome: "failed",
      failureReason: "device-locked",
      message: "Device locked (MBErrorDomain/208)",
    });
  });

  it("refuses to finish a run twice", () => {
    const id = store.startRun("mike", t("2026-11-24T08:00:00Z"));
    const result = { outcome: "failed", reason: "failed", message: "x" } as const;
    store.finishRun(id, t("2026-11-24T08:01:00Z"), result);
    expect(() => store.finishRun(id, t("2026-11-24T08:02:00Z"), result)).toThrow(
      /not running/,
    );
  });

  it("keeps events in order and notes when the phone prompted", () => {
    const id = store.startRun("mike", t("2026-11-24T08:00:00Z"));
    store.recordEvent(id, t("2026-11-24T08:00:01Z"), { type: "started" });
    store.recordEvent(id, t("2026-11-24T08:00:04Z"), { type: "passcode-required" });
    store.recordEvent(id, t("2026-11-24T08:00:20Z"), { type: "progress", percent: 12.5 });

    expect(store.eventsFor(id)).toEqual([
      { at: t("2026-11-24T08:00:01Z"), type: "started", detail: {} },
      { at: t("2026-11-24T08:00:04Z"), type: "passcode-required", detail: {} },
      { at: t("2026-11-24T08:00:20Z"), type: "progress", detail: { percent: 12.5 } },
    ]);
    expect(store.getRun(id)?.prompted).toBe(true);
  });

  it("lists a device's runs newest first, without other devices' runs", () => {
    const first = store.startRun("mike", t("2026-11-23T08:00:00Z"));
    store.startRun("sam", t("2026-11-23T09:00:00Z"));
    const third = store.startRun("mike", t("2026-11-24T08:00:00Z"));
    expect(store.recentRuns("mike", 10).map((run) => run.id)).toEqual([third, first]);
    expect(store.recentRuns("mike", 1).map((run) => run.id)).toEqual([third]);
  });
});

describe("StateStore history for the policy", () => {
  it("reports when the last verified backup finished, per device", () => {
    expect(store.lastSuccessAt("mike")).toBeUndefined();

    const ok = store.startRun("mike", t("2026-11-23T20:00:00Z"));
    store.finishRun(ok, t("2026-11-23T20:06:00Z"), {
      outcome: "succeeded",
      durationMs: 1,
    });
    const bad = store.startRun("mike", t("2026-11-24T20:00:00Z"));
    store.finishRun(bad, t("2026-11-24T20:01:00Z"), {
      outcome: "failed",
      reason: "device-locked",
      message: "x",
    });

    expect(store.lastSuccessAt("mike")).toEqual(t("2026-11-23T20:06:00Z"));
    expect(store.lastSuccessAt("sam")).toBeUndefined();
  });

  it("returns attempts since a time, and always includes a run still in progress", () => {
    const old = store.startRun("mike", t("2026-11-20T20:00:00Z"));
    store.finishRun(old, t("2026-11-20T20:01:00Z"), {
      outcome: "failed",
      reason: "unreachable",
      message: "x",
    });
    store.startRun("mike", t("2026-11-22T20:00:00Z")); // never finished
    const recent = store.startRun("mike", t("2026-11-24T19:00:00Z"));
    store.finishRun(recent, t("2026-11-24T19:01:00Z"), {
      outcome: "failed",
      reason: "device-locked",
      message: "x",
    });

    expect(store.attemptsSince("mike", t("2026-11-24T00:00:00Z"))).toEqual([
      {
        startedAt: t("2026-11-22T20:00:00Z"),
        finishedAt: undefined,
        outcome: "running",
        failureReason: undefined,
      },
      {
        startedAt: t("2026-11-24T19:00:00Z"),
        finishedAt: t("2026-11-24T19:01:00Z"),
        outcome: "failed",
        failureReason: "device-locked",
      },
    ]);
  });

  it("closes off runs a stopped daemon left running", () => {
    const id = store.startRun("mike", t("2026-11-24T19:00:00Z"));
    expect(store.failInterruptedRuns(t("2026-11-24T21:00:00Z"))).toBe(1);
    expect(store.getRun(id)).toMatchObject({
      outcome: "failed",
      failureReason: "interrupted",
      finishedAt: t("2026-11-24T21:00:00Z"),
    });
    expect(store.failInterruptedRuns(t("2026-11-24T21:00:01Z"))).toBe(0);
  });
});

describe("StateStore on disk", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pommedonjon-state-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps history across a restart", () => {
    const file = path.join(dir, "state.sqlite");
    const first = new StateStore(file);
    const id = first.startRun("mike", t("2026-11-24T08:00:00Z"));
    first.finishRun(id, t("2026-11-24T08:06:00Z"), {
      outcome: "succeeded",
      durationMs: 1,
    });
    first.close();

    const second = new StateStore(file);
    expect(second.lastSuccessAt("mike")).toEqual(t("2026-11-24T08:06:00Z"));
    second.close();
  });

  it("refuses a database written by a newer version rather than guessing at it", () => {
    const file = path.join(dir, "state.sqlite");
    new StateStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => new StateStore(file)).toThrow(/newer pommedonjon/);
  });

  it("upgrades a database from before snapshots were removed, keeping its history", () => {
    const file = path.join(dir, "state.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE runs (
        id             INTEGER PRIMARY KEY,
        device_id      TEXT    NOT NULL,
        started_at     INTEGER NOT NULL,
        finished_at    INTEGER,
        outcome        TEXT    NOT NULL CHECK (outcome IN ('running', 'succeeded', 'failed')),
        failure_reason TEXT,
        message        TEXT,
        prompted       INTEGER NOT NULL DEFAULT 0,
        snapshot_path  TEXT,
        duration_ms    INTEGER
      ) STRICT;
      CREATE INDEX runs_by_device ON runs (device_id, started_at);
      CREATE TABLE run_events (
        id INTEGER PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        at INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL
      ) STRICT;
      CREATE TABLE alerts (
        device_id TEXT NOT NULL, kind TEXT NOT NULL, sent_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, kind)
      ) STRICT;
      INSERT INTO runs (device_id, started_at, finished_at, outcome, prompted, snapshot_path, duration_ms)
        VALUES ('mike', 1000, 289000, 'succeeded', 1, '/backups/mike/snapshots/x', 288340);
      PRAGMA user_version = 1;
    `);
    raw.close();

    const upgraded = new StateStore(file);
    expect(upgraded.lastSuccessAt("mike")).toEqual(new Date(289000));
    expect(upgraded.recentRuns("mike", 5)).toEqual([
      {
        id: 1,
        deviceId: "mike",
        startedAt: new Date(1000),
        finishedAt: new Date(289000),
        outcome: "succeeded",
        failureReason: undefined,
        message: undefined,
        prompted: true,
        durationMs: 288340,
      },
    ]);
    // And it can be written to in its new shape.
    const id = upgraded.startRun("mike", t("2026-11-24T08:00:00Z"));
    upgraded.finishRun(id, t("2026-11-24T08:06:00Z"), { outcome: "succeeded", durationMs: 1 });

    // The upgrade also brought the tables added since.
    upgraded.rememberAddress("mike", "192.168.1.50", t("2026-11-24T08:00:00Z"));
    expect(upgraded.lastAddress("mike")).toBe("192.168.1.50");
    upgraded.recordDeviceEvent("mike", t("2026-11-24T08:00:00Z"), "power", { to: "on-power" });
    expect(upgraded.deviceEventsSince("mike", new Date(0))).toHaveLength(1);
    upgraded.close();

    // And took away the table for alerts, which are no longer kept.
    const after = new DatabaseSync(file);
    expect(
      after.prepare("SELECT name FROM sqlite_master WHERE name = 'alerts'").all(),
    ).toEqual([]);
    after.close();

    // Opening it again does not try to upgrade twice.
    new StateStore(file).close();
  });

  it("remembers where each phone was last reached, across restarts", () => {
    const file = path.join(dir, "state.sqlite");
    const first = new StateStore(file);
    expect(first.lastAddress("mike")).toBeUndefined();
    first.rememberAddress("mike", "192.168.1.50", t("2026-11-24T08:00:00Z"));
    first.rememberAddress("lolo", "192.168.1.40", t("2026-11-24T08:00:00Z"));
    first.rememberAddress("mike", "192.168.1.77", t("2026-11-25T08:00:00Z"));
    first.close();

    const second = new StateStore(file);
    expect(second.lastAddress("mike")).toBe("192.168.1.77");
    expect(second.lastAddress("lolo")).toBe("192.168.1.40");
    second.close();
  });

  it("keeps what the daemon noticed about each phone, in order, across restarts", () => {
    const file = path.join(dir, "state.sqlite");
    const first = new StateStore(file);
    first.recordDeviceEvent("mike", t("2026-11-24T08:00:00Z"), "power", { to: "on-battery" });
    first.recordDeviceEvent("mike", t("2026-11-24T18:02:00Z"), "power", {
      from: "on-battery",
      to: "on-power",
      sawPlugIn: true,
    });
    first.recordDeviceEvent("lolo", t("2026-11-24T18:05:00Z"), "waiting", { reason: "on-battery" });
    first.recordDeviceEvent("mike", t("2026-11-24T18:02:00Z"), "waiting");
    first.close();

    const second = new StateStore(file);
    expect(second.deviceEventsSince("mike", t("2026-11-24T12:00:00Z"))).toEqual([
      {
        at: t("2026-11-24T18:02:00Z"),
        kind: "power",
        detail: { from: "on-battery", to: "on-power", sawPlugIn: true },
      },
      { at: t("2026-11-24T18:02:00Z"), kind: "waiting", detail: {} },
    ]);
    expect(second.deviceEventsSince("lolo", new Date(0))).toHaveLength(1);
    second.close();
  });

  it("lists runs from a given time on, oldest first", () => {
    const early = store.startRun("mike", t("2026-11-23T08:00:00Z"));
    store.finishRun(early, t("2026-11-23T08:05:00Z"), { outcome: "succeeded", durationMs: 1 });
    const late = store.startRun("mike", t("2026-11-24T18:02:00Z"));
    store.startRun("lolo", t("2026-11-24T18:03:00Z"));

    expect(store.runsSince("mike", t("2026-11-23T00:00:00Z")).map((run) => run.id)).toEqual([
      early,
      late,
    ]);
    expect(store.runsSince("mike", t("2026-11-24T00:00:00Z")).map((run) => run.id)).toEqual([late]);
  });

  it("fails loudly on a row it cannot read, naming what is wrong with it", () => {
    const file = path.join(dir, "state.sqlite");
    const first = new StateStore(file);
    const id = first.startRun("mike", t("2026-11-24T08:00:00Z"));
    first.recordEvent(id, t("2026-11-24T08:00:01Z"), { type: "started" });
    first.close();

    const raw = new DatabaseSync(file);
    raw.exec("UPDATE run_events SET detail = 'not json'");
    raw.close();

    const second = new StateStore(file);
    expect(() => second.eventsFor(id)).toThrow(
      "the state database holds a run event this version cannot read: detail is not a JSON object",
    );
    // Rows that are intact are unaffected.
    expect(second.getRun(id)).toMatchObject({ deviceId: "mike", outcome: "running" });
    second.close();
  });
});

describe("StateStore device settings", () => {
  it("has none for a phone until some are saved", () => {
    expect(store.deviceSettings("mike")).toBeUndefined();
  });

  it("gives back what was saved, and replaces it on the next save", () => {
    store.saveDeviceSettings("mike", { name: "Mike's iPhone" }, t("2026-11-25T08:00:00Z"));
    expect(store.deviceSettings("mike")).toEqual({ name: "Mike's iPhone" });

    store.saveDeviceSettings("mike", { policy: { dueAfterHours: 44 } }, t("2026-11-25T09:00:00Z"));
    expect(store.deviceSettings("mike")).toEqual({ policy: { dueAfterHours: 44 } });
  });

  it("keeps each phone's settings apart", () => {
    store.saveDeviceSettings("mike", { name: "Mike" }, t("2026-11-25T08:00:00Z"));
    expect(store.deviceSettings("laurel")).toBeUndefined();
  });

  it("is added to a database from before settings were kept", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pommedonjon-state-"));
    const file = path.join(dir, "state.sqlite");
    try {
      const first = new StateStore(file);
      first.close();
      // Wind it back to how schema 5 left it.
      const raw = new DatabaseSync(file);
      raw.exec(
        "DROP TABLE device_settings; DROP TABLE devices; DROP TABLE server_settings; PRAGMA user_version = 5;",
      );
      raw.close();

      const upgraded = new StateStore(file);
      upgraded.saveDeviceSettings("mike", { name: "Mike" }, t("2026-11-25T08:00:00Z"));
      expect(upgraded.deviceSettings("mike")).toEqual({ name: "Mike" });
      upgraded.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("StateStore settings from before the moments", () => {
  it("turns a saved trigger into the moments that replaced it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pommedonjon-state-"));
    const file = path.join(dir, "state.sqlite");
    try {
      new StateStore(file).close();
      // Wind it back to schema 6, with settings as that version saved them.
      const raw = new DatabaseSync(file);
      const save = raw.prepare(
        "INSERT INTO device_settings (device_id, settings, updated_at) VALUES (?, ?, 0)",
      );
      save.run("mike", JSON.stringify({ name: "Mike", policy: { trigger: "on-charger", dueAfterHours: 44 } }));
      save.run("laurel", JSON.stringify({ policy: { trigger: "plugged-in" } }));
      save.run("spare", JSON.stringify({ name: "Spare" }));
      raw.exec("DROP TABLE devices; DROP TABLE server_settings; PRAGMA user_version = 6;");
      raw.close();

      const upgraded = new StateStore(file);
      expect(upgraded.deviceSettings("mike")).toEqual({
        name: "Mike",
        policy: { dueAfterHours: 44, startOnChargerAfterHours: 0 },
      });
      expect(upgraded.deviceSettings("laurel")).toEqual({ policy: {} });
      expect(upgraded.deviceSettings("spare")).toEqual({ name: "Spare" });
      upgraded.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("StateStore phones", () => {
  const MIKE = { id: "mike", name: "Mike's iPhone", udid: "00000000-0000000000000001", host: "10.0.0.7", port: undefined };
  const LAUREL = { id: "laurel", name: "Laurel's iPhone", udid: "00000000-0000000000000002", host: undefined, port: 62078 };

  it("keeps phones in the order they were added", () => {
    store.addDevice(MIKE, t("2026-11-25T08:00:00Z"));
    store.addDevice(LAUREL, t("2026-11-25T09:00:00Z"));
    expect(store.devices()).toEqual([
      { ...MIKE, addedAt: t("2026-11-25T08:00:00Z") },
      { ...LAUREL, addedAt: t("2026-11-25T09:00:00Z") },
    ]);
  });

  it("will not hold two phones with one id, or one UDID", () => {
    store.addDevice(MIKE, t("2026-11-25T08:00:00Z"));
    expect(() => store.addDevice({ ...LAUREL, id: "mike" }, t("2026-11-25T09:00:00Z"))).toThrow();
    expect(() => store.addDevice({ ...LAUREL, udid: MIKE.udid }, t("2026-11-25T09:00:00Z"))).toThrow();
  });

  it("renames a phone", () => {
    store.addDevice(MIKE, t("2026-11-25T08:00:00Z"));
    store.renameDevice("mike", "Mike's phone");
    expect(store.devices()[0]?.name).toBe("Mike's phone");
  });

  it("removes a phone with its settings and last address, and keeps its runs", () => {
    store.addDevice(MIKE, t("2026-11-25T08:00:00Z"));
    store.saveDeviceSettings("mike", { policy: {} }, t("2026-11-25T08:00:00Z"));
    store.rememberAddress("mike", "10.0.0.7", t("2026-11-25T08:00:00Z"));
    const run = store.startRun("mike", t("2026-11-25T08:00:00Z"));
    store.finishRun(run, t("2026-11-25T08:05:00Z"), { outcome: "succeeded", durationMs: 1 });

    store.removeDevice("mike");
    expect(store.devices()).toEqual([]);
    expect(store.deviceSettings("mike")).toBeUndefined();
    expect(store.lastAddress("mike")).toBeUndefined();
    expect(store.recentRuns("mike", 5)).toHaveLength(1);
  });

  it("is added to a database from before phones were kept in it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pommedonjon-state-"));
    const file = path.join(dir, "state.sqlite");
    try {
      new StateStore(file).close();
      const raw = new DatabaseSync(file);
      raw.exec("DROP TABLE devices; DROP TABLE server_settings; PRAGMA user_version = 7;");
      raw.close();

      const upgraded = new StateStore(file);
      upgraded.addDevice(MIKE, t("2026-11-25T08:00:00Z"));
      upgraded.saveServerSetting("server", { pollIntervalSeconds: 60 });
      expect(upgraded.devices()).toHaveLength(1);
      upgraded.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("StateStore server settings", () => {
  it("has none until one is saved, then gives back what was saved last", () => {
    expect(store.serverSetting("server")).toBeUndefined();
    store.saveServerSetting("server", { pollIntervalSeconds: 60 });
    store.saveServerSetting("server", { pollIntervalSeconds: 90 });
    expect(store.serverSetting("server")).toEqual({ pollIntervalSeconds: 90 });
  });
});
