import { describe, expect, it } from "vitest";
import {
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
