import { describe, expect, it } from "vitest";
import { UnexpectedOutputError, parseUsbmuxList } from "../../../src/transport/pymobiledevice3/parse.js";

// Shapes captured from pymobiledevice3 11.63.1 against iOS 26.6.1, with the
// real identifiers replaced.
const UDID = "00008140-000A1B2C3D4E001C";

function usbmuxEntry(connectionType: string, overrides: object = {}) {
  return {
    BuildVersion: "23G83",
    ConnectionType: connectionType,
    DeviceClass: "iPhone",
    DeviceName: "Test iPhone",
    Identifier: UDID,
    ProductType: "iPhone17,5",
    ProductVersion: "26.6.1",
    UniqueDeviceID: UDID,
    ...overrides,
  };
}

describe("parseUsbmuxList", () => {
  it("merges the USB and Network entries of one phone, USB first", () => {
    const stdout = JSON.stringify([
      usbmuxEntry("Network"),
      usbmuxEntry("USB"),
    ]);
    expect(parseUsbmuxList(stdout)).toEqual([
      {
        udid: UDID,
        name: "Test iPhone",
        productType: "iPhone17,5",
        osVersion: "26.6.1",
        buildVersion: "23G83",
        connections: ["usb", "network"],
      },
    ]);
  });

  it("keeps different phones apart", () => {
    const other = "00008150-000F0E0D0C0B002E";
    const stdout = JSON.stringify([
      usbmuxEntry("USB"),
      usbmuxEntry("Network", { UniqueDeviceID: other, DeviceName: "Second" }),
    ]);
    const devices = parseUsbmuxList(stdout);
    expect(devices.map((d) => [d.udid, d.connections])).toEqual([
      [UDID, ["usb"]],
      [other, ["network"]],
    ]);
  });

  it("returns no devices for an empty list", () => {
    expect(parseUsbmuxList("[]")).toEqual([]);
  });

  it("rejects output that is not JSON", () => {
    expect(() => parseUsbmuxList("No devices found")).toThrow(
      UnexpectedOutputError,
    );
  });

  it("rejects an entry with no UDID rather than inventing one", () => {
    const stdout = JSON.stringify([usbmuxEntry("USB", { UniqueDeviceID: "" })]);
    expect(() => parseUsbmuxList(stdout)).toThrow(/UniqueDeviceID/);
  });

  it("rejects a connection type it does not know", () => {
    const stdout = JSON.stringify([usbmuxEntry("Bluetooth")]);
    expect(() => parseUsbmuxList(stdout)).toThrow(/Bluetooth/);
  });
});
