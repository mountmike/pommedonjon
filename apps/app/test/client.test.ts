import { describe, expect, it } from "vitest";
import { ApiError, fetchDevices, type FetchFn } from "../src/api/client";

const MIKE = {
  id: "mike",
  name: "Mike's iPhone",
  state: "backed-up",
  lastBackupAt: "2026-11-24T10:24:20.700Z",
  dueAt: "2026-11-25T06:24:20.700Z",
  waiting: { reason: "not-due", until: "2026-11-25T06:24:20.700Z" },
  run: null,
  problem: null,
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
