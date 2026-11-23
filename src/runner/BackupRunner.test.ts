import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type DeviceConfig } from "../config/config.js";
import type { Notification, Notifier } from "../notify/Notifier.js";
import { StateStore } from "../state/StateStore.js";
import { BackupStore, type SnapshotStrategy } from "../storage/BackupStore.js";
import type { BackupVerification, BackupVerifier } from "../storage/BackupVerifier.js";
import { FAKE_UDID, FakeTransport } from "../testing/fakeTransport.js";
import { BackupError } from "../transport/DeviceTransport.js";
import { BackupRunner } from "./BackupRunner.js";

const device: DeviceConfig = {
  id: "mike",
  name: "Mike's iPhone",
  udid: FAKE_UDID,
  host: "10.0.0.7",
  port: undefined,
  pairRecordPath: "/secrets/mike.plist",
  policy: DEFAULT_POLICY,
};

const GOOD: BackupVerification = {
  ok: true,
  problems: [],
  udid: FAKE_UDID,
  isEncrypted: true,
};

let root: string;
let state: StateStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nightstand-runner-"));
  state = new StateStore(":memory:");
});
afterEach(async () => {
  state.close();
  await rm(root, { recursive: true, force: true });
});

function harness(
  options: {
    verification?: BackupVerification;
    snapshot?: SnapshotStrategy["snapshot"];
    notify?: (n: Notification) => Promise<void>;
  } = {},
) {
  const transport = new FakeTransport();
  const sent: Notification[] = [];
  const order: string[] = [];
  const snapshots: string[] = [];
  const verified: string[] = [];

  const notifier: Notifier = {
    notify: async (n) => {
      order.push(`notify:${n.kind}`);
      await options.notify?.(n);
      sent.push(n);
    },
  };
  const verifier: BackupVerifier = {
    verify: (dir) => {
      order.push("verify");
      verified.push(dir);
      return Promise.resolve(options.verification ?? GOOD);
    },
  };
  const strategy: SnapshotStrategy = {
    snapshot:
      options.snapshot ??
      ((request) => {
        order.push("snapshot");
        const kept = `${request.deviceDir}/snapshots/kept`;
        snapshots.push(kept);
        return Promise.resolve(kept);
      }),
  };
  const originalStart = transport.startBackup.bind(transport);
  transport.startBackup = (backupOptions) => {
    order.push("backup");
    return originalStart(backupOptions);
  };

  const sleeps: number[] = [];
  const runner = new BackupRunner({
    transport,
    store: new BackupStore(root, strategy),
    verifier,
    state,
    notifier,
    log: () => undefined,
    clock: () => new Date("2026-11-24T20:00:00Z"),
    sleep: (ms) => {
      order.push("sleep");
      sleeps.push(ms);
      return Promise.resolve();
    },
    headsUpLeadSeconds: 5,
  });
  return { runner, transport, sent, order, sleeps, snapshots, verified };
}

describe("BackupRunner", () => {
  it("warns the owner, waits, backs up, verifies, then preserves, in that order", async () => {
    const h = harness();
    h.transport.onBackup = (run) => run.succeed(355_000);

    const report = await h.runner.run(device);

    expect(h.order).toEqual([
      "notify:backup-starting",
      "sleep",
      "backup",
      "verify",
      "snapshot",
      "notify:backup-succeeded",
    ]);
    expect(h.sleeps).toEqual([5000]);
    expect(report).toEqual({
      runId: report.runId,
      outcome: "succeeded",
      durationMs: 355_000,
      snapshotPath: `${root}/mike/snapshots/kept`,
    });
  });

  it("backs up over TCP into the device's working copy and verifies that directory", async () => {
    const h = harness();
    await h.runner.run(device);

    expect(h.transport.backups[0]?.options).toMatchObject({
      udid: FAKE_UDID,
      endpoint: { kind: "tcp", host: "10.0.0.7", pairRecordPath: "/secrets/mike.plist" },
      backupRoot: `${root}/mike/working`,
    });
    expect(h.transport.backups[0]?.options.full).toBeUndefined();
    expect(h.verified).toEqual([`${root}/mike/working/${FAKE_UDID}`]);
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

    const report = await h.runner.run(device);

    expect(state.getRun(report.runId)).toMatchObject({
      outcome: "succeeded",
      prompted: true,
      durationMs: 1234,
      snapshotPath: `${root}/mike/snapshots/kept`,
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

  it("records an unanswered passcode prompt as device-locked and preserves nothing", async () => {
    const h = harness();
    h.transport.onBackup = (run) => {
      run.emit({ type: "passcode-required" }, { type: "passcode-dismissed" });
      run.fail(new BackupError("Device locked (MBErrorDomain/208)", "device-locked"));
    };

    const report = await h.runner.run(device);

    expect(report).toMatchObject({
      outcome: "failed",
      reason: "device-locked",
      message: "Device locked (MBErrorDomain/208)",
    });
    expect(h.order).not.toContain("verify");
    expect(h.order).not.toContain("snapshot");
    expect(state.getRun(report.runId)).toMatchObject({
      outcome: "failed",
      failureReason: "device-locked",
      prompted: true,
    });
    expect(h.sent.at(-1)).toMatchObject({ kind: "backup-failed", reason: "device-locked" });
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

    const report = await h.runner.run(device);

    expect(report).toMatchObject({
      outcome: "failed",
      reason: "verification-failed",
      message:
        "the backup did not verify: Manifest.plist is empty; Manifest.db is missing",
    });
    expect(h.snapshots).toEqual([]);
    expect(state.lastSuccessAt("mike")).toBeUndefined();
  });

  it("does not preserve a backup that belongs to a different phone", async () => {
    const h = harness({
      verification: { ...GOOD, udid: "00008150-000F0E0D0C0B002E" },
    });
    const report = await h.runner.run(device);
    expect(report).toMatchObject({ outcome: "failed", reason: "verification-failed" });
    expect(h.snapshots).toEqual([]);
  });

  it("does not preserve an unencrypted backup", async () => {
    const h = harness({ verification: { ...GOOD, isEncrypted: false } });
    const report = await h.runner.run(device);
    expect(report).toMatchObject({ outcome: "failed", reason: "verification-failed" });
    expect((report as { message: string }).message).toContain("not encrypted");
    expect(h.snapshots).toEqual([]);
  });

  it("reports a verified backup that could not be preserved as a failure", async () => {
    const h = harness({
      snapshot: () => Promise.reject(new Error("ENOSPC: no space left on device")),
    });
    const report = await h.runner.run(device);
    expect(report).toMatchObject({ outcome: "failed", reason: "snapshot-failed" });
    expect((report as { message: string }).message).toContain("ENOSPC");
    expect(state.lastSuccessAt("mike")).toBeUndefined();
  });

  it("never starts a backup if the heads-up could not be sent", async () => {
    const h = harness({
      notify: (n) =>
        n.kind === "backup-starting"
          ? Promise.reject(new Error("push service unreachable"))
          : Promise.resolve(),
    });

    const report = await h.runner.run(device);

    expect(report).toMatchObject({ outcome: "failed", reason: "heads-up-failed" });
    expect(h.transport.backups).toEqual([]);
    expect(state.getRun(report.runId)).toMatchObject({ prompted: false });
  });

  it("keeps the recorded outcome when the result notification fails", async () => {
    const h = harness({
      notify: (n) =>
        n.kind === "backup-succeeded"
          ? Promise.reject(new Error("push service unreachable"))
          : Promise.resolve(),
    });
    const report = await h.runner.run(device);
    expect(report.outcome).toBe("succeeded");
    expect(state.getRun(report.runId)?.outcome).toBe("succeeded");
  });

  it("stops without starting a backup when cancelled during the heads-up wait", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const report = await h.runner.run(device, controller.signal);
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
    const report = await h.runner.run(device, controller.signal);
    expect(report).toMatchObject({ outcome: "failed", reason: "cancelled" });
    expect(h.transport.backups[0]?.cancelled).toBe(true);
    expect(state.getRun(report.runId)?.outcome).toBe("failed");
  });

  it("always finishes the run record, even on an unexpected error", async () => {
    const h = harness();
    h.transport.startBackup = () => {
      throw new TypeError("boom");
    };
    const report = await h.runner.run(device);
    expect(report).toMatchObject({ outcome: "failed", reason: "failed", message: "boom" });
    expect(state.attemptsSince("mike", new Date(0))).toEqual([
      expect.objectContaining({ outcome: "failed" }),
    ]);
  });
});
