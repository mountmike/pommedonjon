import { describe, expect, it } from "vitest";
import { createPhoneFinder } from "../../src/discovery/PhoneFinder.js";
import { FakeTransport, fakeStatus } from "../support/fakeTransport.js";

function setUp(open: string[] = []) {
  const transport = new FakeTransport();
  const callers: string[] = [];
  const finder = createPhoneFinder({
    transport,
    scanner: {
      enabled: open.length > 0,
      candidates: (caller) => {
        callers.push(caller);
        return Promise.resolve(open);
      },
    },
  });
  return { transport, finder, callers };
}

const MIKE = fakeStatus({ udid: "00000000-0000000000000001", name: "Mike's iPhone" });

describe("PhoneFinder", () => {
  it("asks the address it is given, and nowhere else", async () => {
    const h = setUp(["10.0.0.5", "10.0.0.6"]);
    h.transport.identities.set("10.0.0.7", MIKE);
    expect(await h.finder.find("/pairings/.incoming-1", "10.0.0.7")).toEqual({
      udid: MIKE.udid,
      name: "Mike's iPhone",
      host: "10.0.0.7",
    });
    expect(h.transport.identified).toEqual([
      { host: "10.0.0.7", pairRecordPath: "/pairings/.incoming-1" },
    ]);
    expect(h.callers).toEqual([]);
  });

  it("looks through the network for the one device that accepts the pair record", async () => {
    const h = setUp(["10.0.0.5", "10.0.0.6", "10.0.0.42"]);
    h.transport.identities.set("10.0.0.42", MIKE);
    expect(await h.finder.find("/pairings/.incoming-1")).toMatchObject({
      udid: MIKE.udid,
      host: "10.0.0.42",
    });
    expect(h.transport.identified.map((endpoint) => endpoint.host)).toEqual([
      "10.0.0.5",
      "10.0.0.6",
      "10.0.0.42",
    ]);
  });

  it("asks for a sweep under a name of its own each time, so it is never told nothing is new", async () => {
    const h = setUp(["10.0.0.5"]);
    await h.finder.find("/pairings/.incoming-1");
    await h.finder.find("/pairings/.incoming-2");
    expect(new Set(h.callers).size).toBe(2);
  });

  it("finds nothing when no phone there accepts it, or there is nowhere to look", async () => {
    expect(await setUp(["10.0.0.5"]).finder.find("/pairings/.incoming-1")).toBeUndefined();
    expect(await setUp().finder.find("/pairings/.incoming-1")).toBeUndefined();
    expect(await setUp().finder.find("/pairings/.incoming-1", "10.0.0.7")).toBeUndefined();
  });
});
