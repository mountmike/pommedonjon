import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BackupStartedSchema,
  DeviceDetailSchema,
  DeviceListSchema,
  type DeviceDetail,
} from "@pommedonjon/api-contract";
import { afterEach, describe, expect, it } from "vitest";
import { startApiServer, type ApiServer } from "../../src/api/ApiServer.js";
import type { BackupRequestResult, PlugInReportResult } from "../../src/daemon/Daemon.js";
import type { LogLevel } from "../../src/log.js";

let server: ApiServer | undefined;
let webDir: string | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (webDir) await rm(webDir, { recursive: true, force: true });
  webDir = undefined;
});

const MIKE: DeviceDetail = {
  id: "mike",
  name: "Mike's iPhone",
  state: "backed-up",
  lastBackupAt: "2026-11-24T10:24:20.700Z",
  dueAt: "2026-11-25T06:24:20.700Z",
  waiting: { reason: "not-due", until: "2026-11-25T06:24:20.700Z" },
  run: null,
  problem: null,
  lastAttempt: null,
  recentRuns: [],
};

/** A stand-in for the built web app. */
async function fakeWebApp(): Promise<string> {
  webDir = await mkdtemp(path.join(tmpdir(), "pommedonjon-web-"));
  await mkdir(path.join(webDir, "_expo", "static", "js"), { recursive: true });
  await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>pommedonjon</title>");
  await writeFile(path.join(webDir, "_expo", "static", "js", "app-abc123.js"), "console.log(1)");
  await writeFile(path.join(webDir, "favicon.ico"), "icon");
  return webDir;
}

async function harness(
  answer: BackupRequestResult | Error = "started",
  plugInAnswer: PlugInReportResult = { outcome: "started" },
  web?: string,
) {
  const asked: string[] = [];
  const pluggedIn: string[] = [];
  const logs: { level: LogLevel; message: string; fields: unknown }[] = [];
  server = await startApiServer({
    // Any free port.
    port: 0,
    devices: {
      list: () => {
        const { recentRuns: _runs, ...summary } = MIKE;
        return [summary];
      },
      get: (deviceId) => (deviceId === "mike" ? MIKE : undefined),
    },
    ...(web !== undefined && { webDir: web }),
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
  /** For replies that are not JSON: the web app's files. */
  const fetchRaw = async (path: string, method = "GET") => {
    const response = await fetch(`${base}${path}`, { method });
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      cache: response.headers.get("cache-control"),
      text: await response.text(),
    };
  };
  return { asked, pluggedIn, logs, send, fetchRaw };
}

describe("the API", () => {
  it("says which port it is listening on", async () => {
    const h = await harness();
    expect(server?.port).toBeGreaterThan(0);
    expect(h.logs).toContainEqual({
      level: "info",
      message: "listening for requests",
      fields: { port: server?.port, webApp: false },
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
      fields: { method: "POST", path: "/devices/mike/backup-now", error: "no database" },
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

describe("the API for the app", () => {
  it("lists every phone, in the shape the contract promises", async () => {
    const h = await harness();
    const response = await h.send("GET", "/api/devices");
    expect(response).toMatchObject({ status: 200, type: "application/json" });
    expect(DeviceListSchema.parse(response.body).devices.map((device) => device.id)).toEqual([
      "mike",
    ]);
  });

  it("gives one phone with its recent runs", async () => {
    const h = await harness();
    const response = await h.send("GET", "/api/devices/mike");
    expect(response.status).toBe(200);
    expect(DeviceDetailSchema.parse(response.body)).toEqual(MIKE);
  });

  it("answers 404 for a phone it does not have", async () => {
    const h = await harness();
    expect(await h.send("GET", "/api/devices/laurel")).toMatchObject({
      status: 404,
      body: { error: "unknown-device" },
    });
  });

  it("is never cached: what a phone is doing changes by the second", async () => {
    const h = await harness();
    expect((await h.fetchRaw("/api/devices")).cache).toBe("no-store");
  });

  it("only reads: anything but a GET is refused", async () => {
    const h = await harness();
    expect(await h.send("POST", "/api/devices")).toMatchObject({ status: 405, allow: "GET" });
    expect(await h.send("DELETE", "/api/devices/mike")).toMatchObject({ status: 405 });
  });

  it("starts a backup when the app asks for one, and answers straight away", async () => {
    const h = await harness("started");
    const answer = await h.send("POST", "/api/devices/mike/backup-now");
    expect(answer).toMatchObject({ status: 202, type: "application/json" });
    expect(BackupStartedSchema.parse(answer.body)).toEqual({ status: "started" });
    expect(h.asked).toEqual(["mike"]);
  });

  it("refuses a backup of a phone it does not have, or one already being backed up", async () => {
    const unknown = await harness("unknown-device");
    expect(await unknown.send("POST", "/api/devices/nobody/backup-now")).toMatchObject({
      status: 404,
      body: { error: "unknown-device" },
    });
    await server?.close();

    const busy = await harness("already-running");
    expect(await busy.send("POST", "/api/devices/mike/backup-now")).toMatchObject({
      status: 409,
      body: { error: "already-running" },
    });
  });

  it("starts nothing for a GET of the app's back-up-now address", async () => {
    const h = await harness();
    expect(await h.send("GET", "/api/devices/mike/backup-now")).toMatchObject({
      status: 405,
      allow: "POST",
    });
    expect(h.asked).toEqual([]);
  });

  it.each(["/api", "/api/", "/api/phones", "/api/devices/mike/runs", "/api/devices/Mike"])(
    "answers 404 as JSON for %s, even with a web app to fall back on",
    async (path) => {
      const h = await harness("started", { outcome: "started" }, await fakeWebApp());
      expect(await h.send("GET", path)).toMatchObject({
        status: 404,
        type: "application/json",
        body: { error: "not-found" },
      });
    },
  );
});

describe("serving the web app", () => {
  const withWeb = async () => harness("started", { outcome: "started" }, await fakeWebApp());

  it("says so when it starts", async () => {
    const h = await withWeb();
    expect(h.logs[0]).toMatchObject({ fields: { webApp: true } });
  });

  it("serves the page at the root, and keeps it fresh", async () => {
    const h = await withWeb();
    expect(await h.fetchRaw("/")).toEqual({
      status: 200,
      type: "text/html; charset=utf-8",
      cache: "no-cache",
      text: "<!doctype html><title>pommedonjon</title>",
    });
  });

  it("serves a built asset with its type, to be kept for good", async () => {
    const h = await withWeb();
    expect(await h.fetchRaw("/_expo/static/js/app-abc123.js")).toEqual({
      status: 200,
      type: "text/javascript; charset=utf-8",
      cache: "public, max-age=31536000, immutable",
      text: "console.log(1)",
    });
  });

  it("gives the page for an address inside the app, which does its own routing", async () => {
    const h = await withWeb();
    expect(await h.fetchRaw("/phones/mike")).toMatchObject({
      status: 200,
      type: "text/html; charset=utf-8",
    });
  });

  it("answers 404 for an asset that is not there, instead of returning the page", async () => {
    const h = await withWeb();
    expect(await h.fetchRaw("/_expo/static/js/gone.js")).toMatchObject({ status: 404 });
  });

  it("answers a HEAD without the body", async () => {
    const h = await withWeb();
    expect(await h.fetchRaw("/", "HEAD")).toMatchObject({ status: 200, text: "" });
  });

  it.each([
    "/../secret.txt",
    "/..%2Fsecret.txt",
    "/%2e%2e/%2e%2e/secret.txt",
    "/_expo/../../secret.txt",
    "/%00",
    "/%E0%A4%A",
  ])("never serves anything outside the web app's directory: %s", async (path) => {
    const h = await withWeb();
    await writeFile(`${webDir}/../secret.txt`, "the pair record");
    const response = await h.fetchRaw(path);
    expect(response.text).not.toContain("the pair record");
    await rm(`${webDir}/../secret.txt`, { force: true });
  });

  it("does not let a POST fetch the page", async () => {
    const h = await withWeb();
    expect(await h.send("POST", "/")).toMatchObject({ status: 404, body: { error: "not-found" } });
  });

  it("answers 404 for a page when there is no web app", async () => {
    const h = await harness();
    expect(await h.send("GET", "/")).toMatchObject({ status: 404, body: { error: "not-found" } });
  });
});
