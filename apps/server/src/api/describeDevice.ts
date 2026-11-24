import type {
  DeviceDetail,
  DeviceProblem,
  DeviceState,
  DeviceSummary,
  RunProgress,
  RunSummary,
} from "@pommedonjon/api-contract";
import type { DeviceConfig } from "../config/config.js";
import type { WaitingFor } from "../daemon/Daemon.js";
import { isStale } from "../policy/policy.js";
import type { RunEvent, RunRecord } from "../state/StateStore.js";

/** Everything known about one phone at one moment. */
export interface DeviceFacts {
  readonly device: Pick<DeviceConfig, "id" | "name" | "policy">;
  readonly now: Date;
  /** When the last good backup finished, if there has ever been one. */
  readonly lastSuccessAt: Date | undefined;
  /** Most recent first. */
  readonly recentRuns: readonly RunRecord[];
  /** What the run in progress has reported so far, oldest first. */
  readonly runningEvents: readonly RunEvent[];
  /** Why the daemon did not start a backup on its last pass. */
  readonly waiting: WaitingFor | undefined;
}

const HOUR_MS = 60 * 60 * 1000;

const PROBLEMS: Readonly<Record<string, DeviceProblem>> = {
  "encryption-off": "encryption-off",
  "not-paired": "not-paired",
};

/** Where a running backup has got to, from the events it has recorded. */
export function describeRun(run: RunRecord, events: readonly RunEvent[]): RunProgress {
  const startedAt = run.startedAt.toISOString();
  let asked: Date | undefined;
  let answered = false;
  let percent: number | undefined;
  for (const event of events) {
    if (event.type === "passcode-required") {
      asked = event.at;
      answered = false;
    } else if (event.type === "passcode-dismissed") {
      answered = true;
    } else if (event.type === "progress") {
      const value = event.detail["percent"];
      if (typeof value === "number") percent = Math.min(100, Math.max(0, value));
    }
  }

  if (asked && !answered && percent === undefined) {
    return { stage: "passcode", startedAt, passcodeSince: asked.toISOString() };
  }
  if (percent !== undefined) {
    // The phone reports 100 when the copy is done; what is left is checking it.
    return { stage: percent >= 100 ? "checking" : "transferring", startedAt, percent };
  }
  // The prompt has closed and nothing has been copied yet.
  if (answered) return { stage: "transferring", startedAt };
  return { stage: "connecting", startedAt };
}

/** One phone as its owner should see it: the summary the app's first screen shows. */
export function describeDevice(facts: DeviceFacts): DeviceSummary {
  const { device, now, lastSuccessAt, recentRuns, runningEvents, waiting } = facts;
  const running = recentRuns.find((run) => run.outcome === "running");
  const problem = waiting ? (PROBLEMS[waiting.reason] ?? null) : null;
  const dueAt = lastSuccessAt
    ? new Date(lastSuccessAt.getTime() + device.policy.dueAfterHours * HOUR_MS)
    : undefined;

  let state: DeviceState;
  if (running) state = "backing-up";
  else if (problem) state = "needs-you";
  else if (!lastSuccessAt || !dueAt) state = "never";
  else if (isStale(device.policy, lastSuccessAt, now)) state = "overdue";
  else if (now.getTime() < dueAt.getTime()) state = "backed-up";
  // Wanted, and the phone is not answering: it is out, which is not a fault.
  else if (waiting?.reason === "unreachable") state = "away";
  else state = "due";

  return {
    id: device.id,
    name: device.name,
    state,
    lastBackupAt: lastSuccessAt?.toISOString() ?? null,
    dueAt: dueAt?.toISOString() ?? null,
    waiting:
      running || !waiting
        ? null
        : {
            reason: waiting.reason,
            ...(waiting.until && { until: waiting.until.toISOString() }),
          },
    run: running ? describeRun(running, runningEvents) : null,
    problem: running ? null : problem,
  };
}

function summariseRun(run: RunRecord): RunSummary {
  return {
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    outcome: run.outcome,
    reason: run.failureReason ?? null,
    prompted: run.prompted,
    durationMs: run.durationMs ?? null,
  };
}

/** One phone with its recent history. */
export function describeDeviceDetail(facts: DeviceFacts): DeviceDetail {
  return { ...describeDevice(facts), recentRuns: facts.recentRuns.map(summariseRun) };
}
