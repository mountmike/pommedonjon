import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type DeviceConfig } from "../../src/config/config.js";
import { PhoneIdentifier, plainAddress } from "../../src/discovery/PhoneIdentifier.js";
import { fixedDevices } from "../../src/settings/DeviceDirectory.js";
import { FakeTransport, fakeStatus } from "../support/fakeTransport.js";

const MIKE: DeviceConfig = {
  id: "mike",
  name: "Mike's iPhone",
  udid: "00000000-0000000000000001",
  host: undefined,
  port: undefined,
  pairRecordPath: "/pairings/mike.plist",
  policy: DEFAULT_POLICY,
};
const LAUREL: DeviceConfig = {
  ...MIKE,
  id: "laurel",
  udid: "00000000-0000000000000002",
  pairRecordPath: "/pairings/laurel.plist",
};

function setUp(
  options: { listening?: string[]; devices?: DeviceConfig[]; busy?: string[] } = {},
) {
  const transport = new FakeTransport();
  const knocks: string[] = [];
  let now = new Date("2026-11-25T08:00:00.000Z");
  let devices = options.devices ?? [MIKE, LAUREL];
  const identifier = new PhoneIdentifier({
    devices: {
      all: () => devices,
      get: (id) => devices.find((device) => device.id === id),
    },
    transport,
    clock: () => now,
    port: 62078,
    isBusy: (deviceId) => (options.busy ?? []).includes(deviceId),
    knock: (host) => {
      knocks.push(host);
      return Promise.resolve((options.listening ?? ["192.168.1.50"]).includes(host));
    },
  });
  return {
    identifier,
    transport,
    knocks,
    later: (minutes: number) => (now = new Date(now.getTime() + minutes * 60_000)),
    remove: (id: string) => (devices = devices.filter((device) => device.id !== id)),
  };
}

describe("PhoneIdentifier", () => {
  it("names the phone at an address: the one that accepts its own pairing there", async () => {
    const h = setUp();
    h.transport.identities.set("192.168.1.50", fakeStatus({ udid: LAUREL.udid }));
    expect(await h.identifier.whoIsAt("192.168.1.50")).toBe("laurel");
    // Each phone's pairing was tried against the address.
    expect(h.transport.identified.map((endpoint) => endpoint.pairRecordPath).sort()).toEqual([
      "/pairings/laurel.plist",
      "/pairings/mike.plist",
    ]);
  });

  it("is nobody when something else answers there", async () => {
    const h = setUp();
    h.transport.identities.set("192.168.1.50", fakeStatus({ udid: "00000000-0000000000000099" }));
    expect(await h.identifier.whoIsAt("192.168.1.50")).toBeUndefined();
  });

  it("does not try a pairing on an address with nothing listening, as a computer has", async () => {
    const h = setUp();
    expect(await h.identifier.whoIsAt("192.168.1.93")).toBeUndefined();
    expect(h.knocks).toEqual(["192.168.1.93"]);
    expect(h.transport.identified).toEqual([]);
  });

  it("knows nobody when there are no phones, without knocking on anything", async () => {
    const h = setUp({ devices: [] });
    expect(await h.identifier.whoIsAt("192.168.1.50")).toBeUndefined();
    expect(h.knocks).toEqual([]);
  });

  it("remembers a phone at its address for five minutes, then looks again", async () => {
    const h = setUp();
    h.transport.identities.set("192.168.1.50", fakeStatus({ udid: MIKE.udid }));
    await h.identifier.whoIsAt("192.168.1.50");
    h.later(4);
    expect(await h.identifier.whoIsAt("192.168.1.50")).toBe("mike");
    expect(h.knocks).toHaveLength(1);

    // The address has passed to someone else since.
    h.transport.identities.delete("192.168.1.50");
    h.later(2);
    expect(await h.identifier.whoIsAt("192.168.1.50")).toBeUndefined();
    expect(h.knocks).toHaveLength(2);
  });

  it("remembers that an address is nobody for a minute only", async () => {
    const h = setUp();
    await h.identifier.whoIsAt("192.168.1.93");
    await h.identifier.whoIsAt("192.168.1.93");
    expect(h.knocks).toHaveLength(1);
    h.later(2);
    await h.identifier.whoIsAt("192.168.1.93");
    expect(h.knocks).toHaveLength(2);
  });

  it("looks once when several requests arrive from one address together", async () => {
    const h = setUp();
    h.transport.identities.set("192.168.1.50", fakeStatus({ udid: MIKE.udid }));
    const answers = await Promise.all([
      h.identifier.whoIsAt("192.168.1.50"),
      h.identifier.whoIsAt("192.168.1.50"),
      h.identifier.whoIsAt("192.168.1.50"),
    ]);
    expect(answers).toEqual(["mike", "mike", "mike"]);
    expect(h.knocks).toHaveLength(1);
  });

  it("leaves a phone alone while it is being backed up", async () => {
    const h = setUp({ busy: ["mike"] });
    h.transport.identities.set("192.168.1.50", fakeStatus({ udid: MIKE.udid }));
    expect(await h.identifier.whoIsAt("192.168.1.50")).toBeUndefined();
    expect(h.transport.identified.map((endpoint) => endpoint.pairRecordPath)).toEqual([
      "/pairings/laurel.plist",
    ]);
  });

  it("does not remember more addresses than it has a use for", async () => {
    const h = setUp({ listening: [] });
    for (let n = 0; n < 600; n += 1) await h.identifier.whoIsAt(`10.0.${Math.floor(n / 250)}.${n % 250}`);
    // Still answers, and still looks afresh for an address it has let go of.
    const before = h.knocks.length;
    await h.identifier.whoIsAt("10.0.0.0");
    expect(h.knocks.length).toBe(before + 1);
  });

  it("stops recognising a phone that has been removed", async () => {
    const h = setUp();
    h.transport.identities.set("192.168.1.50", fakeStatus({ udid: MIKE.udid }));
    await h.identifier.whoIsAt("192.168.1.50");
    h.remove("mike");
    expect(await h.identifier.whoIsAt("192.168.1.50")).toBeUndefined();
  });
});

describe("plainAddress", () => {
  it("unwraps an IPv4 address from a dual-stack socket", () => {
    expect(plainAddress("::ffff:192.168.1.50")).toBe("192.168.1.50");
    expect(plainAddress("192.168.1.50")).toBe("192.168.1.50");
    expect(plainAddress("fe80::1")).toBe("fe80::1");
  });

  it("is nothing when the socket has no address", () => {
    expect(plainAddress(undefined)).toBeUndefined();
    expect(plainAddress("")).toBeUndefined();
  });
});
