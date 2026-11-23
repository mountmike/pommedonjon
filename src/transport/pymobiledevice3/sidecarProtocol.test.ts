import { describe, expect, it } from "vitest";
import { DeviceError } from "../DeviceTransport.js";
import { parseProbeResult, parseSidecarLine } from "./sidecarProtocol.js";

const goodProbe = {
  ok: true,
  udid: "00008140-000A1B2C3D4E001C",
  name: "Mike's iPhone",
  productType: "iPhone17,5",
  osVersion: "26.6.1",
  buildVersion: "23G83",
  battery: {
    levelPercent: 97,
    isCharging: false,
    externalPowerConnected: false,
    fullyCharged: false,
  },
  backupEncryptionEnabled: true,
};

function unrecognised(line: string) {
  return {
    kind: "event",
    event: { type: "log", level: "warning", message: `unrecognised sidecar output: ${line}` },
  };
}

describe("parseSidecarLine", () => {
  it("ignores fields it does not know, so the sidecar can add to a message", () => {
    expect(parseSidecarLine('{"event":"progress","percent":42,"bytes":1234}')).toEqual({
      kind: "event",
      event: { type: "progress", percent: 42 },
    });
  });

  it.each([
    '{"event":"progress","percent":"42"}',
    '{"event":"progress"}',
    '{"event":"finished","backupDir":"/b"}',
    '{"event":"log","message":7}',
    '{"percent":42}',
    "[1,2,3]",
    "null",
  ])("surfaces a line with a missing or mistyped field as a warning: %s", (line) => {
    expect(parseSidecarLine(line)).toEqual(unrecognised(line));
  });

  it("keeps a progress value inside 0 to 100", () => {
    expect(parseSidecarLine('{"event":"progress","percent":104.2}')).toMatchObject({
      event: { percent: 100 },
    });
    expect(parseSidecarLine('{"event":"progress","percent":-1}')).toMatchObject({
      event: { percent: 0 },
    });
  });

  it("still reports an error whose details are missing or malformed", () => {
    expect(parseSidecarLine('{"event":"error"}')).toEqual({
      kind: "error",
      reason: "failed",
      message: "unknown error",
    });
    expect(
      parseSidecarLine('{"event":"error","message":"x","code":"208","category":"odd"}'),
    ).toEqual({ kind: "error", reason: "failed", message: "x" });
  });

  it("reads error 208 as an unanswered passcode prompt, whatever the category", () => {
    expect(
      parseSidecarLine('{"event":"error","message":"Device locked","code":208,"category":"failed"}'),
    ).toEqual({ kind: "error", reason: "device-locked", message: "Device locked" });
  });

  it("defaults an unknown log level to info", () => {
    expect(parseSidecarLine('{"event":"log","level":"chatty","message":"hello"}')).toEqual({
      kind: "event",
      event: { type: "log", level: "info", message: "hello" },
    });
  });
});

describe("parseProbeResult", () => {
  it("returns the device status without the wire's ok flag", () => {
    const { ok: _ok, ...status } = goodProbe;
    expect(parseProbeResult({ ...goodProbe, extra: "ignored" })).toEqual(status);
  });

  it("throws the sidecar's own failure with its category", () => {
    const failure = { ok: false, category: "unreachable", message: "TimeoutError" };
    expect(() => parseProbeResult(failure)).toThrow(DeviceError);
    expect(() => parseProbeResult(failure)).toThrow("TimeoutError");
    try {
      parseProbeResult(failure);
    } catch (error) {
      expect((error as DeviceError).reason).toBe("unreachable");
    }
  });

  it.each([
    [{ ...goodProbe, battery: { ...goodProbe.battery, levelPercent: 140 } }, /battery\.levelPercent/],
    [{ ...goodProbe, battery: undefined }, /battery/],
    [{ ...goodProbe, osVersion: "" }, /osVersion/],
    [{ ...goodProbe, backupEncryptionEnabled: "yes" }, /backupEncryptionEnabled/],
    [{ ...goodProbe, backupEncryptionEnabled: undefined }, /backupEncryptionEnabled/],
    ["nonsense", /unexpected reply/],
    [{}, /unexpected reply/],
  ])("refuses a reply it cannot trust, naming the field: %j", (reply, message) => {
    expect(() => parseProbeResult(reply)).toThrow(message);
    expect(() => parseProbeResult(reply)).toThrow(DeviceError);
  });
});
