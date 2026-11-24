import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type DeviceConfig } from "../../src/config/config.js";
import { StateStore } from "../../src/state/StateStore.js";
import { BackupStore } from "../../src/storage/BackupStore.js";
import type { BackupVerification, BackupVerifier } from "../../src/storage/BackupVerifier.js";
import { FAKE_UDID, FakeTransport } from "../support/fakeTransport.js";
import { BackupError } from "../../src/transport/DeviceTransport.js";
import { BackupRunner } from "../../src/runner/BackupRunner.js";

const device: DeviceConfig = {
  id: "mike",
  name: "Mike's iPhone",
  udid: FAKE_UDID,
  host: "10.0.0.7",
  port: undefined,
  pairRecordPath: "/secrets/mike.plist",
  policy: DEFAULT_POLICY,
};

/** Where the caller found the phone; deliberately not the pinned host. */
const HOST = "10.0.0.42";

const GOOD: BackupVerification = {
  ok: true,
  problems: [],
  udid: FAKE_UDID,
  isEncrypted: true,
};

let root: string;
let state: StateStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pommedonjon-runner-"));
  state = new StateStore(":memory:");
});
afterEach(async () => {
  state.close();
  await rm(root, { recursive: true, force: true });
});

function harness(options: { verification?: BackupVerification } = {}) {
  const transport = new FakeTransport();
  const order: string[] = [];
  const verified: string[] = [];

  const verifier: BackupVerifier = {
    verify: (dir) => {
      order.push("verify");
      verified.push(dir);
      return Promise.resolve(options.verification ?? GOOD);
    },
  };
  const store = new BackupStore(root);
  const originalStart = transport.startBackup.bind(transport);
  transport.startBackup = (backupOptions) => {
    order.push("backup");
    return originalStart(backupOptions);
  };

  const logs: { level: string; message: string; fields: unknown }[] = [];
  const runner = new BackupRunner({
    transport,
    store,
    verifier,
    state,
    log: (level, message, fields) => {
      logs.push({ level, message, fields });
    },
    clock: () => new Date("2026-11-24T20:00:00Z"),
  });
  return { runner, transport, store, order, verified, logs };
}

describe("BackupRunner", () => {
  it("backs up, then verifies, and says so in the log", async () => {
    const h = harness();
    h.transport.onBackup = (run) => run.succeed(355_000);

    const report = await h.runner.run(device, HOST);

    expect(h.order).toEqual(["backup", "verify"]);
    expect(report).toEqual({
      runId: report.runId,
      outcome: "succeeded",
      durationMs: 355_000,
    });
    expect(h.logs.map((entry) => entry.message)).toEqual(["backup starting", "backup succeeded"]);
  });

  it("backs up over TCP at the address it was given, into the device's directory", async () => {
    const h = harness();
    await h.runner.run(device, HOST);

    expect(h.transport.backups[0]?.options).toMatchObject({
      udid: FAKE_UDID,
      endpoint: { host: HOST, pairRecordPath: "/secrets/mike.plist" },
      backupRoot: `${root}/mike`,
    });
    expect(h.transport.backups[0]?.options.full).toBeUndefined();
    expect(h.verified).toEqual([`${root}/mike/${FAKE_UDID}`]);
  });

  it("records the run and its events, thinning progress to ten-percent steps", async () => {
    const h = harness();
    h.transport.onBackup = (run) => {
      run.emit(
        { type: "started" },
        { type: "passcode-required" },
        { type: "passcode-dismissed" },
        { type: "progress", percent: 0 },
        { type: "progress", percent: 3 },
        { type: "progress", percent: 9.9 },
        { type: "progress", percent: 10.2 },
        { type: "progress", percent: 99 },
        { type: "progress", percent: 100 },
      );
      run.succeed(1234);
    };

    const report = await h.runner.run(device, HOST);

    expect(state.getRun(report.runId)).toMatchObject({
      outcome: "succeeded",
      prompted: true,
      durationMs: 1234,
    });
    expect(
      state.eventsFor(report.runId).map((e) => [e.type, e.detail["percent"]]),
    ).toEqual([
      ["started", undefined],
      ["passcode-required", undefined],
      ["passcode-dismissed", undefined],
      ["progress", 0],
      ["progress", 10.2],
      ["progress", 99],
      ["progress", 100],
    ]);
  });

  it("logs the passcode stage and each recorded progress step as they happen", async () => {
    const h = harness();
    h.transport.onBackup = (run) => {
      run.emit(
        { type: "started" },
        { type: "passcode-required" },
        { type: "passcode-dismissed" },
        { type: "progress", percent: 0 },
        { type: "progress", percent: 4 },
        { type: "progress", percent: 57.1 },
      );
      run.succeed(1234);
    };

    const report = await h.runner.run(device, HOST);

    const live = h.logs.slice(1, -1);
    expect(live.map((entry) => entry.message)).toEqual([
      "waiting for the passcode on the phone",
      "passcode prompt closed",
      "backup progress",
      "backup progress",
    ]);
    expect(live.every((entry) => entry.level === "info")).toBe(true);
    expect(live.at(0)?.fields).toEqual({ device: "mike", runId: report.runId });
    expect(live.at(-1)?.fields).toEqual({ device: "mike", runId: report.runId, percent: 57.1 });
  });

  it("says nothing about a passcode when the phone never asked for one", async () => {
    const h = harness();
    h.transport.onBackup = (run) => {
      run.emit({ type: "started" });
      run.fail(new BackupError("connection refused", "unreachable"));
    };

    await h.runner.run(device, HOST);

    expect(h.logs.map((entry) => entry.message)).toEqual(["backup starting", "backup failed"]);
  });

  it("records an unanswered passcode prompt as device-locked and preserves nothing", async () => {
    const h = harness();
    h.transport.onBackup = (run) => {
      run.emit({ type: "passcode-required" }, { type: "passcode-dismissed" });
      run.fail(new BackupError("Device locked (MBErrorDomain/208)", "device-locked"));
    };

    const report = await h.runner.run(device, HOST);

    expect(report).toMatchObject({
      outcome: "failed",
      reason: "device-locked",
      message: "Device locked (MBErrorDomain/208)",
    });
    expect(h.order).not.toContain("verify");
    expect(await h.store.verified("mike")).toBeUndefined();
    expect(state.getRun(report.runId)).toMatchObject({
      outcome: "failed",
      failureReason: "device-locked",
      prompted: true,
    });
    expect(h.logs.at(-1)).toMatchObject({
      level: "warning",
      message: "backup failed",
      fields: { reason: "device-locked" },
    });
  });

  it("does not preserve a backup that fails verification", async () => {
    const h = harness({
      verification: {
        ok: false,
        problems: ["Manifest.plist is empty", "Manifest.db is missing"],
        udid: undefined,
        isEncrypted: undefined,
      },
    });

    const report = await h.runner.run(device, HOST);

    expect(report).toMatchObject({
      outcome: "failed",
      reason: "verification-failed",
      message:
        "the backup did not verify: Manifest.plist is empty; Manifest.db is missing",
    });
    expect(await h.store.verified("mike")).toBeUndefined();
    expect(state.lastSuccessAt("mike")).toBeUndefined();
  });

  it("does not count a backup that belongs to a different phone", async () => {
    const h = harness({
      verification: { ...GOOD, udid: "00008150-000F0E0D0C0B002E" },
    });
    const report = await h.runner.run(device, HOST);
    expect(report).toMatchObject({ outcome: "failed", reason: "verification-failed" });
    expect(await h.store.verified("mike")).toBeUndefined();
  });

  it("does not count an unencrypted backup", async () => {
    const h = harness({ verification: { ...GOOD, isEncrypted: false } });
    const report = await h.runner.run(device, HOST);
    expect(report).toMatchObject({ outcome: "failed", reason: "verification-failed" });
    expect((report as { message: string }).message).toContain("not encrypted");
    expect(await h.store.verified("mike")).toBeUndefined();
  });

  it("marks the backup verified only after it verifies", async () => {
    const h = harness();
    let duringBackup: unknown = "unset";
    h.transport.onBackup = async (run) => {
      duringBackup = await h.store.verified("mike");
      run.succeed(1000);
    };

    await h.runner.run(device, HOST);

    expect(duringBackup).toBeUndefined();
    expect(await h.store.verified("mike")).toEqual({
      udid: FAKE_UDID,
      verifiedAt: "2026-11-24T20:00:00.000Z",
    });
  });

  it("withdraws an earlier verified mark while a new run is changing the backup", async () => {
    const h = harness();
    await h.runner.run(device, HOST);
    expect(await h.store.verified("mike")).toBeDefined();

    h.transport.onBackup = (run) => {
      run.emit({ type: "passcode-required" }, { type: "passcode-dismissed" });
      run.fail(new BackupError("Device locked (MBErrorDomain/208)", "device-locked"));
    };
    await h.runner.run(device, HOST);

    // The failed run may have left the backup half-updated, so the claim
    // that it is verified must not survive it.
    expect(await h.store.verified("mike")).toBeUndefined();
  });

  it("keeps an earlier verified mark when a run is cancelled before it touches the backup", async () => {
    const h = harness();
    await h.runner.run(device, HOST);
    const before = await h.store.verified("mike");
    const controller = new AbortController();
    controller.abort();

    const report = await h.runner.run(device, HOST, controller.signal);

    expect(report).toMatchObject({ outcome: "failed", reason: "cancelled" });
    expect(await h.store.verified("mike")).toEqual(before);
  });

  it("still counts the backup when only the marker cannot be written", async () => {
    const h = harness();
    h.store.markVerified = () => Promise.reject(new Error("EROFS: read-only file system"));

    const report = await h.runner.run(device, HOST);

    expect(report.outcome).toBe("succeeded");
    expect(state.lastSuccessAt("mike")).toBeDefined();
    expect(h.logs.some((entry) => entry.message === "could not write the verified marker")).toBe(
      true,
    );
  });

  it("stops without starting a backup when already cancelled", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const report = await h.runner.run(device, HOST, controller.signal);
    expect(report).toMatchObject({ outcome: "failed", reason: "cancelled" });
    expect(h.transport.backups).toEqual([]);
  });

  it("cancels a backup in progress when the signal aborts", async () => {
    const h = harness();
    const controller = new AbortController();
    h.transport.onBackup = (run) => {
      run.emit({ type: "started" });
      controller.abort();
    };
    const report = await h.runner.run(device, HOST, controller.signal);
    expect(report).toMatchObject({ outcome: "failed", reason: "cancelled" });
    expect(h.transport.backups[0]?.cancelled).toBe(true);
    expect(state.getRun(report.runId)?.outcome).toBe("failed");
  });

  it("always finishes the run record, even on an unexpected error", async () => {
    const h = harness();
    h.transport.startBackup = () => {
      throw new TypeError("boom");
    };
    const report = await h.runner.run(device, HOST);
    expect(report).toMatchObject({ outcome: "failed", reason: "failed", message: "boom" });
    expect(state.attemptsSince("mike", new Date(0))).toEqual([
      expect.objectContaining({ outcome: "failed" }),
    ]);
  });
});
