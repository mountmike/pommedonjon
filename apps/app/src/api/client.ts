import {
  DeviceListSchema,
  type DeviceSummary,
} from "@pommedonjon/api-contract";

/**
 * Where the server is. The web app is served by the server itself, so the
 * API is at the same address and this is empty. Set EXPO_PUBLIC_API_URL to
 * point a development build somewhere else.
 */
export const API_BASE: string = process.env.EXPO_PUBLIC_API_URL ?? "";

export type FetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** A reply that was not what the contract promises, or not a success. */
export class ApiError extends Error {
  override readonly name = "ApiError";
}

/**
 * Every phone and its state. Whatever comes back is checked against the
 * contract before any of it is shown.
 */
export async function fetchDevices(
  base: string = API_BASE,
  fetchFn: FetchFn = fetch,
): Promise<DeviceSummary[]> {
  let response;
  try {
    response = await fetchFn(`${base}/api/devices`);
  } catch {
    throw new ApiError("Can't reach the server.");
  }
  if (!response.ok) throw new ApiError(`The server answered ${response.status}.`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("The server's answer made no sense.");
  }
  const parsed = DeviceListSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("The server's answer made no sense.");
  return parsed.data.devices;
}
