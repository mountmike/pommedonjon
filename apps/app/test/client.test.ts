import { describe, expect, it } from "vitest";
import {
  ApiError,
  fetchDevice,
  fetchDevices,
  fetchSettings,
  reportAppOpened,
  requestBackup,
  saveSettings,
  stopBackup,
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

const SETTINGS = {
  name: "Mike's iPhone",
  automatic: true,
  dueAfterHours: 20,
  startWhenPluggedIn: true,
  pluggedInWindowMinutes: 30,
  startWhenAppOpened: true,
  startWhenUnlockedAfterHours: 4,
  startOnChargerAfterHours: 24,
  quietHours: { start: "22:00", end: "07:00" },
  staleAfterHours: 72,
};

describe("fetchSettings", () => {
  it("asks for one phone's settings", async () => {
    const asked: string[] = [];
    const settings = await fetchSettings("mike", "http://server:8377", (url) => {
      asked.push(url);
      return answering(SETTINGS)(url);
    });
    expect(asked).toEqual(["http://server:8377/api/devices/mike/settings"]);
    expect(settings).toEqual(SETTINGS);
  });

  it("refuses settings that are not what the contract promises", async () => {
    const odd = answering({ ...SETTINGS, automatic: "sometimes" });
    await expect(fetchSettings("mike", "", odd)).rejects.toThrow("The server's answer made no sense.");
  });
});

describe("saveSettings", () => {
  it("sends all of them as JSON, and gives back what the server saved", async () => {
    const sent: unknown[] = [];
    const saved = await saveSettings("mike", SETTINGS, "", (url, init) => {
      sent.push({ url, ...init });
      return answering({ ...SETTINGS, name: "Mike's phone" })(url);
    });
    expect(sent).toEqual([
      {
        url: "/api/devices/mike/settings",
        method: "PUT",
        body: JSON.stringify(SETTINGS),
        headers: { "content-type": "application/json" },
      },
    ]);
    expect(saved.name).toBe("Mike's phone");
  });

  it("carries what the server found wrong with them", async () => {
    const refused = answering(
      { error: "invalid-settings", problems: ["name must not be empty"] },
      400,
    );
    await expect(saveSettings("mike", SETTINGS, "", refused)).rejects.toMatchObject({
      message: "The server would not take those settings.",
      status: 400,
      problems: ["name must not be empty"],
    });
  });

  it("says so for a phone the server does not have", async () => {
    const missing = answering({ error: "unknown-device" }, 404);
    await expect(saveSettings("nobody", SETTINGS, "", missing)).rejects.toThrow(
      "There is no such phone on the server.",
    );
  });
});

describe("stopBackup", () => {
  it("posts to the phone's stop address and says it is stopping", async () => {
    const asked: unknown[] = [];
    const answer = await stopBackup("mike", "", (url, init) => {
      asked.push({ url, method: init?.method });
      return answering({ status: "stopping" }, 202)(url);
    });
    expect(asked).toEqual([{ url: "/api/devices/mike/stop", method: "POST" }]);
    expect(answer).toBe("stopping");
  });

  it("takes a backup that had already ended as an answer, not a failure", async () => {
    const ended = answering({ error: "not-running" }, 409);
    expect(await stopBackup("mike", "", ended)).toBe("not-running");
  });

  it("says so for a phone the server does not have", async () => {
    await expect(stopBackup("nobody", "", answering({ error: "unknown-device" }, 404))).rejects.toThrow(
      "There is no such phone on the server.",
    );
  });
});

describe("reportAppOpened", () => {
  it("tells the server, and learns which phone this is and what came of it", async () => {
    const asked: unknown[] = [];
    const answer = await reportAppOpened("", (url, init) => {
      asked.push({ url, method: init?.method });
      return answering({ deviceId: "mike", backup: "started" })(url);
    });
    expect(asked).toEqual([{ url: "/api/me/opened", method: "POST" }]);
    expect(answer).toEqual({ deviceId: "mike", backup: "started" });
  });

  it("learns that this is none of the server's phones", async () => {
    const nobody = answering({ deviceId: null, backup: null });
    expect((await reportAppOpened("", nobody)).deviceId).toBeNull();
  });
});
