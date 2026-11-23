import { DatabaseSync } from "node:sqlite";
import type { AttemptSummary } from "../policy/policy.js";

export type RunOutcome = "running" | "succeeded" | "failed";

export interface RunRecord {
  readonly id: number;
  readonly deviceId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | undefined;
  readonly outcome: RunOutcome;
  /** Machine-readable cause of a failure, e.g. "device-locked". */
  readonly failureReason: string | undefined;
  /** Human-readable detail for a failure. */
  readonly message: string | undefined;
  /** Whether the phone showed its passcode prompt during this run. */
  readonly prompted: boolean;
  /** Where the verified backup was preserved, if a snapshot was taken. */
  readonly snapshotPath: string | undefined;
  /** How long the transfer itself took, for successful runs. */
  readonly durationMs: number | undefined;
}

export interface RunEvent {
  readonly at: Date;
  readonly type: string;
  /** The rest of the event, as recorded. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export type RunResult =
  | {
      readonly outcome: "succeeded";
      readonly durationMs: number;
      readonly snapshotPath: string | undefined;
    }
  | {
      readonly outcome: "failed";
      readonly reason: string;
      readonly message: string;
    };

const SCHEMA_VERSION = 1;

const SCHEMA = `
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
    id      INTEGER PRIMARY KEY,
    run_id  INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    at      INTEGER NOT NULL,
    type    TEXT    NOT NULL,
    detail  TEXT    NOT NULL
  ) STRICT;
  CREATE INDEX run_events_by_run ON run_events (run_id, id);

  CREATE TABLE alerts (
    device_id TEXT    NOT NULL,
    kind      TEXT    NOT NULL,
    sent_at   INTEGER NOT NULL,
    PRIMARY KEY (device_id, kind)
  ) STRICT;
`;

type Row = Record<string, unknown>;

function optionalDate(value: unknown): Date | undefined {
  return typeof value === "number" ? new Date(value) : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toRun(row: Row): RunRecord {
  return {
    id: row["id"] as number,
    deviceId: row["device_id"] as string,
    startedAt: new Date(row["started_at"] as number),
    finishedAt: optionalDate(row["finished_at"]),
    outcome: row["outcome"] as RunOutcome,
    failureReason: optionalText(row["failure_reason"]),
    message: optionalText(row["message"]),
    prompted: row["prompted"] === 1,
    snapshotPath: optionalText(row["snapshot_path"]),
    durationMs: typeof row["duration_ms"] === "number" ? row["duration_ms"] : undefined,
  };
}

/**
 * The daemon's memory: every backup attempt, what happened during it, and
 * which alerts have gone out. One SQLite file, one process.
 */
export class StateStore {
  readonly #db: DatabaseSync;

  /** @param file A database path, or ":memory:" for a throwaway store. */
  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#migrate();
  }

  #migrate(): void {
    const row = this.#db.prepare("PRAGMA user_version").get() as Row | undefined;
    const version = (row?.["user_version"] as number | undefined) ?? 0;
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `the state database is from a newer nightstand (schema ${version}, this build knows ${SCHEMA_VERSION})`,
      );
    }
    if (version === 0) {
      this.#db.exec(`BEGIN; ${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
    }
  }

  close(): void {
    this.#db.close();
  }

  startRun(deviceId: string, at: Date): number {
    const result = this.#db
      .prepare("INSERT INTO runs (device_id, started_at, outcome) VALUES (?, ?, 'running')")
      .run(deviceId, at.getTime());
    return Number(result.lastInsertRowid);
  }

  recordEvent(
    runId: number,
    at: Date,
    event: { readonly type: string } & Readonly<Record<string, unknown>>,
  ): void {
    const { type, ...detail } = event;
    this.#db
      .prepare("INSERT INTO run_events (run_id, at, type, detail) VALUES (?, ?, ?, ?)")
      .run(runId, at.getTime(), type, JSON.stringify(detail));
    if (type === "passcode-required") {
      this.#db.prepare("UPDATE runs SET prompted = 1 WHERE id = ?").run(runId);
    }
  }

  finishRun(runId: number, at: Date, result: RunResult): void {
    const changed =
      result.outcome === "succeeded"
        ? this.#db
            .prepare(
              `UPDATE runs SET outcome = 'succeeded', finished_at = ?, duration_ms = ?,
                 snapshot_path = ? WHERE id = ? AND outcome = 'running'`,
            )
            .run(at.getTime(), result.durationMs, result.snapshotPath ?? null, runId)
        : this.#db
            .prepare(
              `UPDATE runs SET outcome = 'failed', finished_at = ?, failure_reason = ?,
                 message = ? WHERE id = ? AND outcome = 'running'`,
            )
            .run(at.getTime(), result.reason, result.message, runId);
    if (changed.changes !== 1) {
      throw new Error(`run ${runId} is not running, so it cannot be finished`);
    }
  }

  /**
   * Close off runs left "running" by a daemon that stopped mid-backup, so
   * they do not block new attempts forever. Returns how many there were.
   */
  failInterruptedRuns(at: Date): number {
    const result = this.#db
      .prepare(
        `UPDATE runs SET outcome = 'failed', finished_at = ?, failure_reason = 'interrupted',
           message = 'the service stopped while this backup was running'
         WHERE outcome = 'running'`,
      )
      .run(at.getTime());
    return Number(result.changes);
  }

  getRun(runId: number): RunRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | Row
      | undefined;
    return row ? toRun(row) : undefined;
  }

  /** Newest first. */
  recentRuns(deviceId: string, limit: number): RunRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM runs WHERE device_id = ? ORDER BY started_at DESC, id DESC LIMIT ?")
      .all(deviceId, limit) as Row[];
    return rows.map(toRun);
  }

  eventsFor(runId: number): RunEvent[] {
    const rows = this.#db
      .prepare("SELECT at, type, detail FROM run_events WHERE run_id = ? ORDER BY id")
      .all(runId) as Row[];
    return rows.map((row) => ({
      at: new Date(row["at"] as number),
      type: row["type"] as string,
      detail: JSON.parse(row["detail"] as string) as Record<string, unknown>,
    }));
  }

  /** When the last verified backup of this device finished. */
  lastSuccessAt(deviceId: string): Date | undefined {
    const row = this.#db
      .prepare(
        "SELECT MAX(finished_at) AS at FROM runs WHERE device_id = ? AND outcome = 'succeeded'",
      )
      .get(deviceId) as Row | undefined;
    return optionalDate(row?.["at"]);
  }

  /** Attempts started at or after `since`, plus any still running. */
  attemptsSince(deviceId: string, since: Date): AttemptSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT started_at, finished_at, outcome, failure_reason FROM runs
         WHERE device_id = ? AND (started_at >= ? OR outcome = 'running')
         ORDER BY started_at`,
      )
      .all(deviceId, since.getTime()) as Row[];
    return rows.map((row) => ({
      startedAt: new Date(row["started_at"] as number),
      finishedAt: optionalDate(row["finished_at"]),
      outcome: row["outcome"] as RunOutcome,
      failureReason: optionalText(row["failure_reason"]),
    }));
  }

  /** When an alert of this kind last went out for this device. */
  lastAlertAt(deviceId: string, kind: string): Date | undefined {
    const row = this.#db
      .prepare("SELECT sent_at FROM alerts WHERE device_id = ? AND kind = ?")
      .get(deviceId, kind) as Row | undefined;
    return optionalDate(row?.["sent_at"]);
  }

  recordAlert(deviceId: string, kind: string, at: Date): void {
    this.#db
      .prepare(
        `INSERT INTO alerts (device_id, kind, sent_at) VALUES (?, ?, ?)
         ON CONFLICT (device_id, kind) DO UPDATE SET sent_at = excluded.sent_at`,
      )
      .run(deviceId, kind, at.getTime());
  }
}
