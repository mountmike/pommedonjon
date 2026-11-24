import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BackupStartedSchema,
  BackupStoppingSchema,
  DeviceDetailSchema,
  DeviceListSchema,
  DeviceAddedSchema,
  DeviceCheckSchema,
  DeviceSettingsSchema,
  ServerInfoSchema,
  ServerSettingsSchema,
  type DeviceCheck,
  type DeviceDetail,
  type DeviceSettings,
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

const SETTINGS: DeviceSettings = {
  name: "Mike's iPhone",
  automatic: true,
  dueAfterHours: 20,
  startWhenPluggedIn: true,
  pluggedInWindowMinutes: 30,
  startWhenUnlockedAfterHours: 4,
  startOnChargerAfterHours: 24,
  quietHours: { start: "22:00", end: "07:00" },
  staleAfterHours: 72,
};

const CHECK: DeviceCheck = {
  reachable: true,
  paired: true,
  encryptionOn: true,
  model: "iPhone17,5",
  osVersion: "26.6.1",
  batteryPercent: 80,
  onCharger: false,
  locked: true,
  problem: null,
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
  const changed: { deviceId: string; wanted: unknown }[] = [];
  const added: unknown[] = [];
  const removed: string[] = [];
  const stopped: string[] = [];
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
    settings: {
      get: (deviceId) => (deviceId === "mike" ? SETTINGS : undefined),
      change: (deviceId, wanted) => {
        if (deviceId !== "mike") return undefined;
        changed.push({ deviceId, wanted });
        const name = (wanted as { name?: unknown }).name;
        return name === ""
          ? { ok: false, problems: ["name must not be empty"] }
          : { ok: true, settings: { ...SETTINGS, ...(wanted as Partial<DeviceSettings>) } };
      },
    },
    phones: {
      add: (wanted) => {
        added.push(wanted);
        const name = (wanted as { name?: unknown }).name;
        if (name === "") {
          return Promise.resolve({ outcome: "invalid", problems: ["name must not be empty"] });
        }
        if (name === "Mike's iPhone") return Promise.resolve({ outcome: "already-added" });
        return Promise.resolve({ outcome: "added", id: "laurels-iphone" });
      },
      remove: (deviceId) => {
        if (deviceId === "busy") return "already-running";
        if (deviceId !== "mike") return "unknown-device";
        removed.push(deviceId);
        return "removed";
      },
      check: (deviceId) =>
        Promise.resolve(
          deviceId === "busy" ? "already-running" : deviceId === "mike" ? CHECK : undefined,
        ),
      info: () => ({ version: "0.3.0 (build test)", backupRoot: "/backups", phones: 1 }),
      settings: () => ({ discoveryRanges: ["192.168.1.0/24"], pollIntervalSeconds: 120 }),
      changeSettings: (wanted) => {
        const ranges = (wanted as { discoveryRanges?: unknown }).discoveryRanges;
        return Array.isArray(ranges)
          ? { ok: true, settings: { discoveryRanges: ranges as string[], pollIntervalSeconds: 120 } }
          : { ok: false, problems: ["discoveryRanges must be a list"] };
      },
    },
    ...(web !== undefined && { webDir: web }),
    stopBackup: (deviceId) => {
      if (deviceId !== "mike") return deviceId === "idle" ? "not-running" : "unknown-device";
      stopped.push(deviceId);
      return "stopping";
    },
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
  return { asked, changed, added, removed, stopped, pluggedIn, logs, send, fetchRaw };
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

  it("refuses a method an address does not take", async () => {
    const h = await harness();
    expect(await h.send("PUT", "/api/devices", "{}")).toMatchObject({
      status: 405,
      allow: "GET, POST",
    });
    expect(await h.send("PUT", "/api/devices/mike", "{}")).toMatchObject({
      status: 405,
      allow: "GET, DELETE",
    });
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

describe("the API for a phone's settings", () => {
  it("gives what can be changed about a phone, in the shape the contract promises", async () => {
    const h = await harness();
    const answer = await h.send("GET", "/api/devices/mike/settings");
    expect(answer.status).toBe(200);
    expect(DeviceSettingsSchema.parse(answer.body)).toEqual(SETTINGS);
  });

  it("changes them to what was sent, and answers with them as saved", async () => {
    const h = await harness();
    const wanted = { ...SETTINGS, name: "Mike's phone", dueAfterHours: 44 };
    const answer = await h.send("PUT", "/api/devices/mike/settings", JSON.stringify(wanted));
    expect(answer).toMatchObject({ status: 200, body: wanted });
    expect(h.changed).toEqual([{ deviceId: "mike", wanted }]);
    expect(h.logs).toContainEqual({
      level: "info",
      message: "settings changed",
      fields: { device: "mike", settings: wanted },
    });
  });

  it("says what is wrong with settings it will not take", async () => {
    const h = await harness();
    const answer = await h.send("PUT", "/api/devices/mike/settings", JSON.stringify({ ...SETTINGS, name: "" }));
    expect(answer).toMatchObject({
      status: 400,
      body: { error: "invalid-settings", problems: ["name must not be empty"] },
    });
  });

  it("refuses a body that is not JSON, without asking for any change", async () => {
    const h = await harness();
    expect(await h.send("PUT", "/api/devices/mike/settings", "back up more")).toMatchObject({
      status: 400,
      body: { error: "invalid-json" },
    });
    expect(await h.send("PUT", "/api/devices/mike/settings")).toMatchObject({ status: 400 });
    expect(h.changed).toEqual([]);
  });

  it("refuses a body far too large to be settings", async () => {
    const h = await harness();
    const huge = JSON.stringify({ ...SETTINGS, name: "x".repeat(20_000) });
    expect(await h.send("PUT", "/api/devices/mike/settings", huge)).toMatchObject({
      status: 413,
      body: { error: "too-large" },
    });
    expect(h.changed).toEqual([]);
  });

  it("answers 404 for a phone it does not have, reading or changing", async () => {
    const h = await harness();
    const missing = { status: 404, body: { error: "unknown-device" } };
    expect(await h.send("GET", "/api/devices/nobody/settings")).toMatchObject(missing);
    expect(
      await h.send("PUT", "/api/devices/nobody/settings", JSON.stringify(SETTINGS)),
    ).toMatchObject(missing);
  });

  it("changes nothing for a POST or a DELETE", async () => {
    const h = await harness();
    expect(await h.send("POST", "/api/devices/mike/settings", "{}")).toMatchObject({
      status: 405,
      allow: "GET, PUT",
    });
    expect(await h.send("DELETE", "/api/devices/mike/settings")).toMatchObject({ status: 405 });
    expect(h.changed).toEqual([]);
  });
});

describe("the API for adding and removing phones", () => {
  const NEW = { name: "Laurel's iPhone", udid: "00000000-0000000000000002", pairRecord: "c2VjcmV0" };

  it("adds a phone and answers with the id it was given", async () => {
    const h = await harness();
    const answer = await h.send("POST", "/api/devices", JSON.stringify(NEW));
    expect(answer.status).toBe(201);
    expect(DeviceAddedSchema.parse(answer.body)).toEqual({ id: "laurels-iphone" });
    expect(h.added).toEqual([NEW]);
  });

  it("says what is wrong with a phone it will not add", async () => {
    const h = await harness();
    const answer = await h.send("POST", "/api/devices", JSON.stringify({ ...NEW, name: "" }));
    expect(answer).toMatchObject({
      status: 400,
      body: { error: "invalid-phone", problems: ["name must not be empty"] },
    });
  });

  it("answers 409 for a phone that is here already", async () => {
    const h = await harness();
    const again = JSON.stringify({ ...NEW, name: "Mike's iPhone" });
    expect(await h.send("POST", "/api/devices", again)).toMatchObject({
      status: 409,
      body: { error: "already-added" },
    });
  });

  it("takes a pair record's worth of body, and refuses far more", async () => {
    const h = await harness();
    const roomy = JSON.stringify({ ...NEW, pairRecord: "A".repeat(60_000) });
    expect((await h.send("POST", "/api/devices", roomy)).status).toBe(201);
    const huge = JSON.stringify({ ...NEW, pairRecord: "A".repeat(200_000) });
    expect(await h.send("POST", "/api/devices", huge)).toMatchObject({
      status: 413,
      body: { error: "too-large" },
    });
  });

  it("refuses a body that is not JSON", async () => {
    const h = await harness();
    expect(await h.send("POST", "/api/devices", "a phone please")).toMatchObject({
      status: 400,
      body: { error: "invalid-json" },
    });
    expect(h.added).toEqual([]);
  });

  it("removes a phone", async () => {
    const h = await harness();
    expect(await h.send("DELETE", "/api/devices/mike")).toMatchObject({
      status: 200,
      body: { status: "removed" },
    });
    expect(h.removed).toEqual(["mike"]);
  });

  it("will not remove a phone it does not have, or one being backed up", async () => {
    const h = await harness();
    expect(await h.send("DELETE", "/api/devices/nobody")).toMatchObject({
      status: 404,
      body: { error: "unknown-device" },
    });
    expect(await h.send("DELETE", "/api/devices/busy")).toMatchObject({
      status: 409,
      body: { error: "already-running" },
    });
    expect(h.removed).toEqual([]);
  });

  it("never gives a pair record back: no reply about a phone carries one", async () => {
    const h = await harness();
    for (const path of ["/api/devices", "/api/devices/mike", "/api/devices/mike/settings"]) {
      expect(JSON.stringify((await h.send("GET", path)).body)).not.toMatch(/pair/i);
    }
  });
});

describe("the API for stopping a backup", () => {
  it("tells a running backup to stop, and answers straight away", async () => {
    const h = await harness();
    const answer = await h.send("POST", "/api/devices/mike/stop");
    expect(answer.status).toBe(202);
    expect(BackupStoppingSchema.parse(answer.body)).toEqual({ status: "stopping" });
    expect(h.stopped).toEqual(["mike"]);
  });

  it("answers 409 when nothing is running, and 404 for a phone it does not have", async () => {
    const h = await harness();
    expect(await h.send("POST", "/api/devices/idle/stop")).toMatchObject({
      status: 409,
      body: { error: "not-running" },
    });
    expect(await h.send("POST", "/api/devices/nobody/stop")).toMatchObject({
      status: 404,
      body: { error: "unknown-device" },
    });
  });

  it("stops nothing on a GET", async () => {
    const h = await harness();
    expect(await h.send("GET", "/api/devices/mike/stop")).toMatchObject({ status: 405, allow: "POST" });
    expect(h.stopped).toEqual([]);
  });
});

describe("the API for checking a phone", () => {
  it("says what the phone reported, in the shape the contract promises", async () => {
    const h = await harness();
    const answer = await h.send("POST", "/api/devices/mike/check");
    expect(answer.status).toBe(200);
    expect(DeviceCheckSchema.parse(answer.body)).toEqual(CHECK);
  });

  it("answers 404 for a phone it does not have, and 409 for one being backed up", async () => {
    const h = await harness();
    expect((await h.send("POST", "/api/devices/nobody/check")).status).toBe(404);
    expect(await h.send("POST", "/api/devices/busy/check")).toMatchObject({
      status: 409,
      body: { error: "already-running" },
    });
  });

  it("does not look for a phone on a GET", async () => {
    const h = await harness();
    expect(await h.send("GET", "/api/devices/mike/check")).toMatchObject({
      status: 405,
      allow: "POST",
    });
  });
});

describe("the API for the server itself", () => {
  it("says which build it is and where backups are kept", async () => {
    const h = await harness();
    const answer = await h.send("GET", "/api/server");
    expect(ServerInfoSchema.parse(answer.body)).toEqual({
      version: "0.3.0 (build test)",
      backupRoot: "/backups",
      phones: 1,
    });
  });

  it("gives its settings, and changes them", async () => {
    const h = await harness();
    const before = await h.send("GET", "/api/settings");
    expect(ServerSettingsSchema.parse(before.body).discoveryRanges).toEqual(["192.168.1.0/24"]);

    const wanted = { discoveryRanges: ["10.0.0.0/24"] };
    expect(await h.send("PUT", "/api/settings", JSON.stringify(wanted))).toMatchObject({
      status: 200,
      body: { discoveryRanges: ["10.0.0.0/24"] },
    });
  });

  it("says what is wrong with settings it will not take", async () => {
    const h = await harness();
    const answer = await h.send("PUT", "/api/settings", JSON.stringify({ discoveryRanges: "all" }));
    expect(answer).toMatchObject({
      status: 400,
      body: { error: "invalid-settings", problems: ["discoveryRanges must be a list"] },
    });
  });

  it("changes nothing for a POST", async () => {
    const h = await harness();
    expect(await h.send("POST", "/api/settings", "{}")).toMatchObject({
      status: 405,
      allow: "GET, PUT",
    });
    expect((await h.send("POST", "/api/server")).status).toBe(405);
  });
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
