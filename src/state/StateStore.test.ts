import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "./StateStore.js";

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

describe("StateStore alerts", () => {
  it("remembers the latest time each kind of alert went out per device", () => {
    expect(store.lastAlertAt("mike", "stale")).toBeUndefined();
    store.recordAlert("mike", "stale", t("2026-11-24T09:00:00Z"));
    store.recordAlert("mike", "stale", t("2026-11-25T09:00:00Z"));
    store.recordAlert("sam", "stale", t("2026-11-20T09:00:00Z"));
    expect(store.lastAlertAt("mike", "stale")).toEqual(t("2026-11-25T09:00:00Z"));
    expect(store.lastAlertAt("mike", "failing")).toBeUndefined();
  });
});

describe("StateStore on disk", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nightstand-state-"));
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
    expect(() => new StateStore(file)).toThrow(/newer nightstand/);
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
    upgraded.close();

    // Opening it again does not try to upgrade twice.
    new StateStore(file).close();
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
