import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_POLICY, parseConfig } from "./config.js";

const UDID = "00008140-000A1B2C3D4E001C";

function minimal(overrides: object = {}) {
  return {
    backupRoot: "backups",
    stateDir: "/var/lib/nightstand",
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

describe("parseConfig", () => {
  it("fills in defaults and resolves relative paths against the config's directory", () => {
    const config = parseConfig(minimal(), "/etc/nightstand");
    expect(config).toEqual({
      backupRoot: "/etc/nightstand/backups",
      stateDir: "/var/lib/nightstand",
      pollIntervalSeconds: 120,
      headsUpLeadSeconds: 5,
      snapshots: { strategy: "none", keep: 7 },
      sidecar: { pythonPath: undefined, scriptPath: undefined },
      devices: [
        {
          id: "mike",
          name: "mike",
          udid: UDID,
          host: "10.0.0.7",
          port: undefined,
          pairRecordPath: "/etc/nightstand/secrets/mike.plist",
          policy: DEFAULT_POLICY,
        },
      ],
    });
  });

  it("defaults to waking hours so a prompt never lights the phone at night", () => {
    expect(DEFAULT_POLICY.window).toEqual({ startMinutes: 420, endMinutes: 1320 });
  });

  it("layers a device's policy over defaultPolicy over the built-in defaults", () => {
    const config = parseConfig(
      minimal({
        defaultPolicy: { minIntervalHours: 12, window: { start: "18:00", end: "23:30" } },
        devices: [
          {
            id: "mike",
            udid: UDID,
            host: "h",
            pairRecordPath: "/p",
            policy: { requireExternalPower: false, minBatteryPercent: 30 },
          },
        ],
      }),
      "/",
    );
    expect(config.devices[0]?.policy).toEqual({
      ...DEFAULT_POLICY,
      minIntervalHours: 12,
      window: { startMinutes: 18 * 60, endMinutes: 23 * 60 + 30 },
      requireExternalPower: false,
      minBatteryPercent: 30,
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
      defaultPolicy: { minBatteryPercent: 140 },
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
      "defaultPolicy.minBatteryPercent must be between 0 and 100",
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
    [{ snapshots: { strategy: "zfs" } }, /snapshots.strategy/],
    [{ pollIntervalSecond: 60 }, /pollIntervalSecond is not a recognised setting/],
    [{ defaultPolicy: { window: { start: "25:00", end: "01:00" } } }, /window.start/],
    [{ defaultPolicy: { window: { start: "09:00", end: "09:00" } } }, /must differ/],
    [{ defaultPolicy: { minBatteryPercent: 140 } }, /between 0 and 100/],
    [{ defaultPolicy: { requireExternalPower: "yes" } }, /true or false/],
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

  it("throws ConfigError, not a generic error", () => {
    expect(() => parseConfig([], "/")).toThrow(ConfigError);
  });
});
