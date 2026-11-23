import { describe, expect, it } from "vitest";
import { addressesIn, rangeProblem } from "./ranges.js";

describe("addressesIn", () => {
  it("lists every usable address in a /24, leaving out network and broadcast", () => {
    const addresses = addressesIn("192.168.1.0/24");
    expect(addresses).toHaveLength(254);
    expect(addresses[0]).toBe("192.168.1.1");
    expect(addresses.at(-1)).toBe("192.168.1.254");
  });

  it("works from any address inside the range, not only its first", () => {
    expect(addressesIn("192.168.1.235/24")).toEqual(addressesIn("192.168.1.0/24"));
  });

  it("handles ranges that cross an octet boundary", () => {
    const addresses = addressesIn("10.0.20.0/22");
    expect(addresses).toHaveLength(1022);
    expect(addresses[0]).toBe("10.0.20.1");
    expect(addresses[255]).toBe("10.0.21.0");
    expect(addresses.at(-1)).toBe("10.0.23.254");
  });

  it("handles addresses above 128.0.0.0 without going negative", () => {
    expect(addressesIn("203.0.113.8/30")).toEqual(["203.0.113.9", "203.0.113.10"]);
  });

  it("treats a /32 as one address and a /31 as two", () => {
    expect(addressesIn("192.168.1.235/32")).toEqual(["192.168.1.235"]);
    expect(addressesIn("192.168.1.234/31")).toEqual(["192.168.1.234", "192.168.1.235"]);
  });

  it("refuses to expand a range that is not acceptable", () => {
    expect(() => addressesIn("10.0.0.0/8")).toThrow(RangeError);
  });
});

describe("rangeProblem", () => {
  it("accepts ranges up to about a thousand addresses", () => {
    expect(rangeProblem("192.168.1.0/24")).toBeUndefined();
    expect(rangeProblem("10.0.20.0/22")).toBeUndefined();
    expect(rangeProblem("192.168.1.235/32")).toBeUndefined();
  });

  it("refuses anything larger, so a typo cannot become millions of connections", () => {
    expect(rangeProblem("10.0.0.0/21")).toBe("must be /22 or smaller (at most 1024 addresses)");
    expect(rangeProblem("10.0.0.0/8")).toBe("must be /22 or smaller (at most 1024 addresses)");
    expect(rangeProblem("0.0.0.0/0")).toBe("must be /22 or smaller (at most 1024 addresses)");
  });

  it.each(["", "192.168.1.0", "192.168.1/24", "192.168.1.256/24", "a.b.c.d/24", "::1/128"])(
    "refuses %j as not an IPv4 range",
    (cidr) => {
      expect(rangeProblem(cidr)).toBe('must be an IPv4 range like "192.168.1.0/24"');
    },
  );

  it("refuses an impossible prefix length", () => {
    expect(rangeProblem("192.168.1.0/33")).toBe("must have a prefix length of 32 or less");
  });
});
