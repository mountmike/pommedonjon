import { describe, expect, it } from "vitest";
import { PortScanner, type ConnectFn } from "./PortScanner.js";

function scanner(options: {
  open?: (host: string, attempt: number) => boolean;
  ranges?: string[];
  minIntervalMs?: number;
  concurrency?: number;
}) {
  const attempts = new Map<string, number>();
  const calls: { host: string; port: number; timeoutMs: number }[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  let now = 0;
  const connect: ConnectFn = async (host, port, timeoutMs) => {
    calls.push({ host, port, timeoutMs });
    const attempt = (attempts.get(host) ?? 0) + 1;
    attempts.set(host, attempt);
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return options.open?.(host, attempt) ?? false;
  };
  return {
    scanner: new PortScanner({
      ranges: options.ranges ?? ["192.168.1.0/24"],
      port: 62078,
      minIntervalMs: options.minIntervalMs ?? 300_000,
      clock: () => new Date(now),
      connect,
      ...(options.concurrency !== undefined && { concurrency: options.concurrency }),
    }),
    calls,
    attempts,
    advance: (ms: number) => {
      now += ms;
    },
    mostInFlight: () => mostInFlight,
  };
}

describe("PortScanner", () => {
  it("returns the addresses that accept a connection on the lockdown port, in order", async () => {
    const h = scanner({ open: (host) => ["192.168.1.235", "192.168.1.40"].includes(host) });

    expect(await h.scanner.candidates("mike")).toEqual(["192.168.1.40", "192.168.1.235"]);
    expect(h.calls.every((call) => call.port === 62078)).toBe(true);
  });

  it("knocks a second time on addresses that did not answer the first", async () => {
    // The phone has been seen to ignore one connection and accept the next.
    const h = scanner({ open: (host, attempt) => host === "192.168.1.235" && attempt === 2 });

    expect(await h.scanner.candidates("mike")).toEqual(["192.168.1.235"]);
    expect(h.attempts.get("192.168.1.235")).toBe(2);
  });

  it("does not knock again on an address that already answered", async () => {
    const h = scanner({ open: (host) => host === "192.168.1.235" });
    await h.scanner.candidates("mike");
    expect(h.attempts.get("192.168.1.235")).toBe(1);
    expect(h.attempts.get("192.168.1.1")).toBe(2);
  });

  it("sweeps once for several phones looked for at the same time", async () => {
    const h = scanner({ open: (host) => host === "192.168.1.235" });

    const [mike, lolo] = await Promise.all([
      h.scanner.candidates("mike"),
      h.scanner.candidates("lolo"),
    ]);

    expect(mike).toEqual(["192.168.1.235"]);
    expect(lolo).toEqual(["192.168.1.235"]);
    expect(h.calls).toHaveLength(254 + 253);
  });

  it("gives each caller a sweep's result once, and does not sweep again too soon", async () => {
    const h = scanner({ open: (host) => host === "192.168.1.235", minIntervalMs: 300_000 });
    await h.scanner.candidates("mike");
    const afterFirstSweep = h.calls.length;

    // Two minutes later the phone is still away: nothing new to try.
    h.advance(120_000);
    expect(await h.scanner.candidates("mike")).toEqual([]);
    expect(h.calls).toHaveLength(afterFirstSweep);

    // Another phone asking for the first time still gets that sweep.
    expect(await h.scanner.candidates("lolo")).toEqual(["192.168.1.235"]);
    expect(h.calls).toHaveLength(afterFirstSweep);
  });

  it("sweeps again once the interval has passed", async () => {
    const h = scanner({ open: (host) => host === "192.168.1.235", minIntervalMs: 300_000 });
    await h.scanner.candidates("mike");
    const afterFirstSweep = h.calls.length;

    h.advance(300_000);
    expect(await h.scanner.candidates("mike")).toEqual(["192.168.1.235"]);
    expect(h.calls.length).toBeGreaterThan(afterFirstSweep);
  });

  it("limits how many connections are open at once", async () => {
    const h = scanner({ concurrency: 16 });
    await h.scanner.candidates("mike");
    expect(h.mostInFlight()).toBe(16);
  });

  it("covers several ranges and tries an address in two of them only once per pass", async () => {
    const h = scanner({ ranges: ["192.168.1.0/30", "192.168.1.0/30", "10.0.20.8/30"] });
    await h.scanner.candidates("mike");
    expect([...h.attempts.keys()].sort()).toEqual([
      "10.0.20.10",
      "10.0.20.9",
      "192.168.1.1",
      "192.168.1.2",
    ]);
  });

  it("is switched off, and connects to nothing, when no ranges are configured", async () => {
    const h = scanner({ ranges: [] });
    expect(h.scanner.enabled).toBe(false);
    expect(await h.scanner.candidates("mike")).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});
