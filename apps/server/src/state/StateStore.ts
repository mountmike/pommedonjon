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

/** Something the daemon noticed about a phone outside a backup run. */
export interface DeviceEvent {
  readonly at: Date;
  /** "power": its power state changed. "waiting": why no backup is starting changed. */
  readonly kind: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** A phone as it is kept: who it is and where to look for it. */
export interface DeviceRow {
  /** Short name used in addresses, paths and logs, e.g. "mike". */
  readonly id: string;
  /** Name to show. */
  readonly name: string;
  readonly udid: string;
  /** A fixed address or name, if the phone is not to be found by discovery. */
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly addedAt: Date;
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

const SCHEMA_VERSION = 8;

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
`;

/**
 * Added in schema 4: what the daemon noticed about a phone between backups.
 * This is the record a trial of the schedule is judged from, so it is kept
 * here and not only in the service log, which a container restart loses.
 */
const DEVICE_EVENTS = `
  CREATE TABLE device_events (
    id        INTEGER PRIMARY KEY,
    device_id TEXT    NOT NULL,
    at        INTEGER NOT NULL,
    kind      TEXT    NOT NULL,
    detail    TEXT    NOT NULL
  ) STRICT;
  CREATE INDEX device_events_by_device ON device_events (device_id, at);
`;

/**
 * Added in schema 6: what has been changed about a phone from the app, as
 * a JSON document. What it may hold is the settings layer's business, not
 * this store's.
 */
const DEVICE_SETTINGS = `
  CREATE TABLE device_settings (
    device_id  TEXT    PRIMARY KEY,
    settings   TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
`;

/**
 * Added in schema 8: the phones themselves, and the few settings that
 * belong to the server as a whole. Before this they came from a config
 * file. A phone's pair record is not here: it is a file of its own, kept
 * readable by the service alone.
 */
const DEVICES = `
  CREATE TABLE devices (
    id       TEXT    PRIMARY KEY,
    name     TEXT    NOT NULL,
    udid     TEXT    NOT NULL UNIQUE,
    host     TEXT,
    port     INTEGER,
    added_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE server_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
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

const DeviceRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    udid: z.string(),
    host: optionalText,
    port: z
      .number()
      .nullable()
      .transform((value) => value ?? undefined),
    added_at: timestamp,
  })
  .transform(
    (row): DeviceRow => ({
      id: row.id,
      name: row.name,
      udid: row.udid,
      host: row.host,
      port: row.port,
      addedAt: row.added_at,
    }),
  );

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

const jsonObject = z.string().transform((text, ctx): Record<string, unknown> => {
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
});

const EventRowSchema = z
  .object({ at: timestamp, type: z.string(), detail: jsonObject })
  .transform((row): RunEvent => row);

const DeviceEventRowSchema = z
  .object({ at: timestamp, kind: z.string(), detail: jsonObject })
  .transform((row): DeviceEvent => row);

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
 * what was noticed about each phone in between. One SQLite file, one process.
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
        `the state database is from a newer pommedonjon (schema ${version}, this build knows ${SCHEMA_VERSION})`,
      );
    }
    if (version === 0) {
      this.#db.exec(
        `BEGIN; ${SCHEMA} ${ADDRESSES} ${DEVICE_EVENTS} ${DEVICE_SETTINGS} ${DEVICES} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`,
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
    if (version < 4) {
      this.#db.exec(`BEGIN; ${DEVICE_EVENTS} PRAGMA user_version = 4; COMMIT;`);
    }
    if (version < 5) {
      // Stale-backup alerts are no longer remembered between restarts.
      this.#db.exec("BEGIN; DROP TABLE IF EXISTS alerts; PRAGMA user_version = 5; COMMIT;");
    }
    if (version < 6) {
      this.#db.exec(`BEGIN; ${DEVICE_SETTINGS} PRAGMA user_version = 6; COMMIT;`);
    }
    if (version < 7) {
      // The "trigger" setting became the moments a backup may start at.
      // "on-charger" meant any time on a charger, from the start; the other
      // value was the default, which the moments' own defaults now cover.
      this.#db.exec(`
        BEGIN;
        UPDATE device_settings
           SET settings = json_set(settings, '$.policy.startOnChargerAfterHours', 0)
         WHERE json_extract(settings, '$.policy.trigger') = 'on-charger';
        UPDATE device_settings SET settings = json_remove(settings, '$.policy.trigger');
        PRAGMA user_version = 7;
        COMMIT;
      `);
    }
    if (version < 8) {
      this.#db.exec(`BEGIN; ${DEVICES} PRAGMA user_version = 8; COMMIT;`);
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

  /** Runs started at or after `since`, oldest first. */
  runsSince(deviceId: string, since: Date): RunRecord[] {
    return this.#db
      .prepare("SELECT * FROM runs WHERE device_id = ? AND started_at >= ? ORDER BY started_at, id")
      .all(deviceId, since.getTime())
      .map((row) => read(RunRowSchema, "a run", row));
  }

  recordDeviceEvent(
    deviceId: string,
    at: Date,
    kind: string,
    detail: Readonly<Record<string, unknown>> = {},
  ): void {
    this.#db
      .prepare("INSERT INTO device_events (device_id, at, kind, detail) VALUES (?, ?, ?, ?)")
      .run(deviceId, at.getTime(), kind, JSON.stringify(detail));
  }

  /** What the daemon noticed about this device at or after `since`, oldest first. */
  deviceEventsSince(deviceId: string, since: Date): DeviceEvent[] {
    return this.#db
      .prepare(
        "SELECT at, kind, detail FROM device_events WHERE device_id = ? AND at >= ? ORDER BY at, id",
      )
      .all(deviceId, since.getTime())
      .map((row) => read(DeviceEventRowSchema, "a device event", row));
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

  /**
   * What has been changed about a phone from the app, as it was saved.
   * Undefined if nothing has. The caller checks what it holds.
   */
  deviceSettings(deviceId: string): unknown {
    const row = this.#db
      .prepare("SELECT settings FROM device_settings WHERE device_id = ?")
      .get(deviceId);
    if (row === undefined) return undefined;
    const { settings } = read(z.object({ settings: z.string() }), "a phone's settings", row);
    try {
      return JSON.parse(settings) as unknown;
    } catch {
      throw new Error(
        "the state database holds a phone's settings this version cannot read: not JSON",
      );
    }
  }

  saveDeviceSettings(deviceId: string, settings: object, at: Date): void {
    this.#db
      .prepare(
        `INSERT INTO device_settings (device_id, settings, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE
           SET settings = excluded.settings, updated_at = excluded.updated_at`,
      )
      .run(deviceId, JSON.stringify(settings), at.getTime());
  }

  /** Every phone, in the order they were added. */
  devices(): DeviceRow[] {
    return this.#db
      .prepare("SELECT * FROM devices ORDER BY added_at, rowid")
      .all()
      .map((row) => read(DeviceRowSchema, "a phone", row));
  }

  /** Add a phone. Throws if its id or UDID is already taken. */
  addDevice(device: Omit<DeviceRow, "addedAt">, at: Date): void {
    this.#db
      .prepare(
        "INSERT INTO devices (id, name, udid, host, port, added_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        device.id,
        device.name,
        device.udid,
        device.host ?? null,
        device.port ?? null,
        at.getTime(),
      );
  }

  renameDevice(deviceId: string, name: string): void {
    this.#db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(name, deviceId);
  }

  /**
   * Remove a phone and what was changed about it. Its history of runs is
   * kept: it says what happened, whether or not the phone is still here.
   */
  removeDevice(deviceId: string): void {
    this.#db.exec("BEGIN");
    try {
      this.#db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
      this.#db.prepare("DELETE FROM device_settings WHERE device_id = ?").run(deviceId);
      this.#db.prepare("DELETE FROM device_addresses WHERE device_id = ?").run(deviceId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** One of the server's own settings, as it was saved. Undefined if never set. */
  serverSetting(key: string): unknown {
    const row = this.#db.prepare("SELECT value FROM server_settings WHERE key = ?").get(key);
    if (row === undefined) return undefined;
    const { value } = read(z.object({ value: z.string() }), "a server setting", row);
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error(
        `the state database holds a server setting this version cannot read: ${key} is not JSON`,
      );
    }
  }

  saveServerSetting(key: string, value: unknown): void {
    this.#db
      .prepare(
        `INSERT INTO server_settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }
}
