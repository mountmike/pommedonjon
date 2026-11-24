import { describe, expect, it } from "vitest";
import {
  ApiError,
  fetchDevice,
  fetchDevices,
  requestBackup,
  type FetchFn,
} from "../src/api/client";

const MIKE = {
  id: "mike",
  name: "Mike's iPhone",
  state: "backed-up",
  lastBackupAt: "2026-11-24T10:24:20.700Z",
  dueAt: "2026-11-25T06:24:20.700Z",
  waiting: { reason: "not-due", until: "2026-11-25T06:24:20.700Z" },
  run: null,
  problem: null,
  lastAttempt: null,
};

const answering =
  (body: unknown, status = 200): FetchFn =>
  () =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

describe("fetchDevices", () => {
  it("asks the server for its phones at the address it was given", async () => {
    const asked: string[] = [];
    const devices = await fetchDevices("http://server:8377", (url) => {
      asked.push(url);
      return answering({ devices: [MIKE] })(url);
    });
    expect(asked).toEqual(["http://server:8377/api/devices"]);
    expect(devices).toEqual([MIKE]);
  });

  it("uses the same address as the page when given none", async () => {
    const asked: string[] = [];
    await fetchDevices("", (url) => {
      asked.push(url);
      return answering({ devices: [] })(url);
    });
    expect(asked).toEqual(["/api/devices"]);
  });

  it.each([
    ["a reply that is not what the contract promises", answering({ phones: [] })],
    ["a phone in a state that does not exist", answering({ devices: [{ ...MIKE, state: "fine" }] })],
    [
      "a reply that is not JSON",
      (() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError("Unexpected token <")),
        })) as FetchFn,
    ],
  ])("refuses %s, and shows nothing from it", async (_what, fetchFn) => {
    await expect(fetchDevices("", fetchFn)).rejects.toThrow("The server's answer made no sense.");
  });

  it("says so when the server answers with an error", async () => {
    await expect(fetchDevices("", answering({ error: "internal-error" }, 500))).rejects.toThrow(
      "The server answered 500.",
    );
  });

  it("says so when the server cannot be reached", async () => {
    const down: FetchFn = () => Promise.reject(new TypeError("Failed to fetch"));
    await expect(fetchDevices("", down)).rejects.toBeInstanceOf(ApiError);
    await expect(fetchDevices("", down)).rejects.toThrow("Can't reach the server.");
  });
});

describe("fetchDevice", () => {
  const DETAIL = { ...MIKE, recentRuns: [] };

  it("asks for one phone by its id", async () => {
    const asked: string[] = [];
    const device = await fetchDevice("mike", "http://server:8377", (url) => {
      asked.push(url);
      return answering(DETAIL)(url);
    });
    expect(asked).toEqual(["http://server:8377/api/devices/mike"]);
    expect(device).toEqual(DETAIL);
  });

  it("says so, with the status, when the server has no such phone", async () => {
    const missing = fetchDevice("nobody", "", answering({ error: "unknown-device" }, 404));
    await expect(missing).rejects.toMatchObject({
      message: "There is no such phone on the server.",
      status: 404,
    });
  });

  it("refuses a reply without the phone's runs", async () => {
    await expect(fetchDevice("mike", "", answering(MIKE))).rejects.toThrow(
      "The server's answer made no sense.",
    );
  });
});

describe("requestBackup", () => {
  it("posts to the phone's back-up-now address and says it started", async () => {
    const asked: { url: string; method: string | undefined }[] = [];
    const answer = await requestBackup("mike", "http://server:8377", (url, init) => {
      asked.push({ url, method: init?.method });
      return answering({ status: "started" }, 202)(url);
    });
    expect(asked).toEqual([
      { url: "http://server:8377/api/devices/mike/backup-now", method: "POST" },
    ]);
    expect(answer).toBe("started");
  });

  it("takes a backup already under way as an answer, not a failure", async () => {
    const busy = answering({ error: "already-running" }, 409);
    expect(await requestBackup("mike", "", busy)).toBe("already-running");
  });

  it.each([
    ["a phone the server does not have", answering({ error: "unknown-device" }, 404), "There is no such phone on the server."],
    ["a server error", answering({ error: "internal-error" }, 500), "The server answered 500."],
    ["an error page that is not JSON", (() => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError("<")) })) as FetchFn, "The server answered 502."],
    ["a success that says something else", answering({ status: "not-now" }, 200), "The server's answer made no sense."],
  ])("says so for %s", async (_what, fetchFn, message) => {
    await expect(requestBackup("mike", "", fetchFn)).rejects.toThrow(message);
  });

  it("says so when the server cannot be reached", async () => {
    const down: FetchFn = () => Promise.reject(new TypeError("Failed to fetch"));
    await expect(requestBackup("mike", "", down)).rejects.toThrow("Can't reach the server.");
  });
});
