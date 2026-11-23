#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createApp, type App } from "./app.js";
import { ConfigError, loadConfig, type DeviceConfig } from "./config/config.js";
import { jsonLogger } from "./notify/Notifier.js";
import { buildReport, formatReport } from "./report/report.js";
import { inspectPairRecord } from "./credentials/pairRecord.js";
import { DeviceError } from "./transport/DeviceTransport.js";
import { describeBuild, readBuildInfo } from "./version.js";

const USAGE = `nightstand: self-hosted iPhone backups

Usage:
  nightstand daemon --config FILE
      Run the service: back each phone up when it is due, home and ready.

  nightstand probe --config FILE [--device ID]
      Ask each configured phone about itself. Read-only; never prompts.

  nightstand backup --config FILE --device ID
      Back one phone up now, ignoring the schedule. The phone will show its
      passcode prompt, and someone must type the passcode within a minute.

  nightstand status --config FILE
      Show each phone's last good backup and recent attempts.

  nightstand report --config FILE [--device ID] [--days N] [--json]
      Day by day, what happened to each phone over the last N days (default
      14): when it was plugged in, each prompt and its outcome, and why no
      backup started when none did.

  nightstand --version
      Show which build this is.

The config file path can also come from the NIGHTSTAND_CONFIG environment
variable.
`;

class UsageError extends Error {}

function pickDevices(app: App, id: string | undefined): readonly DeviceConfig[] {
  if (id === undefined) return app.config.devices;
  const device = app.config.devices.find((candidate) => candidate.id === id);
  if (!device) {
    const known = app.config.devices.map((candidate) => candidate.id).join(", ");
    throw new UsageError(`no device "${id}" in the config (known: ${known})`);
  }
  return [device];
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function probe(app: App, deviceId: string | undefined): Promise<number> {
  let failures = 0;
  for (const device of pickDevices(app, deviceId)) {
    try {
      const { status, host } = await app.locator.locate(device);
      const power = status.battery.externalPowerConnected ? "on charger" : "on battery";
      print(
        `${device.id}: reachable at ${host}. ${status.productType}, iOS ${status.osVersion}, ` +
          `battery ${status.battery.levelPercent}% ${power}, ` +
          `backup encryption ${status.backupEncryptionEnabled ? "on" : "OFF"}`,
      );
    } catch (error) {
      failures += 1;
      const reason = error instanceof DeviceError ? error.reason : "failed";
      const message = error instanceof Error ? error.message : String(error);
      print(`${device.id}: ${reason}. ${message}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

async function backup(app: App, deviceId: string | undefined, signal: AbortSignal): Promise<number> {
  if (deviceId === undefined) {
    throw new UsageError("backup needs --device ID");
  }
  const [device] = pickDevices(app, deviceId);
  if (!device) return 2;
  let host: string;
  try {
    ({ host } = await app.locator.locate(device));
  } catch (error) {
    if (!(error instanceof DeviceError)) throw error;
    print(`${device.id}: backup not started (${error.reason}). ${error.message}`);
    return 1;
  }
  const report = await app.runner.run(device, host, signal);
  if (report.outcome === "succeeded") {
    print(`${device.id}: backed up in ${Math.round(report.durationMs / 1000)} s`);
    return 0;
  }
  print(`${device.id}: backup failed (${report.reason}). ${report.message}`);
  return 1;
}

function status(app: App): number {
  for (const device of app.config.devices) {
    const last = app.state.lastSuccessAt(device.id);
    print(`${device.id}: last good backup ${last ? last.toISOString() : "never"}`);
    for (const run of app.state.recentRuns(device.id, 5)) {
      const detail =
        run.outcome === "failed" ? ` (${run.failureReason ?? "failed"})` : "";
      print(`  ${run.startedAt.toISOString()}  ${run.outcome}${detail}`);
    }
  }
  return 0;
}

function report(
  app: App,
  deviceId: string | undefined,
  daysOption: string | undefined,
  asJson: boolean,
): number {
  const days = daysOption === undefined ? 14 : Number(daysOption);
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new UsageError("--days must be a whole number from 1 to 366");
  }
  const now = new Date();
  // The first of the N days starts at local midnight.
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const reports = pickDevices(app, deviceId).map((device) =>
    buildReport({
      deviceId: device.id,
      since,
      now,
      runs: app.state.runsSince(device.id, since),
      eventsFor: (runId) => app.state.eventsFor(runId),
      deviceEvents: app.state.deviceEventsSince(device.id, since),
    }),
  );
  print(asJson ? JSON.stringify(reports, null, 2) : reports.map(formatReport).join("\n\n"));
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      config: { type: "string" },
      device: { type: "string" },
      days: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
  if (values.version) {
    print(`nightstand ${describeBuild(readBuildInfo())}`);
    return 0;
  }
  const [command, ...extra] = positionals;
  if (values.help || command === undefined) {
    print(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected argument "${extra[0]}"`);
  }
  if (!["daemon", "probe", "backup", "status", "report"].includes(command)) {
    throw new UsageError(`unknown command "${command}"`);
  }

  const configPath = values.config ?? process.env["NIGHTSTAND_CONFIG"];
  if (configPath === undefined) {
    throw new UsageError("no config file: pass --config FILE or set NIGHTSTAND_CONFIG");
  }
  const app = createApp(await loadConfig(configPath), jsonLogger);

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    if (command !== "status" && command !== "report") {
      // Said once at start-up, before anything depends on it.
      for (const device of app.config.devices) {
        const finding = await inspectPairRecord(device.pairRecordPath);
        if (finding) jsonLogger(finding.level, finding.problem, { device: device.id });
      }
    }
    switch (command) {
      case "daemon":
        await app.daemon.run(controller.signal);
        return 0;
      case "probe":
        return await probe(app, values.device);
      case "backup":
        return await backup(app, values.device, controller.signal);
      case "report":
        return report(app, values.device, values.days, values.json === true);
      default:
        return status(app);
    }
  } finally {
    app.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError || error instanceof ConfigError) {
      process.stderr.write(`nightstand: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `nightstand: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
