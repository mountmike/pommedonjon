import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type DeviceConfig } from "../../src/config/config.js";
import { FAKE_UDID, fakeStatus } from "../support/fakeTransport.js";
import { DeviceError, type DeviceStatus, type DeviceTarget } from "../../src/transport/DeviceTransport.js";
import { DeviceLocator } from "../../src/discovery/DeviceLocator.js";

const device: DeviceConfig = {
  id: "mike",
  name: "Mike's iPhone",
  udid: FAKE_UDID,
  host: undefined,
  port: undefined,
  pairRecordPath: "/secrets/mike.plist",
  policy: DEFAULT_POLICY,
};

const refused = () => new DeviceError("pair record refused", "not-paired");
const silent = () => new DeviceError("no answer", "unreachable");

function harness(options: {
  /** What answers at each address; anything not listed does not answer. */
  at?: Record<string, DeviceStatus | DeviceError>;
  lastKnown?: string;
  scan?: string[];
  scanning?: boolean;
}) {
  const probed: string[] = [];
  const book = new Map<string, string>();
  if (options.lastKnown !== undefined) book.set("mike", options.lastKnown);
  const logs: { message: string; fields: unknown }[] = [];
  let scans = 0;

  const locator = new DeviceLocator({
    transport: {
      probe: (target: DeviceTarget) => {
        const { host } = target.endpoint;
        probed.push(host);
        const answer = options.at?.[host] ?? silent();
        return answer instanceof DeviceError ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
    addresses: {
      lastAddress: (id) => book.get(id),
      rememberAddress: (id, host) => void book.set(id, host),
    },
    scanner: {
      enabled: options.scanning ?? true,
      candidates: () => {
        scans += 1;
        return Promise.resolve(options.scan ?? []);
      },
    },
    log: (_level, message, fields) => logs.push({ message, fields }),
    clock: () => new Date("2026-11-24T19:00:00Z"),
  });
  return { locator, probed, book, logs, scans: () => scans };
}

describe("DeviceLocator", () => {
  it("goes straight to the last address the phone was reached at, without sweeping", async () => {
    const h = harness({ lastKnown: "192.168.1.50", at: { "192.168.1.50": fakeStatus() } });

    const located = await h.locator.locate(device);

    expect(located).toEqual({ host: "192.168.1.50", status: fakeStatus() });
    expect(h.probed).toEqual(["192.168.1.50"]);
    expect(h.scans()).toBe(0);
  });

  it("sweeps when the phone has moved, and remembers where it found it", async () => {
    const h = harness({
      lastKnown: "192.168.1.50",
      scan: ["192.168.1.40", "192.168.1.77"],
      at: { "192.168.1.40": refused(), "192.168.1.77": fakeStatus() },
    });

    const located = await h.locator.locate(device);

    expect(located.host).toBe("192.168.1.77");
    expect(h.book.get("mike")).toBe("192.168.1.77");
    expect(h.logs).toEqual([
      {
        message: "found the phone at a new address",
        fields: { device: "mike", host: "192.168.1.77", previous: "192.168.1.50" },
      },
    ]);
  });

  it("finds a phone it has never seen before", async () => {
    const h = harness({ scan: ["192.168.1.77"], at: { "192.168.1.77": fakeStatus() } });

    expect((await h.locator.locate(device)).host).toBe("192.168.1.77");
    expect(h.book.get("mike")).toBe("192.168.1.77");
  });

  it("identifies the phone by its pair record, passing over other Apple devices", async () => {
    const h = harness({
      scan: ["192.168.1.10", "192.168.1.11", "192.168.1.12"],
      at: {
        "192.168.1.10": refused(),
        "192.168.1.11": new DeviceError("the device at this endpoint is someone else", "failed"),
        "192.168.1.12": fakeStatus(),
      },
    });

    expect((await h.locator.locate(device)).host).toBe("192.168.1.12");
    expect(h.probed.sort()).toEqual(["192.168.1.10", "192.168.1.11", "192.168.1.12"]);
  });

  it("probes each candidate with this phone's own identity and pair record", async () => {
    const targets: DeviceTarget[] = [];
    const locator = new DeviceLocator({
      transport: {
        probe: (target) => {
          targets.push(target);
          return Promise.resolve(fakeStatus());
        },
      },
      addresses: { lastAddress: () => undefined, rememberAddress: () => undefined },
      scanner: { enabled: true, candidates: () => Promise.resolve(["192.168.1.77"]) },
      log: () => undefined,
      clock: () => new Date(),
    });

    await locator.locate({ ...device, port: 62079 });

    expect(targets).toEqual([
      {
        udid: FAKE_UDID,
        endpoint: {
          host: "192.168.1.77",
          port: 62079,
          pairRecordPath: "/secrets/mike.plist",
        },
      },
    ]);
  });

  it("does not probe the last-known address a second time when the sweep lists it too", async () => {
    const h = harness({ lastKnown: "192.168.1.50", scan: ["192.168.1.50", "192.168.1.40"] });

    await expect(h.locator.locate(device)).rejects.toBeInstanceOf(DeviceError);
    expect(h.probed).toEqual(["192.168.1.50", "192.168.1.40"]);
  });

  it("reports a phone that is nowhere to be found as unreachable, which means away", async () => {
    const h = harness({
      lastKnown: "192.168.1.50",
      scan: ["192.168.1.40"],
      at: { "192.168.1.40": refused() },
    });

    await expect(h.locator.locate(device)).rejects.toMatchObject({
      reason: "unreachable",
      message: "mike did not answer at 192.168.1.50 and was not found in the discovery ranges",
    });
    // And it keeps its last-known address for next time.
    expect(h.book.get("mike")).toBe("192.168.1.50");
  });

  it("uses a pinned host and looks nowhere else, even if it does not answer", async () => {
    const h = harness({
      lastKnown: "192.168.1.50",
      scan: ["192.168.1.77"],
      at: { "192.168.1.50": fakeStatus(), "192.168.1.77": fakeStatus() },
    });

    await expect(h.locator.locate({ ...device, host: "phone.lan" })).rejects.toMatchObject({
      reason: "unreachable",
    });
    expect(h.probed).toEqual(["phone.lan"]);
    expect(h.scans()).toBe(0);
  });

  it("passes on a pinned host's own refusal, so a rejected pair record is visible", async () => {
    const h = harness({ at: { "phone.lan": refused() } });
    await expect(h.locator.locate({ ...device, host: "phone.lan" })).rejects.toMatchObject({
      reason: "not-paired",
    });
  });

  it("with discovery off, reports what the last-known address said", async () => {
    const h = harness({ scanning: false, lastKnown: "192.168.1.50" });
    await expect(h.locator.locate(device)).rejects.toMatchObject({ reason: "unreachable" });
    expect(h.scans()).toBe(0);
  });

  it("lets an unexpected error through instead of calling the phone away", async () => {
    const locator = new DeviceLocator({
      transport: { probe: () => Promise.reject(new TypeError("bug")) },
      addresses: { lastAddress: () => "192.168.1.50", rememberAddress: () => undefined },
      scanner: { enabled: true, candidates: () => Promise.resolve([]) },
      log: () => undefined,
      clock: () => new Date(),
    });
    await expect(locator.locate(device)).rejects.toBeInstanceOf(TypeError);
  });
});
