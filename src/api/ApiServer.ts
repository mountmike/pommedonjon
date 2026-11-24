import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BackupRequestResult } from "../daemon/Daemon.js";
import type { Logger } from "../notify/Notifier.js";

export interface ApiDeps {
  /** Ask for a phone to be backed up now. */
  readonly requestBackup: (deviceId: string) => BackupRequestResult;
  readonly log: Logger;
}

export interface ApiServer {
  /** The port actually listened on (useful when 0 was asked for). */
  readonly port: number;
  close(): Promise<void>;
}

/** `/devices/<id>/backup-now`, with the id in the form the config allows. */
const BACKUP_NOW = /^\/devices\/([a-z0-9][a-z0-9-]{0,31})\/backup-now\/?$/;

const STATUS: Record<BackupRequestResult, number> = {
  started: 202,
  "unknown-device": 404,
  "already-running": 409,
};

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
 * One request is understood: `POST /devices/<id>/backup-now`. It answers
 * as soon as the daemon has decided, not when the backup ends:
 *
 * - 202 `{"status":"started"}`
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
    const match = BACKUP_NOW.exec(path);
    if (!match?.[1]) {
      reply(res, 404, { error: "not-found" });
      return;
    }
    if (req.method !== "POST") {
      reply(res, 405, { error: "method-not-allowed" }, { allow: "POST" });
      return;
    }

    const deviceId = match[1];
    let result: BackupRequestResult;
    try {
      result = deps.requestBackup(deviceId);
    } catch (error) {
      deps.log("error", "could not handle a backup request", {
        device: deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
      reply(res, 500, { error: "internal-error" });
      return;
    }
    if (result === "started") {
      reply(res, STATUS[result], { status: result });
    } else {
      deps.log("info", "backup request refused", { device: deviceId, reason: result });
      reply(res, STATUS[result], { error: result });
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
      options.log("info", "listening for backup requests", { port });
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
