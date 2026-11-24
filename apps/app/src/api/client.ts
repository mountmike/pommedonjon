import {
  ApiErrorSchema,
  BackupStartedSchema,
  DeviceDetailSchema,
  DeviceListSchema,
  type DeviceDetail,
  type DeviceSummary,
} from "@pommedonjon/api-contract";

/**
 * Where the server is. The web app is served by the server itself, so the
 * API is at the same address and this is empty. Set EXPO_PUBLIC_API_URL to
 * point a development build somewhere else.
 */
export const API_BASE: string = process.env.EXPO_PUBLIC_API_URL ?? "";

export type FetchFn = (
  url: string,
  init?: { readonly method: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** A reply that was not what the contract promises, or not a success. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    message: string,
    /** The HTTP status, when the server answered at all. */
    readonly status?: number,
  ) {
    super(message);
  }
}

const NONSENSE = "The server's answer made no sense.";

/** Send one request and read its JSON, whatever the status. */
async function ask(
  fetchFn: FetchFn,
  url: string,
  method: "GET" | "POST",
): Promise<{ status: number; ok: boolean; body: unknown }> {
  let response;
  try {
    response = await (method === "GET" ? fetchFn(url) : fetchFn(url, { method }));
  } catch {
    throw new ApiError("Can't reach the server.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) throw new ApiError(`The server answered ${response.status}.`, response.status);
    throw new ApiError(NONSENSE, response.status);
  }
  return { status: response.status, ok: response.ok, body };
}

/** The server's own word for what went wrong, if it gave one. */
function errorCode(body: unknown): string | undefined {
  const parsed = ApiErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error : undefined;
}

/**
 * Every phone and its state. Whatever comes back is checked against the
 * contract before any of it is shown.
 */
export async function fetchDevices(
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<DeviceSummary[]> {
  const { ok, status, body } = await ask(fetchFn, `${base}/api/devices`, "GET");
  if (!ok) throw new ApiError(`The server answered ${status}.`, status);
  const parsed = DeviceListSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(NONSENSE, status);
  return parsed.data.devices;
}

/** One phone, with its recent backups. */
export async function fetchDevice(
  deviceId: string,
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<DeviceDetail> {
  const { ok, status, body } = await ask(
    fetchFn,
    `${base}/api/devices/${encodeURIComponent(deviceId)}`,
    "GET",
  );
  if (status === 404) throw new ApiError("There is no such phone on the server.", status);
  if (!ok) throw new ApiError(`The server answered ${status}.`, status);
  const parsed = DeviceDetailSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(NONSENSE, status);
  return parsed.data;
}

/**
 * Ask for a phone to be backed up now. The answer comes as soon as the
 * server has decided, not when the backup ends: "started", or
 * "already-running" if one was under way, which is as good.
 */
export async function requestBackup(
  deviceId: string,
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<"started" | "already-running"> {
  const { ok, status, body } = await ask(
    fetchFn,
    `${base}/api/devices/${encodeURIComponent(deviceId)}/backup-now`,
    "POST",
  );
  if (ok) {
    if (!BackupStartedSchema.safeParse(body).success) throw new ApiError(NONSENSE, status);
    return "started";
  }
  const code = errorCode(body);
  if (status === 409 && code === "already-running") return "already-running";
  if (status === 404) throw new ApiError("There is no such phone on the server.", status);
  throw new ApiError(`The server answered ${status}.`, status);
}
