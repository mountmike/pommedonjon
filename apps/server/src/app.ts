import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ServerOptions } from "./config/serverOptions.js";
import { SidecarPairRecordInspector, type PairRecordInspector } from "./credentials/PairRecordInspector.js";
import { PairRecordStore } from "./credentials/PairRecordStore.js";
import { Daemon } from "./daemon/Daemon.js";
import { DeviceLocator } from "./discovery/DeviceLocator.js";
import { PortScanner } from "./discovery/PortScanner.js";
import type { Logger } from "./log.js";
import { BackupRunner } from "./runner/BackupRunner.js";
import { DeviceDirectory } from "./settings/DeviceDirectory.js";
import { ServerSettingsStore } from "./settings/ServerSettings.js";
import { Sidecar } from "./sidecar/Sidecar.js";
import { StateStore } from "./state/StateStore.js";
import { BackupStore } from "./storage/BackupStore.js";
import { SidecarBackupVerifier } from "./storage/BackupVerifier.js";
import type { DeviceTransport } from "./transport/DeviceTransport.js";
import { Pymobiledevice3Transport } from "./transport/pymobiledevice3/Pymobiledevice3Transport.js";
import { describeBuild, readBuildInfo } from "./version.js";

/** The lockdown service's port on every iOS device. */
const LOCKDOWN_PORT = 62078;

/** Resolves after the delay, or early if the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface App {
  readonly options: ServerOptions;
  /** The server's own settings, as they stand. */
  readonly serverSettings: ServerSettingsStore;
  /** The phones, with what has been changed from the app applied. */
  readonly devices: DeviceDirectory;
  readonly pairRecords: PairRecordStore;
  readonly pairRecordInspector: PairRecordInspector;
  readonly transport: DeviceTransport;
  readonly locator: DeviceLocator;
  readonly state: StateStore;
  readonly runner: BackupRunner;
  readonly daemon: Daemon;
  /** Which build this is. */
  readonly version: string;
  close(): void;
}

/** Wire the real implementations together. */
export function createApp(
  options: ServerOptions,
  log: Logger,
  env: NodeJS.ProcessEnv = process.env,
): App {
  const sidecar = new Sidecar({
    ...(options.sidecar.pythonPath !== undefined && { pythonPath: options.sidecar.pythonPath }),
    ...(options.sidecar.scriptPath !== undefined && { scriptPath: options.sidecar.scriptPath }),
  });
  const transport = new Pymobiledevice3Transport({ sidecar });

  mkdirSync(options.stateDir, { recursive: true });
  const state = new StateStore(path.join(options.stateDir, "pommedonjon.sqlite"));
  const serverSettings = new ServerSettingsStore(state);
  const pairRecords = new PairRecordStore(path.join(options.stateDir, "pairings"));
  const devices = new DeviceDirectory({ state, pairRecords });

  const store = new BackupStore(options.backupRoot);
  const clock = () => new Date();

  const locator = new DeviceLocator({
    transport,
    addresses: state,
    scanner: new PortScanner({
      // Read at each sweep, so a range set in the app applies without a restart.
      ranges: () => serverSettings.get().discoveryRanges,
      port: LOCKDOWN_PORT,
      minIntervalMs: serverSettings.get().scanIntervalSeconds * 1000,
      clock,
    }),
    log,
    clock,
  });

  const runner = new BackupRunner({
    transport,
    store,
    verifier: new SidecarBackupVerifier(sidecar),
    state,
    log,
    clock,
  });
  const version = describeBuild(readBuildInfo(env));
  const daemon = new Daemon({
    // Read at each pass, so a change made in the app applies without a restart.
    config: {
      get pollIntervalSeconds() {
        return serverSettings.get().pollIntervalSeconds;
      },
    },
    devices,
    locator,
    runner,
    state,
    log,
    clock,
    version,
    sleep,
  });

  return {
    options,
    serverSettings,
    devices,
    pairRecords,
    pairRecordInspector: new SidecarPairRecordInspector(sidecar),
    transport,
    locator,
    state,
    runner,
    daemon,
    version,
    close: () => state.close(),
  };
}
