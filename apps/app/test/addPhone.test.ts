import type { DeviceCheck } from "@pommedonjon/api-contract";
import { describe, expect, it } from "vitest";
import {
  describeCheck,
  looksLikeUdid,
  parseRanges,
  problemsWithPhone,
  toBase64,
  udidFromFileName,
} from "../src/phones/addPhone";

describe("udidFromFileName", () => {
  it.each([
    ["00008140-000A1B2C3D4E001C.plist", "00008140-000A1B2C3D4E001C"],
    ["mike 00008140-000a1b2c3d4e001c (1).plist", "00008140-000a1b2c3d4e001c"],
    ["0123456789abcdef0123456789abcdef01234567.plist", "0123456789abcdef0123456789abcdef01234567"],
  ])("finds the identifier in %s", (fileName, udid) => {
    expect(udidFromFileName(fileName)).toBe(udid);
  });

  it("finds none in a file named some other way", () => {
    expect(udidFromFileName("mike.plist")).toBeUndefined();
  });
});

describe("looksLikeUdid", () => {
  it("knows an identifier from something else", () => {
    expect(looksLikeUdid(" 00008140-000A1B2C3D4E001C ")).toBe(true);
    expect(looksLikeUdid("00008140-000A1B2C3D4E001C.plist")).toBe(false);
    expect(looksLikeUdid("mike")).toBe(false);
  });
});

describe("toBase64", () => {
  it.each([
    ["", ""],
    ["f", "Zg=="],
    ["fo", "Zm8="],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg=="],
    ["foobar", "Zm9vYmFy"],
  ])("encodes %j as %s", (text, expected) => {
    expect(toBase64(new TextEncoder().encode(text))).toBe(expected);
  });

  it("agrees with the platform on bytes of every value", () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_unused, index) => (index * 37) % 256);
    expect(toBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)));
  });
});

describe("problemsWithPhone", () => {
  const filled = {
    name: "Mike's iPhone",
    udid: "00008140-000A1B2C3D4E001C",
    host: "",
    pairing: { fileName: "x.plist", base64: "Zm9v" },
  };

  it("finds nothing wrong once everything needed is there", () => {
    expect(problemsWithPhone(filled)).toEqual([]);
  });

  it("says what is wrong, all at once", () => {
    expect(problemsWithPhone({ name: " ", udid: "mike", host: "", pairing: undefined })).toEqual([
      "Choose the phone's pairing file.",
      "That does not look like a phone's identifier.",
    ]);
  });

  it("needs only the pairing: the phone is asked its name and identifier", () => {
    expect(problemsWithPhone({ ...filled, name: "", udid: "" })).toEqual([]);
  });

  it("says when the identifier is not one", () => {
    expect(problemsWithPhone({ ...filled, udid: "mike" })).toEqual([
      "That does not look like a phone's identifier.",
    ]);
  });
});

describe("describeCheck", () => {
  const ready: DeviceCheck = {
    reachable: true,
    paired: true,
    encryptionOn: true,
    model: "iPhone17,5",
    osVersion: "26.6.1",
    batteryPercent: 94,
    onCharger: false,
    locked: false,
    problem: null,
  };
  const unknown = {
    paired: null,
    encryptionOn: null,
    model: null,
    osVersion: null,
    batteryPercent: null,
    onCharger: null,
    locked: null,
  };

  it("ticks everything for a phone that is ready, and says what it is", () => {
    expect(describeCheck(ready)).toEqual({
      lines: [
        { ok: true, text: "At home: the phone answered." },
        { ok: true, text: "Pairing accepted." },
        { ok: true, text: "Backup encryption is on." },
      ],
      detail: "iPhone17,5, iOS 26.6.1, battery 94%, on battery, unlocked",
    });
  });

  it("says a phone that does not answer may only be out or asleep", () => {
    const away = describeCheck({ ...unknown, reachable: false, problem: "unreachable" });
    expect(away.lines.map((line) => line.ok)).toEqual([false, null, null]);
    expect(away.lines[0]?.text).toContain("Not answering");
    expect(away.detail).toBeUndefined();
  });

  it("says a phone that refuses its pairing needs pairing again", () => {
    const refused = describeCheck({ ...unknown, reachable: true, paired: false, problem: "not-paired" });
    expect(refused.lines[1]).toEqual({
      ok: false,
      text: "The phone refused its pairing. It needs pairing again.",
    });
  });

  it("says so when encryption is off, and when a different phone answered", () => {
    expect(describeCheck({ ...ready, encryptionOn: false, problem: "encryption-off" }).lines[2]?.ok).toBe(false);
    expect(describeCheck({ ...ready, problem: "wrong-phone" }).lines[1]).toEqual({
      ok: false,
      text: "A different phone answered: the identifier does not match.",
    });
  });
});

describe("parseRanges", () => {
  it("takes ranges separated by commas, spaces or lines", () => {
    expect(parseRanges(" 192.168.1.0/24, 10.0.0.0/24\n172.16.5.0/24 ")).toEqual([
      "192.168.1.0/24",
      "10.0.0.0/24",
      "172.16.5.0/24",
    ]);
    expect(parseRanges("  ")).toEqual([]);
  });
});
