#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startApiServer } from "./api/ApiServer.js";
import { createDeviceReader } from "./api/DeviceReader.js";
import { findWebApp } from "./api/webApp.js";
import { createApp, type App } from "./app.js";
import { existsSync } from "node:fs";
import { createPhoneManager } from "./api/PhoneManager.js";
import { ConfigError, loadConfig, type DeviceConfig } from "./config/config.js";
import { OptionsError, readServerOptions } from "./config/serverOptions.js";
import { importConfig } from "./settings/importConfig.js";
import { jsonLogger } from "./log.js";
import { buildReport, formatReport } from "./report/report.js";
import { inspectPairRecord } from "./credentials/pairRecord.js";
import { DeviceError } from "./transport/DeviceTransport.js";
import { describeBuild, readBuildInfo } from "./version.js";

const USAGE = `pommedonjon: self-hosted iPhone backups

Usage:
  pommedonjon daemon
      Run the service: the web app, and a backup of each phone when one is
      wanted and the moment is right.

  pommedonjon probe [--device ID]
      Ask each phone about itself. Read-only; never prompts.

  pommedonjon backup --device ID
      Back one phone up now, ignoring the schedule. The phone will show its
      passcode prompt, and someone must type the passcode within a minute.

  pommedonjon status
      Show each phone's last good backup and recent attempts.

  pommedonjon report [--device ID] [--days N] [--json]
      Day by day, what happened to each phone over the last N days (default
      14): when it was plugged in, each prompt and its outcome, and why no
      backup started when none did.

  pommedonjon import --config FILE
      Bring in the phones and settings of a config file from an earlier
      version. Does nothing if any phone has been added already. The daemon
      does the same at start-up for the file named by POMMEDONJON_CONFIG.

  pommedonjon --version
      Show which build this is.

Phones and settings are managed in the web app and kept in the state
directory. Where things are comes from the environment:

  POMMEDONJON_STATE_DIR    the database and pair records   (default /state)
  POMMEDONJON_PAIRINGS_DIR the pair records, if elsewhere  (default <state>/pairings)
  POMMEDONJON_BACKUP_ROOT  where backups are kept          (default /backups)
  POMMEDONJON_PORT         the web app and API, or "off"   (default 8377)
  POMMEDONJON_TRUST_PROXY  "1" behind a reverse proxy, to take a caller's
                           address from X-Forwarded-For    (default off)
`;

class UsageError extends Error {}

function pickDevices(app: App, id: string | undefined): readonly DeviceConfig[] {
  if (id === undefined) return app.devices.all();
  const device = app.devices.all().find((candidate) => candidate.id === id);
  if (!device) {
    const known = app.devices.all().map((candidate) => candidate.id).join(", ");
    throw new UsageError(`there is no phone "${id}" (known: ${known === "" ? "none" : known})`);
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
  const report = await app.runner.run(device, host, signal, "command");
  if (report.outcome === "succeeded") {
    print(`${device.id}: backed up in ${Math.round(report.durationMs / 1000)} s`);
    return 0;
  }
  print(`${device.id}: backup failed (${report.reason}). ${report.message}`);
  return 1;
}

function status(app: App): number {
  for (const device of app.devices.all()) {
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
    print(`pommedonjon ${describeBuild(readBuildInfo())}`);
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
  if (!["daemon", "probe", "backup", "status", "report", "import"].includes(command)) {
    throw new UsageError(`unknown command "${command}"`);
  }
  if (command === "import" && values.config === undefined) {
    throw new UsageError("import needs --config FILE");
  }

  const options = readServerOptions(process.env);
  const app = createApp(options, jsonLogger);

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  /** Bring in a config file from before settings were kept in the database. */
  const bringIn = async (file: string, again: boolean): Promise<number> =>
    importConfig(await loadConfig(file), {
      state: app.state,
      directory: app.devices,
      pairRecords: app.pairRecords,
      serverSettings: app.serverSettings,
      log: jsonLogger,
      clock: () => new Date(),
      again,
    });

  try {
    if (command === "import") {
      const phones = await bringIn(values.config ?? "", true);
      print(
        phones > 0
          ? `brought in ${phones} phone${phones === 1 ? "" : "s"}; the file is no longer needed`
          : "nothing brought in: there are phones here already, or the file has none that could be read",
      );
      return 0;
    }
    if (command === "daemon") {
      // An earlier version's config file, still mounted: its phones come
      // over once, and after that the file is not read.
      const legacy = values.config ?? options.legacyConfigFile;
      if (legacy !== undefined && existsSync(legacy) && app.devices.all().length === 0) {
        try {
          await bringIn(legacy, false);
        } catch (error) {
          // The service is managed in the web app now. An old file it
          // cannot read must not keep it from starting.
          if (!(error instanceof ConfigError)) throw error;
          jsonLogger("error", "could not read the earlier config file; nothing was brought in", {
            file: legacy,
            problem: error.message,
          });
        }
      }
    }
    if (command !== "status" && command !== "report") {
      // Said once at start-up, before anything depends on it.
      for (const device of app.devices.all()) {
        const finding = await inspectPairRecord(device.pairRecordPath);
        if (finding) jsonLogger(finding.level, finding.problem, { device: device.id });
      }
    }
    switch (command) {
      case "daemon": {
        const webDir = findWebApp(process.env);
        const api =
          options.port === undefined
            ? undefined
            : await startApiServer({
                port: options.port,
                devices: createDeviceReader({
                  devices: app.devices,
                  state: app.state,
                  daemon: app.daemon,
                  clock: () => new Date(),
                }),
                settings: {
                  get: (deviceId) => app.devices.settingsOf(deviceId),
                  change: (deviceId, wanted) => {
                    const result = app.devices.change(deviceId, wanted, new Date());
                    // What the daemon last worked out came from the old settings.
                    if (result?.ok) app.daemon.settingsChanged(deviceId);
                    return result;
                  },
                },
                phones: createPhoneManager({
                  directory: app.devices,
                  pairRecords: app.pairRecords,
                  inspector: app.pairRecordInspector,
                  locator: app.locator,
                  finder: app.finder,
                  addresses: app.state,
                  daemon: app.daemon,
                  serverSettings: app.serverSettings,
                  version: app.version,
                  backupRoot: options.backupRoot,
                  log: jsonLogger,
                  clock: () => new Date(),
                }),
                ...(webDir !== undefined && { webDir }),
                requestBackup: (deviceId) => app.daemon.requestBackup(deviceId),
                stopBackup: (deviceId) => app.daemon.stopBackup(deviceId),
                whoIsAt: (address) => app.identifier.whoIsAt(address),
                reportAppOpen: (deviceId) => app.daemon.reportAppOpen(deviceId),
                trustForwardedFor: options.trustProxy,
                reportPlugIn: (deviceId) => app.daemon.reportPlugIn(deviceId),
                log: jsonLogger,
              });
        try {
          await app.daemon.run(controller.signal);
        } finally {
          await api?.close();
        }
        return 0;
      }
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
    if (
      error instanceof UsageError ||
      error instanceof ConfigError ||
      error instanceof OptionsError
    ) {
      process.stderr.write(`pommedonjon: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `pommedonjon: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
