import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { BackupRequestResult, PlugInReportResult } from "../daemon/Daemon.js";
import type { DeviceSettings } from "@pommedonjon/api-contract";
import type { Logger } from "../log.js";
import type { ChangeResult } from "../settings/DeviceDirectory.js";
import { plainAddress } from "../discovery/PhoneIdentifier.js";
import type { DeviceReader } from "./DeviceReader.js";
import type { PhoneManager } from "./PhoneManager.js";

export interface ApiDeps {
  /** What is known about each phone, for the app's screens. */
  readonly devices: DeviceReader;
  /** What can be changed about each phone from the app. */
  readonly settings: {
    /** Undefined for a phone that is not configured. */
    get(deviceId: string): DeviceSettings | undefined;
    /** Undefined for a phone that is not configured. */
    change(deviceId: string, wanted: unknown): ChangeResult | undefined;
  };
  /** Adding, removing and checking phones, and the server's own settings. */
  readonly phones: PhoneManager;
  /** Ask for a phone to be backed up now. */
  readonly requestBackup: (deviceId: string) => BackupRequestResult;
  /**
   * Which phone a request came from, by its address. Undefined when it is
   * none of them. Left out, nobody is ever recognised.
   */
  readonly whoIsAt?: (address: string) => Promise<string | undefined>;
  /** The app was opened on this phone: back it up if one is wanted now. */
  readonly reportAppOpen?: (deviceId: string) => PlugInReportResult;
  /**
   * Take the caller's address from X-Forwarded-For, for a server behind a
   * reverse proxy. Only safe when nothing else can reach the port.
   */
  readonly trustForwardedFor?: boolean;
  /** Stop the backup of a phone that is running. */
  readonly stopBackup: (deviceId: string) => "stopping" | "unknown-device" | "not-running";
  /** Tell the daemon a phone has just been plugged in. */
  readonly reportPlugIn: (deviceId: string) => PlugInReportResult;
  /**
   * The built web app, if there is one to serve: a directory holding its
   * `index.html`. Without it only the API answers.
   */
  readonly webDir?: string;
  readonly log: Logger;
}

export interface ApiServer {
  /** The port actually listened on (useful when 0 was asked for). */
  readonly port: number;
  close(): Promise<void>;
}

const DEVICE_ID = "[a-z0-9][a-z0-9-]{0,31}";
/** `/api/devices/<id>`, with the id in the form the config allows. */
const API_DEVICE = new RegExp(`^/api/devices/(${DEVICE_ID})/?$`);
/** `/api/devices/<id>/backup-now`: the app's "Back up now". */
const API_BACKUP_NOW = new RegExp(`^/api/devices/(${DEVICE_ID})/backup-now/?$`);
/** `/api/devices/<id>/settings`: what the app can change about a phone. */
const API_SETTINGS = new RegExp(`^/api/devices/(${DEVICE_ID})/settings/?$`);
/** `/api/devices/<id>/stop`: stop the backup of a phone that is running. */
const API_STOP = new RegExp(`^/api/devices/(${DEVICE_ID})/stop/?$`);
/** `/api/devices/<id>/check`: look for a phone now, without starting anything. */
const API_CHECK = new RegExp(`^/api/devices/(${DEVICE_ID})/check/?$`);
/** Settings are a few hundred bytes; anything much larger is not settings. */
const MAX_BODY_BYTES = 16 * 1024;
/** A pair record in base64, with room to spare. */
const MAX_PHONE_BODY_BYTES = 128 * 1024;
/** `/devices/<id>/<action>`: the requests the proof of concept's Shortcuts send. */
const DEVICE_ACTION = new RegExp(`^/devices/(${DEVICE_ID})/(backup-now|plugged-in)/?$`);

const REFUSAL_STATUS = { "unknown-device": 404, "already-running": 409 } as const;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

function reply(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    // What a phone is doing changes by the second.
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** The request's body as JSON, or why it could not be read. */
async function readJson(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) return { ok: false, status: 413, error: "too-large" };
    chunks.push(chunk);
  }
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, status: 400, error: "invalid-json" };
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Which file of the web app a path means, or undefined if none. A path
 * with no file behind it gets the app's `index.html`, because the app does
 * its own routing; a missing asset does not, so a broken link fails
 * plainly instead of returning a page.
 */
async function webFile(webDir: string, pathname: string): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const root = path.resolve(webDir);
  const wanted = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  // Nothing outside the web app's own directory is ever served.
  if (wanted !== root && !wanted.startsWith(`${root}${path.sep}`)) return undefined;

  if (path.extname(wanted) !== "") return (await isFile(wanted)) ? wanted : undefined;
  for (const candidate of [`${wanted}.html`, path.join(wanted, "index.html")]) {
    if (await isFile(candidate)) return candidate;
  }
  const index = path.join(root, "index.html");
  return (await isFile(index)) ? index : undefined;
}

async function serveWeb(
  webDir: string,
  pathname: string,
  method: string,
  res: ServerResponse,
): Promise<boolean> {
  const file = await webFile(webDir, pathname);
  if (file === undefined) return false;
  const { size } = await stat(file);
  const isPage = path.extname(file) === ".html";
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    "content-length": size,
    // Built assets carry a hash of their contents in their names, so they
    // can be kept for good; the pages that point at them must stay fresh.
    "cache-control": isPage ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (method === "HEAD") {
    res.end();
    return true;
  }
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on("error", reject).on("end", resolve).pipe(res);
  });
  return true;
}

/**
 * The request handler, separate from the listening socket so it can be
 * tested and reused.
 *
 * For the app, under `/api` (shapes in `@pommedonjon/api-contract`):
 *
 * - `GET /api/devices`: every phone and its state.
 * - `GET /api/devices/<id>`: one phone, with its recent runs. 404
 *   `{"error":"unknown-device"}` for a phone that is not configured.
 * - `GET /api/devices/<id>/settings`: what can be changed about a phone.
 * - `PUT /api/devices/<id>/settings`: change it, sending all of it. 200
 *   with the settings as saved, 400 `{"error":"invalid-settings",
 *   "problems":[...]}`, 404 `{"error":"unknown-device"}`.
 * - `POST /api/devices/<id>/stop`: stop the backup of this phone that is
 *   running. 202 `{"status":"stopping"}`, 409 `{"error":"not-running"}`.
 * - `POST /api/devices`: add a phone, with its pair record. 201 `{"id":...}`,
 *   400 `{"error":"invalid-phone","problems":[...]}`, 409
 *   `{"error":"already-added"}`.
 * - `DELETE /api/devices/<id>`: remove a phone and destroy its pair record.
 *   Its backups stay. 200 `{"status":"removed"}`, 404, 409 mid-backup.
 * - `POST /api/devices/<id>/check`: look for the phone now and say what it
 *   reports. Nothing appears on the phone. 409 mid-backup.
 * - `GET /api/me`: which phone the request came from, if one of them.
 * - `POST /api/me/opened`: the app was opened; if that was on one of the
 *   phones and a backup is wanted, one starts.
 * - `GET /api/server`: which build this is and where backups are kept.
 * - `GET /api/settings`, `PUT /api/settings`: the server's own settings.
 * - `POST /api/devices/<id>/backup-now`: back the phone up now, whatever
 *   the schedule says. 202 `{"status":"started"}`, 404
 *   `{"error":"unknown-device"}`, 409 `{"error":"already-running"}`.
 *
 * For the phone to ask for a backup, answered as soon as the daemon has
 * decided, not when a backup ends:
 *
 * - `POST /devices/<id>/backup-now`: back the phone up now, whatever the
 *   schedule says.
 * - `POST /devices/<id>/plugged-in`: the phone has just been plugged in;
 *   back it up if the schedule allows one now.
 *
 *   202 `{"status":"started"}`, 200 `{"status":"not-now",...}` (plugged-in
 *   only), 404 `{"error":"unknown-device"}`, 409 `{"error":"already-running"}`.
 *
 * Any other GET is the web app, when there is one to serve.
 *
 * There is no authentication. That is deliberate for now and is why the
 * interface is off unless a port is configured.
 */
export function createApiHandler(deps: ApiDeps) {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const reading = method === "GET" || method === "HEAD";

    const settingsOf = API_SETTINGS.exec(pathname)?.[1];
    if (settingsOf !== undefined && method === "PUT") {
      await changeSettings(req, res, settingsOf);
      return;
    }
    const isDeviceList = pathname === "/api/devices" || pathname === "/api/devices/";
    if (isDeviceList && method === "POST") {
      await addPhone(req, res);
      return;
    }
    if (pathname === "/api/settings" && method === "PUT") {
      await changeServerSettings(req, res);
      return;
    }
    // Nothing else reads the body; let it drain so the socket can be reused.
    req.resume();

    if (pathname === "/api/me" || pathname === "/api/me/opened") {
      const opened = pathname === "/api/me/opened";
      if (opened ? method !== "POST" : !reading) {
        reply(res, 405, { error: "method-not-allowed" }, { allow: opened ? "POST" : "GET" });
        return;
      }
      const deviceId = (await whoAsks(req)) ?? null;
      if (!opened) {
        reply(res, 200, { deviceId });
        return;
      }
      const backup =
        deviceId === null || !deps.reportAppOpen ? null : deps.reportAppOpen(deviceId).outcome;
      reply(res, 200, { deviceId, backup });
      return;
    }
    if (pathname === "/api/settings") {
      if (reading) reply(res, 200, deps.phones.settings());
      else reply(res, 405, { error: "method-not-allowed" }, { allow: "GET, PUT" });
      return;
    }
    if (pathname === "/api/server") {
      if (reading) reply(res, 200, deps.phones.info());
      else reply(res, 405, { error: "method-not-allowed" }, { allow: "GET" });
      return;
    }
    const stopOf = API_STOP.exec(pathname)?.[1];
    if (stopOf !== undefined) {
      if (method !== "POST") {
        reply(res, 405, { error: "method-not-allowed" }, { allow: "POST" });
        return;
      }
      const outcome = deps.stopBackup(stopOf);
      if (outcome === "stopping") reply(res, 202, { status: "stopping" });
      else reply(res, outcome === "unknown-device" ? 404 : 409, { error: outcome });
      return;
    }
    const checkOf = API_CHECK.exec(pathname)?.[1];
    if (checkOf !== undefined) {
      if (method !== "POST") {
        reply(res, 405, { error: "method-not-allowed" }, { allow: "POST" });
        return;
      }
      const found = await deps.phones.check(checkOf);
      if (found === undefined) reply(res, 404, { error: "unknown-device" });
      else if (found === "already-running") reply(res, 409, { error: "already-running" });
      else reply(res, 200, found);
      return;
    }
    const removeOf = API_DEVICE.exec(pathname)?.[1];
    if (removeOf !== undefined && method === "DELETE") {
      const outcome = deps.phones.remove(removeOf);
      if (outcome === "removed") reply(res, 200, { status: "removed" });
      else reply(res, REFUSAL_STATUS[outcome], { error: outcome });
      return;
    }

    if (settingsOf !== undefined) {
      if (!reading) {
        reply(res, 405, { error: "method-not-allowed" }, { allow: "GET, PUT" });
        return;
      }
      const settings = deps.settings.get(settingsOf);
      if (settings) reply(res, 200, settings);
      else reply(res, 404, { error: "unknown-device" });
      return;
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const backupNow = API_BACKUP_NOW.exec(pathname)?.[1];
      if (backupNow !== undefined) {
        if (method === "POST") act(res, backupNow, "backup-now");
        else reply(res, 405, { error: "method-not-allowed" }, { allow: "POST" });
        return;
      }
      const device = API_DEVICE.exec(pathname)?.[1];
      const isList = pathname === "/api/devices" || pathname === "/api/devices/";
      if (!isList && device === undefined) {
        reply(res, 404, { error: "not-found" });
      } else if (!reading) {
        reply(
          res,
          405,
          { error: "method-not-allowed" },
          { allow: isList ? "GET, POST" : "GET, DELETE" },
        );
      } else if (isList) {
        reply(res, 200, { devices: deps.devices.list() });
      } else {
        const detail = deps.devices.get(device ?? "");
        if (detail) reply(res, 200, detail);
        else reply(res, 404, { error: "unknown-device" });
      }
      return;
    }

    const action = DEVICE_ACTION.exec(pathname);
    if (action?.[1] !== undefined && action[2] !== undefined) {
      if (method !== "POST") {
        reply(res, 405, { error: "method-not-allowed" }, { allow: "POST" });
        return;
      }
      act(res, action[1], action[2]);
      return;
    }

    if (reading && deps.webDir !== undefined) {
      if (await serveWeb(deps.webDir, pathname, method, res)) return;
    }
    reply(res, 404, { error: "not-found" });
  }

  async function changeSettings(
    req: IncomingMessage,
    res: ServerResponse,
    deviceId: string,
  ): Promise<void> {
    const sent = await readJson(req);
    if (!sent.ok) {
      // Whatever is left of the body is not wanted.
      req.resume();
      reply(res, sent.status, { error: sent.error });
      return;
    }
    const result = deps.settings.change(deviceId, sent.body);
    if (result === undefined) {
      reply(res, 404, { error: "unknown-device" });
    } else if (!result.ok) {
      reply(res, 400, { error: "invalid-settings", problems: result.problems });
    } else {
      deps.log("info", "settings changed", { device: deviceId, settings: result.settings });
      reply(res, 200, result.settings);
    }
  }

  /** Which of the phones this request came from, if any. */
  async function whoAsks(req: IncomingMessage): Promise<string | undefined> {
    if (!deps.whoIsAt) return undefined;
    const forwarded = req.headers["x-forwarded-for"];
    // A proxy adds the address it saw to the end of the list. Everything
    // before that is whatever the caller chose to send, so only the last
    // entry is the proxy's own word.
    const seenByProxy = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded)
      ?.split(",")
      .at(-1)
      ?.trim();
    const address =
      deps.trustForwardedFor && seenByProxy !== undefined && seenByProxy !== ""
        ? seenByProxy
        : plainAddress(req.socket.remoteAddress);
    return address === undefined ? undefined : deps.whoIsAt(address);
  }

  async function addPhone(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sent = await readJson(req, MAX_PHONE_BODY_BYTES);
    if (!sent.ok) {
      req.resume();
      reply(res, sent.status, { error: sent.error });
      return;
    }
    const result = await deps.phones.add(sent.body);
    if (result.outcome === "added") reply(res, 201, { id: result.id });
    else if (result.outcome === "already-added") reply(res, 409, { error: "already-added" });
    else reply(res, 400, { error: "invalid-phone", problems: result.problems });
  }

  async function changeServerSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sent = await readJson(req);
    if (!sent.ok) {
      req.resume();
      reply(res, sent.status, { error: sent.error });
      return;
    }
    const result = deps.phones.changeSettings(sent.body);
    if (result.ok) reply(res, 200, result.settings);
    else reply(res, 400, { error: "invalid-settings", problems: result.problems });
  }

  function act(res: ServerResponse, deviceId: string, action: string): void {
    const result: PlugInReportResult =
      action === "backup-now"
        ? { outcome: deps.requestBackup(deviceId) }
        : deps.reportPlugIn(deviceId);

    switch (result.outcome) {
      case "started":
        reply(res, 202, { status: "started" });
        return;
      case "not-now":
        reply(res, 200, {
          status: "not-now",
          reason: result.reason,
          ...(result.until && { until: result.until.toISOString() }),
        });
        return;
      default:
        deps.log("info", "request refused", { device: deviceId, action, reason: result.outcome });
        reply(res, REFUSAL_STATUS[result.outcome], { error: result.outcome });
    }
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((error: unknown) => {
      deps.log("error", "could not handle a request", {
        method: req.method,
        path: req.url,
        error: error instanceof Error ? error.message : String(error),
      });
      if (res.headersSent) res.destroy();
      else reply(res, 500, { error: "internal-error" });
    });
  };
}

/** Listen on a port and serve the API until closed. */
export function startApiServer(options: ApiDeps & { readonly port: number }): Promise<ApiServer> {
  const server = createServer(createApiHandler(options));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      server.off("error", reject);
      const { port } = server.address() as AddressInfo;
      options.log("info", "listening for requests", {
        port,
        webApp: options.webDir !== undefined,
      });
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // A phone's keep-alive connection must not hold the daemon open.
            server.closeAllConnections();
          }),
      });
    });
  });
}
