import { describe, expect, it } from "vitest";
import {
  BackupStartedSchema,
  DeviceDetailSchema,
  DeviceListSchema,
  DeviceSummarySchema,
  type DeviceSummary,
} from "../src/index.js";

const backedUp: DeviceSummary = {
  id: "mike",
  name: "Mike's iPhone",
  state: "backed-up",
  lastBackupAt: "2026-11-24T10:24:20.700Z",
  dueAt: "2026-11-25T06:24:20.700Z",
  waiting: { reason: "not-due", until: "2026-11-25T06:24:20.700Z" },
  run: null,
  problem: null,
  lastAttempt: null,
};

describe("the device summary", () => {
  it("accepts a phone that is backed up and waiting for its next backup", () => {
    expect(DeviceSummarySchema.parse(backedUp)).toEqual(backedUp);
  });

  it("accepts a phone in the middle of a backup", () => {
    const running: DeviceSummary = {
      ...backedUp,
      state: "backing-up",
      waiting: null,
      run: {
        stage: "passcode",
        startedAt: "2026-11-24T10:19:31.756Z",
        passcodeSince: "2026-11-24T10:19:40.611Z",
      },
    };
    expect(DeviceSummarySchema.parse(running)).toEqual(running);
  });

  it("accepts a phone that has never been backed up", () => {
    const fresh = { ...backedUp, state: "never", lastBackupAt: null, dueAt: null, waiting: null };
    expect(DeviceSummarySchema.parse(fresh)).toEqual(fresh);
  });

  it("carries how the last backup that ended went", () => {
    const afterACancel: DeviceSummary = {
      ...backedUp,
      lastAttempt: {
        startedAt: "2026-11-24T10:29:01.000Z",
        finishedAt: "2026-11-24T10:29:09.000Z",
        outcome: "failed",
        reason: "passcode-cancelled",
        prompted: true,
        durationMs: null,
      },
    };
    expect(DeviceSummarySchema.parse(afterACancel)).toEqual(afterACancel);
  });

  it("takes a reply with no last attempt as having none, so an older server does not break a newer app", () => {
    const { lastAttempt: _unsaid, ...older } = backedUp;
    expect(DeviceSummarySchema.parse(older).lastAttempt).toBeNull();
  });

  it("accepts a waiting reason it has not heard of, so a newer server does not break an older app", () => {
    const parsed = DeviceSummarySchema.parse({ ...backedUp, waiting: { reason: "something-new" } });
    expect(parsed.waiting?.reason).toBe("something-new");
  });

  it.each([
    ["a state that does not exist", { state: "fine" }],
    ["a time that is not a time", { lastBackupAt: "yesterday" }],
    ["a percentage over 100", { run: { stage: "transferring", startedAt: backedUp.dueAt, percent: 140 } }],
    ["a missing name", { name: undefined }],
  ])("rejects %s", (_what, change) => {
    expect(DeviceSummarySchema.safeParse({ ...backedUp, ...change }).success).toBe(false);
  });
});

describe("the replies", () => {
  it("says a backup was started, and nothing else", () => {
    expect(BackupStartedSchema.parse({ status: "started" })).toEqual({ status: "started" });
    expect(BackupStartedSchema.safeParse({ status: "not-now" }).success).toBe(false);
  });

  it("lists phones", () => {
    expect(DeviceListSchema.parse({ devices: [backedUp] }).devices).toHaveLength(1);
  });

  it("gives one phone with its recent runs", () => {
    const detail = {
      ...backedUp,
      recentRuns: [
        {
          startedAt: "2026-11-24T10:19:31.756Z",
          finishedAt: "2026-11-24T10:24:20.707Z",
          outcome: "succeeded",
          reason: null,
          prompted: true,
          durationMs: 282082,
        },
        {
          startedAt: "2026-11-24T09:51:15.512Z",
          finishedAt: "2026-11-24T09:51:23.978Z",
          outcome: "failed",
          reason: "unreachable",
          prompted: false,
          durationMs: null,
        },
      ],
    };
    expect(DeviceDetailSchema.parse(detail)).toEqual(detail);
  });
});
