import { afterEach, describe, expect, it } from "vitest";
import { startApiServer, type ApiServer } from "../../src/api/ApiServer.js";
import type { BackupRequestResult, PlugInReportResult } from "../../src/daemon/Daemon.js";
import type { LogLevel } from "../../src/notify/Notifier.js";

let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function harness(
  answer: BackupRequestResult | Error = "started",
  plugInAnswer: PlugInReportResult = { outcome: "started" },
) {
  const asked: string[] = [];
  const pluggedIn: string[] = [];
  const logs: { level: LogLevel; message: string; fields: unknown }[] = [];
  server = await startApiServer({
    // Any free port.
    port: 0,
    requestBackup: (deviceId) => {
      asked.push(deviceId);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    reportPlugIn: (deviceId) => {
      pluggedIn.push(deviceId);
      return plugInAnswer;
    },
    log: (level, message, fields) => logs.push({ level, message, fields }),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const send = async (method: string, path: string, body?: string) => {
    const response = await fetch(`${base}${path}`, {
      method,
      ...(body !== undefined && { body }),
    });
    return {
      status: response.status,
      allow: response.headers.get("allow"),
      type: response.headers.get("content-type"),
      body: (await response.json()) as unknown,
    };
  };
  return { asked, pluggedIn, logs, send };
}

describe("the API", () => {
  it("says which port it is listening on", async () => {
    const h = await harness();
    expect(server?.port).toBeGreaterThan(0);
    expect(h.logs).toContainEqual({
      level: "info",
      message: "listening for requests",
      fields: { port: server?.port },
    });
  });

  it("starts a backup of the named phone and answers straight away", async () => {
    const h = await harness("started");
    expect(await h.send("POST", "/devices/mike/backup-now")).toEqual({
      status: 202,
      allow: null,
      type: "application/json",
      body: { status: "started" },
    });
    expect(h.asked).toEqual(["mike"]);
  });

  it("ignores whatever body the request carries", async () => {
    const h = await harness("started");
    const response = await h.send("POST", "/devices/mike/backup-now", '{"anything":"at all"}');
    expect(response.status).toBe(202);
    expect(h.asked).toEqual(["mike"]);
  });

  it("answers 404 for a phone it does not have", async () => {
    const h = await harness("unknown-device");
    expect(await h.send("POST", "/devices/laurel/backup-now")).toMatchObject({
      status: 404,
      body: { error: "unknown-device" },
    });
  });

  it("answers 409 while that phone is already being backed up", async () => {
    const h = await harness("already-running");
    expect(await h.send("POST", "/devices/mike/backup-now")).toMatchObject({
      status: 409,
      body: { error: "already-running" },
    });
    expect(h.logs).toContainEqual({
      level: "info",
      message: "request refused",
      fields: { device: "mike", action: "backup-now", reason: "already-running" },
    });
  });

  it("starts nothing for a GET, which a link preview or a browser could send", async () => {
    const h = await harness();
    expect(await h.send("GET", "/devices/mike/backup-now")).toMatchObject({
      status: 405,
      allow: "POST",
      body: { error: "method-not-allowed" },
    });
    expect(h.asked).toEqual([]);
  });

  it.each([
    "/",
    "/devices",
    "/devices/mike",
    "/devices/mike/backup-now/extra",
    "/devices/Mike/backup-now",
    "/devices/..%2Fmike/backup-now",
  ])("answers 404 for %s and asks for nothing", async (path) => {
    const h = await harness();
    expect(await h.send("POST", path)).toMatchObject({
      status: 404,
      body: { error: "not-found" },
    });
    expect(h.asked).toEqual([]);
  });

  it("answers 500, and says why in the log, if asking blows up", async () => {
    const h = await harness(new Error("no database"));
    expect(await h.send("POST", "/devices/mike/backup-now")).toMatchObject({
      status: 500,
      body: { error: "internal-error" },
    });
    expect(h.logs).toContainEqual({
      level: "error",
      message: "could not handle a request",
      fields: { device: "mike", action: "backup-now", error: "no database" },
    });
  });

  it("passes on a phone's word that it was plugged in, and says a backup started", async () => {
    const h = await harness("started", { outcome: "started" });
    expect(await h.send("POST", "/devices/mike/plugged-in")).toMatchObject({
      status: 202,
      body: { status: "started" },
    });
    expect(h.pluggedIn).toEqual(["mike"]);
    expect(h.asked).toEqual([]);
  });

  it("answers 200 with the reason when a plug-in starts nothing", async () => {
    const until = new Date("2026-11-25T06:08:22.000Z");
    const h = await harness("started", { outcome: "not-now", reason: "not-due", until });
    expect(await h.send("POST", "/devices/mike/plugged-in")).toEqual({
      status: 200,
      allow: null,
      type: "application/json",
      body: { status: "not-now", reason: "not-due", until: "2026-11-25T06:08:22.000Z" },
    });
  });

  it("leaves out the time when there is none to give", async () => {
    const h = await harness("started", { outcome: "not-now", reason: "backing-off" });
    expect((await h.send("POST", "/devices/mike/plugged-in")).body).toEqual({
      status: "not-now",
      reason: "backing-off",
    });
  });

  it.each([
    [{ outcome: "unknown-device" } as const, 404],
    [{ outcome: "already-running" } as const, 409],
  ])("answers a refused plug-in report %j with %i", async (answer, status) => {
    const h = await harness("started", answer);
    expect(await h.send("POST", "/devices/mike/plugged-in")).toMatchObject({
      status,
      body: { error: answer.outcome },
    });
  });

  it("starts nothing for a GET of the plug-in address either", async () => {
    const h = await harness();
    expect((await h.send("GET", "/devices/mike/plugged-in")).status).toBe(405);
    expect(h.pluggedIn).toEqual([]);
  });

  it("stops answering once closed", async () => {
    const h = await harness();
    const port = server?.port;
    await server?.close();
    server = undefined;
    await expect(fetch(`http://127.0.0.1:${port}/devices/mike/backup-now`, { method: "POST" })).rejects.toThrow();
    expect(h.asked).toEqual([]);
  });
});
