import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { describeIssues } from "../schema/issues.js";
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
    }
  | {
      readonly outcome: "failed";
      readonly reason: string;
      readonly message: string;
    };

const SCHEMA_VERSION = 3;

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

/** Added in schema 3: where each phone was last reached. */
const ADDRESSES = `
  CREATE TABLE device_addresses (
    device_id TEXT    PRIMARY KEY,
    host      TEXT    NOT NULL,
    seen_at   INTEGER NOT NULL
  ) STRICT;
`;

// Rows are parsed on the way out, like any other data from outside the
// program: a database written by a different version, or edited by hand,
// should fail loudly here and not as a wrong decision later.

const timestamp = z.number().transform((ms) => new Date(ms));
const optionalTimestamp = z
  .number()
  .nullable()
  .transform((ms) => (ms === null ? undefined : new Date(ms)));
const optionalText = z
  .string()
  .nullable()
  .transform((value) => value ?? undefined);
const outcome = z.enum(["running", "succeeded", "failed"]);

const RunRowSchema = z
  .object({
    id: z.number(),
    device_id: z.string(),
    started_at: timestamp,
    finished_at: optionalTimestamp,
    outcome,
    failure_reason: optionalText,
    message: optionalText,
    prompted: z.number(),
    duration_ms: z
      .number()
      .nullable()
      .transform((value) => value ?? undefined),
  })
  .transform(
    (row): RunRecord => ({
      id: row.id,
      deviceId: row.device_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      outcome: row.outcome,
      failureReason: row.failure_reason,
      message: row.message,
      prompted: row.prompted === 1,
      durationMs: row.duration_ms,
    }),
  );

const AttemptRowSchema = z
  .object({
    started_at: timestamp,
    finished_at: optionalTimestamp,
    outcome,
    failure_reason: optionalText,
  })
  .transform(
    (row): AttemptSummary => ({
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      outcome: row.outcome,
      failureReason: row.failure_reason,
    }),
  );

const EventRowSchema = z
  .object({
    at: timestamp,
    type: z.string(),
    detail: z.string().transform((text, ctx): Record<string, unknown> => {
      try {
        const value: unknown = JSON.parse(text);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          return value as Record<string, unknown>;
        }
      } catch {
        // Reported below.
      }
      ctx.issues.push({ code: "custom", message: "is not a JSON object", input: text });
      return z.NEVER;
    }),
  })
  .transform((row): RunEvent => row);

const whenRow = (column: string) =>
  z
    .object({ [column]: optionalTimestamp })
    .optional()
    .transform((row) => row?.[column]);

function read<Output>(schema: z.ZodType<Output>, what: string, row: unknown): Output {
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      `the state database holds ${what} this version cannot read: ${describeIssues(parsed.error).join("; ")}`,
    );
  }
  return parsed.data;
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
    const { user_version: version } = read(
      z.object({ user_version: z.number() }),
      "a schema version",
      this.#db.prepare("PRAGMA user_version").get(),
    );
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `the state database is from a newer nightstand (schema ${version}, this build knows ${SCHEMA_VERSION})`,
      );
    }
    if (version === 0) {
      this.#db.exec(
        `BEGIN; ${SCHEMA} ${ADDRESSES} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`,
      );
      return;
    }
    if (version < 2) {
      // Built-in snapshots were removed, and with them the record of where
      // each one was kept.
      this.#db.exec(
        "BEGIN; ALTER TABLE runs DROP COLUMN snapshot_path; PRAGMA user_version = 2; COMMIT;",
      );
    }
    if (version < 3) {
      this.#db.exec(`BEGIN; ${ADDRESSES} PRAGMA user_version = 3; COMMIT;`);
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
              `UPDATE runs SET outcome = 'succeeded', finished_at = ?, duration_ms = ?
                 WHERE id = ? AND outcome = 'running'`,
            )
            .run(at.getTime(), result.durationMs, runId)
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
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    return row === undefined ? undefined : read(RunRowSchema, "a run", row);
  }

  /** Newest first. */
  recentRuns(deviceId: string, limit: number): RunRecord[] {
    return this.#db
      .prepare("SELECT * FROM runs WHERE device_id = ? ORDER BY started_at DESC, id DESC LIMIT ?")
      .all(deviceId, limit)
      .map((row) => read(RunRowSchema, "a run", row));
  }

  eventsFor(runId: number): RunEvent[] {
    return this.#db
      .prepare("SELECT at, type, detail FROM run_events WHERE run_id = ? ORDER BY id")
      .all(runId)
      .map((row) => read(EventRowSchema, "a run event", row));
  }

  /** When the last verified backup of this device finished. */
  lastSuccessAt(deviceId: string): Date | undefined {
    return read(
      whenRow("at"),
      "a backup time",
      this.#db
        .prepare(
          "SELECT MAX(finished_at) AS at FROM runs WHERE device_id = ? AND outcome = 'succeeded'",
        )
        .get(deviceId),
    );
  }

  /** Attempts started at or after `since`, plus any still running. */
  attemptsSince(deviceId: string, since: Date): AttemptSummary[] {
    return this.#db
      .prepare(
        `SELECT started_at, finished_at, outcome, failure_reason FROM runs
         WHERE device_id = ? AND (started_at >= ? OR outcome = 'running')
         ORDER BY started_at`,
      )
      .all(deviceId, since.getTime())
      .map((row) => read(AttemptRowSchema, "a run", row));
  }

  /** When an alert of this kind last went out for this device. */
  lastAlertAt(deviceId: string, kind: string): Date | undefined {
    return read(
      whenRow("sent_at"),
      "an alert time",
      this.#db
        .prepare("SELECT sent_at FROM alerts WHERE device_id = ? AND kind = ?")
        .get(deviceId, kind),
    );
  }

  /** Where this device was last reached, if it has been found before. */
  lastAddress(deviceId: string): string | undefined {
    return read(
      z
        .object({ host: z.string() })
        .optional()
        .transform((row) => row?.host),
      "a device address",
      this.#db.prepare("SELECT host FROM device_addresses WHERE device_id = ?").get(deviceId),
    );
  }

  rememberAddress(deviceId: string, host: string, at: Date): void {
    this.#db
      .prepare(
        `INSERT INTO device_addresses (device_id, host, seen_at) VALUES (?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET host = excluded.host, seen_at = excluded.seen_at`,
      )
      .run(deviceId, host, at.getTime());
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
