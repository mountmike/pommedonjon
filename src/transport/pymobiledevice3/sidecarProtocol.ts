import { z } from "zod";
import { describeIssues } from "../../schema/issues.js";
import {
  DeviceError,
  DeviceStatusSchema,
  type BackupEvent,
  type BackupFailureReason,
  type DeviceStatus,
  type DeviceTarget,
} from "../DeviceTransport.js";

/**
 * One line of output from the sidecar's `backup` command, decoded. Events are
 * forwarded to listeners; "finished" and "error" end the run.
 */
export type SidecarMessage =
  | { readonly kind: "event"; readonly event: BackupEvent }
  | {
      readonly kind: "finished";
      readonly backupDir: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "error";
      readonly reason: BackupFailureReason;
      readonly message: string;
    };

/** MobileBackup's "Device locked" error code (MBErrorDomain/208). */
const MB_ERROR_DEVICE_LOCKED = 208;

/**
 * What the sidecar prints, as it prints it. Unknown extra fields are ignored
 * so the sidecar can add to a message without breaking an older daemon;
 * a field of the wrong type makes the whole line unrecognised.
 */
const category = z.enum(["unreachable", "not-paired", "failed"]).catch("failed");

const BackupLineSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("started") }),
  z.object({ event: z.literal("passcode-required") }),
  z.object({ event: z.literal("passcode-dismissed") }),
  z.object({ event: z.literal("progress"), percent: z.number() }),
  z.object({
    event: z.literal("log"),
    level: z.enum(["info", "warning", "error"]).catch("info"),
    message: z.string(),
  }),
  z.object({ event: z.literal("finished"), backupDir: z.string(), durationMs: z.number() }),
  z.object({
    event: z.literal("error"),
    message: z.string().catch("unknown error"),
    code: z.number().nullable().catch(null),
    category,
  }),
]);

const ProbeReplySchema = z.discriminatedUnion("ok", [
  DeviceStatusSchema.extend({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    message: z.string().catch("probe failed"),
    category,
  }),
]);

/** The sidecar's arguments for reaching a device. */
export function endpointArgs(target: DeviceTarget): string[] {
  const args = ["--udid", target.udid];
  const { endpoint } = target;
  if (endpoint.kind === "tcp") {
    args.push("--host", endpoint.host, "--pair-record", endpoint.pairRecordPath);
    if (endpoint.port !== undefined) args.push("--port", String(endpoint.port));
  } else {
    args.push("--connection", endpoint.connection);
  }
  return args;
}

/**
 * Decode one NDJSON line. Returns undefined for blank lines. Anything that is
 * not a known event is surfaced as a warning log rather than dropped, so a
 * protocol drift between the sidecar and the daemon shows up in run logs.
 */
export function parseSidecarLine(line: string): SidecarMessage | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;

  const unrecognised = (): SidecarMessage => ({
    kind: "event",
    event: {
      type: "log",
      level: "warning",
      message: `unrecognised sidecar output: ${trimmed}`,
    },
  });

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return unrecognised();
  }
  const parsed = BackupLineSchema.safeParse(json);
  if (!parsed.success) return unrecognised();
  const message = parsed.data;

  switch (message.event) {
    case "started":
    case "passcode-required":
    case "passcode-dismissed":
      return { kind: "event", event: { type: message.event } };
    case "progress":
      return {
        kind: "event",
        event: { type: "progress", percent: Math.min(100, Math.max(0, message.percent)) },
      };
    case "log":
      return {
        kind: "event",
        event: { type: "log", level: message.level, message: message.message },
      };
    case "finished":
      return { kind: "finished", backupDir: message.backupDir, durationMs: message.durationMs };
    case "error":
      return {
        kind: "error",
        reason: message.code === MB_ERROR_DEVICE_LOCKED ? "device-locked" : message.category,
        message: message.message,
      };
  }
}

/**
 * Decode the single object printed by the sidecar's `probe` command. Throws
 * {@link DeviceError} for a reported failure and for output that is not in
 * the expected shape.
 */
export function parseProbeResult(value: unknown): DeviceStatus {
  const parsed = ProbeReplySchema.safeParse(value);
  if (!parsed.success) {
    throw new DeviceError(
      `probe: unexpected reply from the sidecar: ${describeIssues(parsed.error).join("; ")}`,
      "failed",
    );
  }
  if (!parsed.data.ok) {
    throw new DeviceError(parsed.data.message, parsed.data.category);
  }
  const { ok: _ok, ...status } = parsed.data;
  return status;
}
