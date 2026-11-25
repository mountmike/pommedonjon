import { describe, expect, it } from "vitest";
import { readServerOptions } from "../../src/config/serverOptions.js";

describe("readServerOptions", () => {
  it("uses the image's places and port when nothing is set", () => {
    expect(readServerOptions({})).toEqual({
      stateDir: "/state",
      pairingsDir: "/state/pairings",
      backupRoot: "/backups",
      port: 8377,
      trustProxy: false,
      sidecar: { pythonPath: undefined, scriptPath: undefined },
      legacyConfigFile: undefined,
    });
  });

  it("takes each from the environment", () => {
    expect(
      readServerOptions({
        POMMEDONJON_STATE_DIR: "/srv/state",
        POMMEDONJON_BACKUP_ROOT: "/mnt/backups",
        POMMEDONJON_PORT: "9000",
        POMMEDONJON_PYTHON: "/opt/sidecar/bin/python",
        POMMEDONJON_SIDECAR: "/app/sidecar/pommedonjon_sidecar.py",
        POMMEDONJON_CONFIG: "/config/pommedonjon.json",
      }),
    ).toEqual({
      stateDir: "/srv/state",
      pairingsDir: "/srv/state/pairings",
      backupRoot: "/mnt/backups",
      port: 9000,
      trustProxy: false,
      sidecar: {
        pythonPath: "/opt/sidecar/bin/python",
        scriptPath: "/app/sidecar/pommedonjon_sidecar.py",
      },
      legacyConfigFile: "/config/pommedonjon.json",
    });
  });

  it("makes a relative place absolute, and treats an empty value as not set", () => {
    const options = readServerOptions({ POMMEDONJON_STATE_DIR: "local/state", POMMEDONJON_PORT: " " });
    expect(options.stateDir).toBe(`${process.cwd()}/local/state`);
    expect(options.port).toBe(8377);
  });

  it("keeps the pair records somewhere else if told to", () => {
    const options = readServerOptions({ POMMEDONJON_PAIRINGS_DIR: "/run/pairings" });
    expect(options.pairingsDir).toBe("/run/pairings");
    expect(options.stateDir).toBe("/state");
  });

  it("trusts a proxy's word for the caller's address only when told to", () => {
    expect(readServerOptions({ POMMEDONJON_TRUST_PROXY: "1" }).trustProxy).toBe(true);
    expect(readServerOptions({ POMMEDONJON_TRUST_PROXY: "True" }).trustProxy).toBe(true);
    expect(readServerOptions({ POMMEDONJON_TRUST_PROXY: "0" }).trustProxy).toBe(false);
  });

  it("listens on nothing when the port is off", () => {
    expect(readServerOptions({ POMMEDONJON_PORT: "off" }).port).toBeUndefined();
    expect(readServerOptions({ POMMEDONJON_PORT: "OFF" }).port).toBeUndefined();
  });

  it.each(["0", "70000", "eighty", "80.5"])("refuses the port %s", (value) => {
    expect(() => readServerOptions({ POMMEDONJON_PORT: value })).toThrow(/POMMEDONJON_PORT/);
  });
});
