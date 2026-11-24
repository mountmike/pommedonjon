import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BackupRequestResult, PlugInReportResult } from "../daemon/Daemon.js";
import type { Logger } from "../notify/Notifier.js";

export interface ApiDeps {
  /** Ask for a phone to be backed up now. */
  readonly requestBackup: (deviceId: string) => BackupRequestResult;
  /** Tell the daemon a phone has just been plugged in. */
  readonly reportPlugIn: (deviceId: string) => PlugInReportResult;
  readonly log: Logger;
}

export interface ApiServer {
  /** The port actually listened on (useful when 0 was asked for). */
  readonly port: number;
  close(): Promise<void>;
}

/** `/devices/<id>/<action>`, with the id in the form the config allows. */
const DEVICE_ACTION = /^\/devices\/([a-z0-9][a-z0-9-]{0,31})\/(backup-now|plugged-in)\/?$/;

const REFUSAL_STATUS = { "unknown-device": 404, "already-running": 409 } as const;

function reply(
  res: ServerResponse,
  status: number,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/**
 * The request handler, separate from the listening socket so it can be
 * tested and reused.
 *
 * Two requests are understood, both answered as soon as the daemon has
 * decided, not when a backup ends:
 *
 * `POST /devices/<id>/backup-now`: back the phone up now, whatever the
 * schedule says. For a button.
 *
 * `POST /devices/<id>/plugged-in`: the phone has just been plugged in; back
 * it up if the schedule allows one now. For an automation that fires at
 * every plug-in.
 *
 * - 202 `{"status":"started"}`
 * - 200 `{"status":"not-now","reason":"not-due","until":"..."}` (plugged-in only)
 * - 404 `{"error":"unknown-device"}`
 * - 409 `{"error":"already-running"}`
 *
 * There is no authentication. That is deliberate for now and is why the
 * interface is off unless a port is configured.
 */
export function createApiHandler(deps: ApiDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    // Nothing is read from the body; let it drain so the socket can be reused.
    req.resume();

    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const match = DEVICE_ACTION.exec(path);
    const deviceId = match?.[1];
    const action = match?.[2];
    if (deviceId === undefined || action === undefined) {
      reply(res, 404, { error: "not-found" });
      return;
    }
    if (req.method !== "POST") {
      reply(res, 405, { error: "method-not-allowed" }, { allow: "POST" });
      return;
    }

    let result: PlugInReportResult;
    try {
      result =
        action === "backup-now"
          ? { outcome: deps.requestBackup(deviceId) }
          : deps.reportPlugIn(deviceId);
    } catch (error) {
      deps.log("error", "could not handle a request", {
        device: deviceId,
        action,
        error: error instanceof Error ? error.message : String(error),
      });
      reply(res, 500, { error: "internal-error" });
      return;
    }

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
      options.log("info", "listening for requests", { port });
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
