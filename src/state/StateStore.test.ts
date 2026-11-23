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
      snapshotPath: "/backups/mike/snapshots/2026-11-24T08-06-00Z",
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
      snapshotPath: "/backups/mike/snapshots/2026-11-24T08-06-00Z",
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
      snapshotPath: undefined,
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
      snapshotPath: undefined,
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
      snapshotPath: undefined,
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
});
