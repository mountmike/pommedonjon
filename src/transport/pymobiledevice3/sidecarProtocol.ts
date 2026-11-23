import {
  DeviceError,
  type BackupEvent,
  type BackupFailureReason,
  type DeviceErrorReason,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logLevel(raw: unknown): "info" | "warning" | "error" {
  return raw === "warning" || raw === "error" ? raw : "info";
}

function categoryReason(raw: unknown): DeviceErrorReason {
  return raw === "unreachable" || raw === "not-paired" ? raw : "failed";
}

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

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return unrecognised();
  }
  if (!isRecord(parsed)) return unrecognised();

  switch (parsed["event"]) {
    case "started":
      return { kind: "event", event: { type: "started" } };
    case "passcode-required":
      return { kind: "event", event: { type: "passcode-required" } };
    case "passcode-dismissed":
      return { kind: "event", event: { type: "passcode-dismissed" } };
    case "progress": {
      const percent = parsed["percent"];
      if (typeof percent !== "number" || !Number.isFinite(percent)) {
        return unrecognised();
      }
      return {
        kind: "event",
        event: { type: "progress", percent: Math.min(100, Math.max(0, percent)) },
      };
    }
    case "log": {
      const message = parsed["message"];
      if (typeof message !== "string") return unrecognised();
      return {
        kind: "event",
        event: { type: "log", level: logLevel(parsed["level"]), message },
      };
    }
    case "finished": {
      const backupDir = parsed["backupDir"];
      const durationMs = parsed["durationMs"];
      if (typeof backupDir !== "string" || typeof durationMs !== "number") {
        return unrecognised();
      }
      return { kind: "finished", backupDir, durationMs };
    }
    case "error": {
      const message =
        typeof parsed["message"] === "string" ? parsed["message"] : "unknown error";
      return {
        kind: "error",
        reason:
          parsed["code"] === MB_ERROR_DEVICE_LOCKED
            ? "device-locked"
            : categoryReason(parsed["category"]),
        message,
      };
    }
    default:
      return unrecognised();
  }
}

/**
 * Decode the single object printed by the sidecar's `probe` command. Throws
 * {@link DeviceError} for a reported failure and for output that is not in
 * the expected shape.
 */
export function parseProbeResult(value: unknown): DeviceStatus {
  if (!isRecord(value)) {
    throw new DeviceError("probe: sidecar printed no result", "failed");
  }
  if (value["ok"] !== true) {
    const message =
      typeof value["message"] === "string" ? value["message"] : "probe failed";
    throw new DeviceError(message, categoryReason(value["category"]));
  }

  const text = (key: string): string => {
    const field = value[key];
    if (typeof field !== "string" || field === "") {
      throw new DeviceError(`probe: missing field "${key}"`, "failed");
    }
    return field;
  };

  const battery = value["battery"];
  if (!isRecord(battery)) {
    throw new DeviceError('probe: missing field "battery"', "failed");
  }
  const level = battery["levelPercent"];
  if (typeof level !== "number" || level < 0 || level > 100) {
    throw new DeviceError("probe: battery level is not a percentage", "failed");
  }
  const flag = (key: string): boolean => {
    const field = battery[key];
    if (typeof field !== "boolean") {
      throw new DeviceError(`probe: missing battery field "${key}"`, "failed");
    }
    return field;
  };

  return {
    udid: text("udid"),
    name: text("name"),
    productType: text("productType"),
    osVersion: text("osVersion"),
    buildVersion: text("buildVersion"),
    battery: {
      levelPercent: level,
      isCharging: flag("isCharging"),
      externalPowerConnected: flag("externalPowerConnected"),
      fullyCharged: flag("fullyCharged"),
    },
    backupEncryptionEnabled: value["backupEncryptionEnabled"] === true,
  };
}
