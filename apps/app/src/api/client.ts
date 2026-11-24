import {
  ApiErrorSchema,
  BackupStartedSchema,
  BackupStoppingSchema,
  DeviceDetailSchema,
  DeviceAddedSchema,
  DeviceCheckSchema,
  DeviceListSchema,
  DeviceSettingsSchema,
  ServerInfoSchema,
  ServerSettingsSchema,
  type DeviceCheck,
  type DeviceDetail,
  type DeviceSettings,
  type DeviceSummary,
  type NewDevice,
  type ServerInfo,
  type ServerSettings,
} from "@pommedonjon/api-contract";

/**
 * Where the server is. The web app is served by the server itself, so the
 * API is at the same address and this is empty. Set EXPO_PUBLIC_API_URL to
 * point a development build somewhere else.
 */
export const API_BASE: string = process.env.EXPO_PUBLIC_API_URL ?? "";

export type FetchFn = (
  url: string,
  init?: {
    readonly method: string;
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
  },
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
    /** What the server found wrong with what was sent, one sentence each. */
    readonly problems: readonly string[] = [],
  ) {
    super(message);
  }
}

const NONSENSE = "The server's answer made no sense.";

/** Send one request and read its JSON, whatever the status. */
async function ask(
  fetchFn: FetchFn,
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  send?: unknown,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  let response;
  try {
    if (method === "GET") response = await fetchFn(url);
    else if (send === undefined) response = await fetchFn(url, { method });
    else {
      response = await fetchFn(url, {
        method,
        body: JSON.stringify(send),
        headers: { "content-type": "application/json" },
      });
    }
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

const settingsUrl = (base: string, deviceId: string) =>
  `${base}/api/devices/${encodeURIComponent(deviceId)}/settings`;

/** What can be changed about one phone. */
export async function fetchSettings(
  deviceId: string,
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<DeviceSettings> {
  const { ok, status, body } = await ask(fetchFn, settingsUrl(base, deviceId), "GET");
  if (status === 404) throw new ApiError("There is no such phone on the server.", status);
  if (!ok) throw new ApiError(`The server answered ${status}.`, status);
  const parsed = DeviceSettingsSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(NONSENSE, status);
  return parsed.data;
}

/**
 * Change a phone's settings to these. Answers with them as the server
 * saved them. If the server will not take them, the error carries why.
 */
export async function saveSettings(
  deviceId: string,
  settings: DeviceSettings,
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<DeviceSettings> {
  const { ok, status, body } = await ask(fetchFn, settingsUrl(base, deviceId), "PUT", settings);
  if (status === 404) throw new ApiError("There is no such phone on the server.", status);
  if (status === 400) {
    const refused = ApiErrorSchema.safeParse(body);
    const problems = refused.success ? (refused.data.problems ?? []) : [];
    throw new ApiError("The server would not take those settings.", status, problems);
  }
  if (!ok) throw new ApiError(`The server answered ${status}.`, status);
  const parsed = DeviceSettingsSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(NONSENSE, status);
  return parsed.data;
}

/** What the server found wrong with what was sent, if it said. */
function problemsIn(body: unknown): readonly string[] {
  const refused = ApiErrorSchema.safeParse(body);
  return refused.success ? (refused.data.problems ?? []) : [];
}

const deviceUrl = (base: string, deviceId: string) =>
  `${base}/api/devices/${encodeURIComponent(deviceId)}`;

/**
 * Add a phone, with its pair record. Answers with the id it was given. If
 * the server will not take it, the error carries why.
 */
export async function addPhone(
  phone: NewDevice,
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const { ok, status, body } = await ask(fetchFn, `${base}/api/devices`, "POST", phone);
  if (status === 409) throw new ApiError("That phone has already been added.", status);
  if (status === 400) {
    throw new ApiError("The server would not add that phone.", status, problemsIn(body));
  }
  if (status === 413) throw new ApiError("That file is too large to be a pairing.", status);
  if (!ok) throw new ApiError(`The server answered ${status}.`, status);
  const parsed = DeviceAddedSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(NONSENSE, status);
  return parsed.data.id;
}

/** Remove a phone. Its backups stay on the server; its pairing is destroyed. */
export async function removePhone(
  deviceId: string,
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  const { ok, status } = await ask(fetchFn, deviceUrl(base, deviceId), "DELETE");
  if (status === 404) throw new ApiError("There is no such phone on the server.", status);
  if (status === 409) {
    throw new ApiError("That phone is being backed up. Try again when it has finished.", status);
  }
  if (!ok) throw new ApiError(`The server answered ${status}.`, status);
}

/** Have the server look for a phone now. Nothing appears on the phone. */
export async function checkPhone(
  deviceId: string,
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<DeviceCheck> {
  const { ok, status, body } = await ask(fetchFn, `${deviceUrl(base, deviceId)}/check`, "POST");
  if (status === 404) throw new ApiError("There is no such phone on the server.", status);
  if (status === 409) {
    throw new ApiError("That phone is being backed up, so it is certainly there.", status);
  }
  if (!ok) throw new ApiError(`The server answered ${status}.`, status);
  const parsed = DeviceCheckSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(NONSENSE, status);
  return parsed.data;
}

/** Which build the server is, and where it keeps backups. */
export async function fetchServerInfo(
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<ServerInfo> {
  const { ok, status, body } = await ask(fetchFn, `${base}/api/server`, "GET");
  if (!ok) throw new ApiError(`The server answered ${status}.`, status);
  const parsed = ServerInfoSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(NONSENSE, status);
  return parsed.data;
}

export async function fetchServerSettings(
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<ServerSettings> {
  const { ok, status, body } = await ask(fetchFn, `${base}/api/settings`, "GET");
  if (!ok) throw new ApiError(`The server answered ${status}.`, status);
  const parsed = ServerSettingsSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(NONSENSE, status);
  return parsed.data;
}

/** Change some of the server's settings. Answers with all of them as saved. */
export async function saveServerSettings(
  settings: Partial<ServerSettings>,
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<ServerSettings> {
  const { ok, status, body } = await ask(fetchFn, `${base}/api/settings`, "PUT", settings);
  if (status === 400) {
    throw new ApiError("The server would not take those settings.", status, problemsIn(body));
  }
  if (!ok) throw new ApiError(`The server answered ${status}.`, status);
  const parsed = ServerSettingsSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(NONSENSE, status);
  return parsed.data;
}

/**
 * Stop the backup of a phone that is running. "not-running" if it had
 * already ended, which is as good.
 */
export async function stopBackup(
  deviceId: string,
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<"stopping" | "not-running"> {
  const { ok, status, body } = await ask(fetchFn, `${deviceUrl(base, deviceId)}/stop`, "POST");
  if (ok) {
    if (!BackupStoppingSchema.safeParse(body).success) throw new ApiError(NONSENSE, status);
    return "stopping";
  }
  if (status === 409 && errorCode(body) === "not-running") return "not-running";
  if (status === 404) throw new ApiError("There is no such phone on the server.", status);
  throw new ApiError(`The server answered ${status}.`, status);
}
