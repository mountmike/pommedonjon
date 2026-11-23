import type { ConnectionType, DeviceInfo } from "../DeviceTransport.js";

/** Thrown when CLI output is not in the shape this parser was written for. */
export class UnexpectedOutputError extends Error {
  override readonly name = "UnexpectedOutputError";
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(stdout: string, command: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new UnexpectedOutputError(`${command}: output is not JSON`, { cause });
  }
}

function requireString(obj: JsonObject, key: string, command: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value === "") {
    throw new UnexpectedOutputError(`${command}: missing string field "${key}"`);
  }
  return value;
}

function parseConnectionType(raw: string, command: string): ConnectionType {
  switch (raw) {
    case "USB":
      return "usb";
    case "Network":
      return "network";
    default:
      throw new UnexpectedOutputError(
        `${command}: unknown ConnectionType "${raw}"`,
      );
  }
}

/**
 * Parse `pymobiledevice3 usbmux list`. A phone that is on USB and also visible
 * over WiFi appears as two entries with the same UDID; they are merged into
 * one device with both connections, USB first.
 */
export function parseUsbmuxList(stdout: string): DeviceInfo[] {
  const command = "usbmux list";
  const parsed = parseJson(stdout, command);
  if (!Array.isArray(parsed)) {
    throw new UnexpectedOutputError(`${command}: expected a JSON array`);
  }

  const byUdid = new Map<
    string,
    Omit<DeviceInfo, "connections"> & { connections: Set<ConnectionType> }
  >();
  for (const entry of parsed) {
    if (!isObject(entry)) {
      throw new UnexpectedOutputError(`${command}: entry is not an object`);
    }
    const udid = requireString(entry, "UniqueDeviceID", command);
    const connection = parseConnectionType(
      requireString(entry, "ConnectionType", command),
      command,
    );
    const existing = byUdid.get(udid);
    if (existing) {
      existing.connections.add(connection);
      continue;
    }
    byUdid.set(udid, {
      udid,
      name: requireString(entry, "DeviceName", command),
      productType: requireString(entry, "ProductType", command),
      osVersion: requireString(entry, "ProductVersion", command),
      buildVersion: requireString(entry, "BuildVersion", command),
      connections: new Set([connection]),
    });
  }

  const order: readonly ConnectionType[] = ["usb", "network"];
  return [...byUdid.values()].map((device) => ({
    ...device,
    connections: order.filter((c) => device.connections.has(c)),
  }));
}
