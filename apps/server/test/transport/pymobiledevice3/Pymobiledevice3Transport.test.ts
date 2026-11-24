import { describe, expect, it } from "vitest";
import { fakeSidecar, type FakeChild } from "../../support/fakeSidecar.js";
import {
  BackupError,
  DeviceError,
  type BackupEvent,
  type DeviceTarget,
} from "../../../src/transport/DeviceTransport.js";
import { Pymobiledevice3Transport } from "../../../src/transport/pymobiledevice3/Pymobiledevice3Transport.js";

const UDID = "00008140-000A1B2C3D4E001C";

const overTcp: DeviceTarget = {
  udid: UDID,
  endpoint: { host: "10.0.0.7", pairRecordPath: "/secrets/pair.plist" },
};

const probeReply = {
  ok: true,
  udid: UDID,
  name: "Test iPhone",
  productType: "iPhone17,5",
  osVersion: "26.6.1",
  buildVersion: "23G83",
  battery: {
    levelPercent: 97,
    isCharging: false,
    externalPowerConnected: true,
    fullyCharged: false,
  },
  backupEncryptionEnabled: true,
};

function startFakeBackup(
  options: { signal?: AbortSignal; full?: boolean; target?: DeviceTarget } = {},
) {
  const { sidecar, children } = fakeSidecar();
  let clock = 0;
  const transport = new Pymobiledevice3Transport({ sidecar, now: () => clock });
  const { target = overTcp, ...rest } = options;
  const run = transport.startBackup({
    ...target,
    backupRoot: "/data/backups",
    ...rest,
  });
  const events: BackupEvent[] = [];
  run.onEvent((event) => events.push(event));
  const child = children[0] as FakeChild;
  /** Let the lines said so far be read, then move the clock on. */
  const afterSeconds = async (seconds: number) => {
    await new Promise((resolve) => setImmediate(resolve));
    clock += seconds * 1000;
  };
  return { child, run, events, afterSeconds };
}

describe("Pymobiledevice3Transport.startBackup", () => {
  it("backs up over direct TCP with the pair record", () => {
    const { child } = startFakeBackup({ full: true });
    expect(child.command).toBe("/venv/bin/python");
    expect(child.args).toEqual([
      "/app/sidecar.py",
      "backup",
      "--udid",
      UDID,
      "--host",
      "10.0.0.7",
      "--pair-record",
      "/secrets/pair.plist",
      "--backup-root",
      "/data/backups",
      "--full",
    ]);
  });

  it("passes a non-default port through", () => {
    const { child } = startFakeBackup({
      target: {
        udid: UDID,
        endpoint: {
          host: "10.0.0.7",
          port: 1234,
          pairRecordPath: "/p.plist",
        },
      },
    });
    expect(child.args).toContain("--port");
    expect(child.args[child.args.indexOf("--port") + 1]).toBe("1234");
  });

  it("does not force a full backup unless asked", () => {
    const { child } = startFakeBackup();
    expect(child.args).not.toContain("--full");
  });

  it("forwards events in order and resolves with the sidecar's result", async () => {
    const { child, run, events } = startFakeBackup();
    child.say(
      { event: "started" },
      { event: "passcode-required" },
      { event: "passcode-dismissed" },
      { event: "progress", percent: 12.5 },
      { event: "progress", percent: 100 },
      { event: "finished", backupDir: `/data/backups/${UDID}`, durationMs: 4200 },
    );
    await child.exit(0);

    await expect(run.done).resolves.toEqual({
      udid: UDID,
      backupDir: `/data/backups/${UDID}`,
      durationMs: 4200,
    });
    expect(events).toEqual([
      { type: "started" },
      { type: "passcode-required" },
      { type: "passcode-dismissed" },
      { type: "progress", percent: 12.5 },
      { type: "progress", percent: 100 },
    ]);
  });

  const deviceLocked = {
    event: "error",
    kind: "PyMobileDevice3Exception",
    category: "failed",
    message: "Device locked (MBErrorDomain/208)",
    code: 208,
  };

  it("reports a passcode prompt left for its full minute as device-locked", async () => {
    const { child, run, afterSeconds } = startFakeBackup();
    child.say({ event: "started" }, { event: "passcode-required" });
    await afterSeconds(60);
    child.say({ event: "passcode-dismissed" }, deviceLocked);
    await child.exit(1);

    await expect(run.done).rejects.toMatchObject({
      name: "BackupError",
      reason: "device-locked",
      message: "Device locked (MBErrorDomain/208)",
    });
  });

  it("reports a prompt dismissed on the phone as cancelled, though the device says the same thing", async () => {
    // Measured on the real phone: Cancel was tapped and the prompt closed
    // after 2.6 seconds, followed by the same error 208 as a timeout.
    const { child, run, afterSeconds } = startFakeBackup();
    child.say({ event: "started" }, { event: "passcode-required" });
    await afterSeconds(2.6);
    child.say({ event: "passcode-dismissed" }, deviceLocked);
    await child.exit(1);

    await expect(run.done).rejects.toMatchObject({
      name: "BackupError",
      reason: "passcode-cancelled",
      message: "the passcode prompt was dismissed on the phone after 3 s",
    });
  });

  it.each([
    [44, "passcode-cancelled"],
    [45, "device-locked"],
  ])("draws the line at 45 seconds: closed after %i s is %s", async (seconds, reason) => {
    const { child, run, afterSeconds } = startFakeBackup();
    child.say({ event: "passcode-required" });
    await afterSeconds(seconds);
    child.say({ event: "passcode-dismissed" }, deviceLocked);
    await child.exit(1);
    await expect(run.done).rejects.toMatchObject({ reason });
  });

  it("does not call it a cancel when the prompt closed quickly and the backup then ran", async () => {
    const { child, run, afterSeconds } = startFakeBackup();
    child.say({ event: "passcode-required" });
    await afterSeconds(3);
    child.say(
      { event: "passcode-dismissed" },
      { event: "finished", backupDir: "/data/backups/x", durationMs: 5 },
    );
    await child.exit(0);
    await expect(run.done).resolves.toMatchObject({ durationMs: 5 });
  });

  it("keeps device-locked when the device refused without ever showing a prompt", async () => {
    const { child, run } = startFakeBackup();
    child.say({ event: "started" }, deviceLocked);
    await child.exit(1);
    await expect(run.done).rejects.toMatchObject({ reason: "device-locked" });
  });

  it("reports a dropped connection as unreachable", async () => {
    const { child, run } = startFakeBackup();
    child.say({
      event: "error",
      kind: "ConnectionTerminatedError",
      category: "unreachable",
      message: "Connection was terminated abruptly.",
      code: null,
    });
    await child.exit(1);
    await expect(run.done).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("reports a rejected pair record as not-paired", async () => {
    const { child, run } = startFakeBackup();
    child.say({ event: "error", kind: "NotPairedError", category: "not-paired", message: "x" });
    await child.exit(1);
    await expect(run.done).rejects.toMatchObject({ reason: "not-paired" });
  });

  it("treats other device errors as a plain failure", async () => {
    const { child, run } = startFakeBackup();
    child.say({ event: "error", kind: "X", message: "disk full", code: 105 });
    await child.exit(1);
    await expect(run.done).rejects.toMatchObject({ reason: "failed" });
  });

  it("fails with the stderr tail when the sidecar dies without a result", async () => {
    const { child, run } = startFakeBackup();
    child.say({ event: "started" });
    child.stderr.write("ModuleNotFoundError: No module named 'pymobiledevice3'\n");
    await child.exit(1);

    const error = await run.done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).reason).toBe("failed");
    expect((error as BackupError).message).toContain("exit code 1");
    expect((error as BackupError).message).toContain("ModuleNotFoundError");
  });

  it("does not report success if the sidecar said finished but exited non-zero", async () => {
    const { child, run } = startFakeBackup();
    child.say({ event: "finished", backupDir: "/x", durationMs: 1 });
    await child.exit(1);
    await expect(run.done).rejects.toMatchObject({ reason: "failed" });
  });

  it("cancel() terminates the sidecar once and rejects as cancelled", async () => {
    const { child, run } = startFakeBackup();
    child.say({ event: "started" });
    run.cancel();
    run.cancel();
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await child.exit(null, "SIGTERM");
    await expect(run.done).rejects.toMatchObject({ reason: "cancelled" });
  });

  it("cancels when the AbortSignal fires", async () => {
    const controller = new AbortController();
    const { child, run } = startFakeBackup({ signal: controller.signal });
    controller.abort();
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await child.exit(null, "SIGTERM");
    await expect(run.done).rejects.toMatchObject({ reason: "cancelled" });
  });

  it("surfaces output it does not understand as a warning instead of dropping it", async () => {
    const { child, run, events } = startFakeBackup();
    child.stdout.write("Traceback (most recent call last):\n");
    child.say({ event: "telemetry", n: 1 });
    child.say({ event: "finished", backupDir: "/x", durationMs: 1 });
    await child.exit(0);
    await run.done;
    expect(events).toEqual([
      {
        type: "log",
        level: "warning",
        message: "unrecognised sidecar output: Traceback (most recent call last):",
      },
      {
        type: "log",
        level: "warning",
        message: 'unrecognised sidecar output: {"event":"telemetry","n":1}',
      },
    ]);
  });

  it("stops delivering events to a listener that unsubscribed", async () => {
    const { child, run } = startFakeBackup();
    const seen: BackupEvent[] = [];
    const unsubscribe = run.onEvent((event) => seen.push(event));
    child.say({ event: "started" });
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribe();
    child.say({ event: "progress", percent: 50 });
    child.say({ event: "finished", backupDir: "/x", durationMs: 1 });
    await child.exit(0);
    await run.done;
    expect(seen).toEqual([{ type: "started" }]);
  });
});

describe("Pymobiledevice3Transport.probe", () => {
  it("asks the sidecar about the device and returns its status", async () => {
    const { sidecar, children } = fakeSidecar((child) => child.respond(probeReply));
    const transport = new Pymobiledevice3Transport({ sidecar });

    await expect(transport.probe(overTcp)).resolves.toEqual({
      udid: UDID,
      name: "Test iPhone",
      productType: "iPhone17,5",
      osVersion: "26.6.1",
      buildVersion: "23G83",
      battery: {
        levelPercent: 97,
        isCharging: false,
        externalPowerConnected: true,
        fullyCharged: false,
      },
      backupEncryptionEnabled: true,
    });
    expect(children[0]?.args).toEqual([
      "/app/sidecar.py",
      "probe",
      "--udid",
      UDID,
      "--host",
      "10.0.0.7",
      "--pair-record",
      "/secrets/pair.plist",
    ]);
  });

  it("reports a phone that does not answer as unreachable", async () => {
    const { sidecar } = fakeSidecar((child) =>
      child.respond(
        { ok: false, category: "unreachable", kind: "TimeoutError", message: "TimeoutError" },
        1,
      ),
    );
    const transport = new Pymobiledevice3Transport({ sidecar });
    const error = await transport.probe(overTcp).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceError);
    expect((error as DeviceError).reason).toBe("unreachable");
  });

  it("reports a rejected pair record as not-paired", async () => {
    const { sidecar } = fakeSidecar((child) =>
      child.respond({ ok: false, category: "not-paired", message: "no" }, 1),
    );
    const transport = new Pymobiledevice3Transport({ sidecar });
    await expect(transport.probe(overTcp)).rejects.toMatchObject({
      reason: "not-paired",
    });
  });

  it("refuses a different device answering at the configured address", async () => {
    const { sidecar } = fakeSidecar((child) =>
      child.respond({ ...probeReply, udid: "00008150-000F0E0D0C0B002E" }),
    );
    const transport = new Pymobiledevice3Transport({ sidecar });
    await expect(transport.probe(overTcp)).rejects.toThrow(/not 00008140/);
  });

  it("treats a hung probe as unreachable and kills it", async () => {
    const { sidecar, children } = fakeSidecar();
    const transport = new Pymobiledevice3Transport({ sidecar, probeTimeoutMs: 10 });
    const pending = transport.probe(overTcp).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const child = children[0] as FakeChild;
    expect(child.killSignals).toEqual(["SIGKILL"]);
    await child.exit(null, "SIGKILL");
    const error = await pending;
    expect((error as DeviceError).reason).toBe("unreachable");
  });

  it("fails clearly when the sidecar prints nothing", async () => {
    const { sidecar } = fakeSidecar((child) => {
      child.stderr.write("python3: can't open file\n");
      void child.exit(2);
    });
    const transport = new Pymobiledevice3Transport({ sidecar });
    const error = await transport.probe(overTcp).catch((e: unknown) => e);
    expect((error as DeviceError).reason).toBe("failed");
    expect((error as DeviceError).message).toContain("can't open file");
  });

  it("rejects a reply with a missing field rather than guessing", async () => {
    const { name: _dropped, ...rest } = probeReply;
    const { sidecar } = fakeSidecar((child) => child.respond(rest));
    const transport = new Pymobiledevice3Transport({ sidecar });
    await expect(transport.probe(overTcp)).rejects.toThrow(/name/);
  });
});
