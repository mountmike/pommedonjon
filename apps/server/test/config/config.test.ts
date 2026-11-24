import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_POLICY, loadConfig, parseConfig } from "../../src/config/config.js";

const UDID = "00008140-000A1B2C3D4E001C";

function minimal(overrides: object = {}) {
  return {
    backupRoot: "backups",
    stateDir: "/var/lib/pommedonjon",
    devices: [
      {
        id: "mike",
        udid: UDID,
        host: "10.0.0.7",
        pairRecordPath: "secrets/mike.plist",
      },
    ],
    ...overrides,
  };
}

describe("the example config in the repo", () => {
  it("is valid, so copying it is a working starting point", async () => {
    const config = await loadConfig(new URL("../../pommedonjon.example.json", import.meta.url).pathname);
    expect(config.devices.map((device) => device.id)).toEqual(["phone-one", "phone-two"]);
    // One phone found by discovery, one pinned; both read their pair record
    // from where the Compose file mounts the secrets volume.
    expect(config.devices.map((device) => device.host)).toEqual([undefined, "192.0.2.11"]);
    expect(config.devices.map((device) => device.pairRecordPath)).toEqual([
      "/run/secrets/phone-one.plist",
      "/run/secrets/phone-two.plist",
    ]);
    expect(config.devices[0]?.policy).toEqual(DEFAULT_POLICY);
    expect(config.devices[1]?.policy).toMatchObject({
      trigger: "on-charger",
      window: { startMinutes: 420, endMinutes: 1320 },
    });
  });
});

describe("parseConfig", () => {
  it("fills in defaults and resolves relative paths against the config's directory", () => {
    const config = parseConfig(minimal(), "/etc/pommedonjon");
    expect(config).toEqual({
      backupRoot: "/etc/pommedonjon/backups",
      stateDir: "/var/lib/pommedonjon",
      pollIntervalSeconds: 120,
      sidecar: { pythonPath: undefined, scriptPath: undefined },
      discovery: { ranges: [], scanIntervalSeconds: 300 },
      devices: [
        {
          id: "mike",
          name: "mike",
          udid: UDID,
          host: "10.0.0.7",
          port: undefined,
          pairRecordPath: "/etc/pommedonjon/secrets/mike.plist",
          policy: DEFAULT_POLICY,
        },
      ],
    });
  });

  it("by default backs up shortly after plug-in, once a backup is 20 hours old, at any hour", () => {
    expect(DEFAULT_POLICY).toMatchObject({
      dueAfterHours: 20,
      trigger: "plugged-in",
      pluggedInWindowMinutes: 30,
      window: null,
    });
  });

  it("layers a device's policy over defaultPolicy over the built-in defaults", () => {
    const config = parseConfig(
      minimal({
        defaultPolicy: { dueAfterHours: 12, window: { start: "18:00", end: "23:30" } },
        devices: [
          {
            id: "mike",
            udid: UDID,
            host: "h",
            pairRecordPath: "/p",
            policy: { trigger: "on-charger", retryAfterTimeoutMinutes: 3 },
          },
        ],
      }),
      "/",
    );
    expect(config.devices[0]?.policy).toEqual({
      ...DEFAULT_POLICY,
      dueAfterHours: 12,
      window: { startMinutes: 18 * 60, endMinutes: 23 * 60 + 30 },
      trigger: "on-charger",
      retryAfterTimeoutMinutes: 3,
    });
  });

  it("accepts a window that wraps midnight", () => {
    const config = parseConfig(
      minimal({ defaultPolicy: { window: { start: "21:00", end: "01:00" } } }),
      "/",
    );
    expect(config.devices[0]?.policy.window).toEqual({
      startMinutes: 1260,
      endMinutes: 60,
    });
  });

  it("treats window: null as any time of day", () => {
    const config = parseConfig(minimal({ defaultPolicy: { window: null } }), "/");
    expect(config.devices[0]?.policy.window).toBeNull();
  });

  it("lets a device switch off a window that the shared default set", () => {
    const config = parseConfig(
      minimal({
        defaultPolicy: { window: { start: "18:00", end: "22:00" } },
        devices: [
          { id: "mike", udid: UDID, host: "h", pairRecordPath: "/p", policy: { window: null } },
          { id: "lolo", udid: "00008150-000F0E0D0C0B002E", host: "h2", pairRecordPath: "/q" },
        ],
      }),
      "/",
    );
    expect(config.devices[0]?.policy.window).toBeNull();
    expect(config.devices[1]?.policy.window).toEqual({ startMinutes: 1080, endMinutes: 1320 });
  });

  it("reports every problem at once, one per line", () => {
    const bad = minimal({
      backupRoot: "",
      pollIntervalSeconds: 1,
      defaultPolicy: { pluggedInWindowMinutes: 0 },
      devices: [{ id: "mike", udid: UDID, host: "h", pairRecordPath: "/p", polcy: {} }],
    });
    let message = "";
    try {
      parseConfig(bad, "/");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split("\n").sort()).toEqual([
      "backupRoot must be a non-empty string",
      "defaultPolicy.pluggedInWindowMinutes must be at least 1",
      "devices[0].polcy is not a recognised setting",
      "pollIntervalSeconds must be at least 10",
    ]);
  });

  it("names a missing required setting", () => {
    const { stateDir: _stateDir, ...withoutStateDir } = minimal();
    expect(() => parseConfig(withoutStateDir, "/")).toThrow("stateDir must be a non-empty string");
  });

  it("rejects values of the wrong type by name", () => {
    expect(() => parseConfig(minimal({ pollIntervalSeconds: "60" }), "/")).toThrow(
      "pollIntervalSeconds must be a number",
    );
    expect(() => parseConfig(minimal({ devices: {} }), "/")).toThrow("devices must be an array");
    expect(() => parseConfig(minimal({ devices: ["mike"] }), "/")).toThrow(
      "devices[0] must be an object",
    );
    expect(() => parseConfig("nope", "/")).toThrow("the config must be a JSON object");
  });

  it.each([
    [{ devices: [] }, /at least one device/],
    [{ backupRoot: "" }, /backupRoot must be a non-empty string/],
    [{ pollIntervalSeconds: 1 }, /pollIntervalSeconds must be at least 10/],
    [{ snapshots: { strategy: "copy" } }, /snapshots is not a recognised setting/],
    [{ pollIntervalSecond: 60 }, /pollIntervalSecond is not a recognised setting/],
    [{ defaultPolicy: { window: { start: "25:00", end: "01:00" } } }, /window.start/],
    [{ defaultPolicy: { window: { start: "09:00", end: "09:00" } } }, /must differ/],
    [{ headsUpLeadSeconds: 5 }, /headsUpLeadSeconds is not a recognised setting/],
    [{ defaultPolicy: { trigger: "on-unlock" } }, /trigger must be "plugged-in" or "on-charger"/],
    [{ defaultPolicy: { dueAfterHours: 0 } }, /dueAfterHours must be at least 1/],
    [{ defaultPolicy: { minIntervalHours: 20 } }, /minIntervalHours is not a recognised setting/],
  ])("rejects %j", (overrides, message) => {
    expect(() => parseConfig(minimal(overrides), "/")).toThrow(message);
  });

  it("names the device and field when a device entry is wrong", () => {
    const bad = minimal({
      devices: [{ id: "Mike's Phone", udid: UDID, host: "h", pairRecordPath: "/p" }],
    });
    expect(() => parseConfig(bad, "/")).toThrow(/lower-case letters, digits and hyphens/);

    const badUdid = minimal({
      devices: [{ id: "mike", udid: "not-a-udid", host: "h", pairRecordPath: "/p" }],
    });
    expect(() => parseConfig(badUdid, "/")).toThrow(/udid does not look like/);

    const typo = minimal({
      devices: [{ id: "mike", udid: UDID, host: "h", pairRecordPath: "/p", polcy: {} }],
    });
    expect(() => parseConfig(typo, "/")).toThrow(/devices\[0\]\.polcy is not a recognised/);
  });

  it("refuses two devices that would share a directory or a phone", () => {
    const device = { id: "mike", udid: UDID, host: "h", pairRecordPath: "/p" };
    expect(() =>
      parseConfig(
        minimal({ devices: [device, { ...device, udid: "00008150-000F0E0D0C0B002E" }] }),
        "/",
      ),
    ).toThrow(/share the id "mike"/);
    expect(() =>
      parseConfig(minimal({ devices: [device, { ...device, id: "other" }] }), "/"),
    ).toThrow(/share the udid/);
  });

  it("does not listen on the network unless a port is given", () => {
    expect(parseConfig(minimal(), "/").api).toBeUndefined();
    expect(parseConfig(minimal({ api: { port: 8377 } }), "/").api).toEqual({ port: 8377 });
  });

  it.each([
    [{}, /api\.port must be a number/],
    [{ port: 0 }, /api\.port must be between 1 and 65535/],
    [{ port: 70000 }, /api\.port must be between 1 and 65535/],
    [{ port: 8377, token: "x" }, /api/],
  ])("rejects the api setting %j", (api, message) => {
    expect(() => parseConfig(minimal({ api }), "/")).toThrow(message);
  });

  it("lets a phone have no address when there are ranges to find it in", () => {
    const config = parseConfig(
      minimal({
        discovery: { ranges: ["192.168.1.0/24", "10.0.20.0/24"] },
        devices: [{ id: "mike", udid: UDID, pairRecordPath: "/p" }],
      }),
      "/",
    );
    expect(config.discovery).toEqual({
      ranges: ["192.168.1.0/24", "10.0.20.0/24"],
      scanIntervalSeconds: 300,
    });
    expect(config.devices[0]?.host).toBeUndefined();
  });

  it("refuses a phone that has no address and no ranges to find it in", () => {
    expect(() =>
      parseConfig(minimal({ devices: [{ id: "mike", udid: UDID, pairRecordPath: "/p" }] }), "/"),
    ).toThrow('devices "mike" has no host, and discovery.ranges is empty');
  });

  it.each([
    ["192.168.1.0", /discovery\.ranges\[0\] must be an IPv4 range like/],
    ["192.168.1.0/8", /discovery\.ranges\[0\] must be \/22 or smaller \(at most 1024 addresses\)/],
    ["300.1.1.0/24", /discovery\.ranges\[0\] must be an IPv4 range like/],
    ["fe80::/64", /discovery\.ranges\[0\] must be an IPv4 range like/],
    [24, /discovery\.ranges\[0\] must be an IPv4 range like/],
  ])("rejects the discovery range %j", (range, message) => {
    expect(() => parseConfig(minimal({ discovery: { ranges: [range] } }), "/")).toThrow(message);
  });

  it("will not sweep more often than every 30 seconds", () => {
    expect(() =>
      parseConfig(minimal({ discovery: { scanIntervalSeconds: 5 } }), "/"),
    ).toThrow("discovery.scanIntervalSeconds must be at least 30");
  });

  it("throws ConfigError, not a generic error", () => {
    expect(() => parseConfig([], "/")).toThrow(ConfigError);
  });
});
