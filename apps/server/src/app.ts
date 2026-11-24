import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PommedonjonConfig } from "./config/config.js";
import { Daemon } from "./daemon/Daemon.js";
import { DeviceLocator } from "./discovery/DeviceLocator.js";
import { PortScanner } from "./discovery/PortScanner.js";
import type { Logger } from "./log.js";
import { BackupRunner } from "./runner/BackupRunner.js";
import { DeviceDirectory } from "./settings/DeviceDirectory.js";
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
  readonly config: PommedonjonConfig;
  /** The phones, with what has been changed from the app applied. */
  readonly devices: DeviceDirectory;
  readonly transport: DeviceTransport;
  readonly locator: DeviceLocator;
  readonly state: StateStore;
  readonly runner: BackupRunner;
  readonly daemon: Daemon;
  close(): void;
}

/** Wire the real implementations together from a loaded config. */
export function createApp(
  config: PommedonjonConfig,
  log: Logger,
  env: NodeJS.ProcessEnv = process.env,
): App {
  const pythonPath = config.sidecar.pythonPath ?? env["POMMEDONJON_PYTHON"];
  const sidecar = new Sidecar({
    ...(pythonPath !== undefined && { pythonPath }),
    ...(config.sidecar.scriptPath !== undefined && {
      scriptPath: config.sidecar.scriptPath,
    }),
  });
  const transport = new Pymobiledevice3Transport({ sidecar });

  mkdirSync(config.stateDir, { recursive: true });
  const state = new StateStore(path.join(config.stateDir, "pommedonjon.sqlite"));

  const devices = new DeviceDirectory({ devices: config.devices, state });

  const store = new BackupStore(config.backupRoot);
  const clock = () => new Date();

  const locator = new DeviceLocator({
    transport,
    addresses: state,
    scanner: new PortScanner({
      ranges: config.discovery.ranges,
      port: LOCKDOWN_PORT,
      minIntervalMs: config.discovery.scanIntervalSeconds * 1000,
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
  const daemon = new Daemon({
    config,
    devices,
    locator,
    runner,
    state,
    log,
    clock,
    version: describeBuild(readBuildInfo(env)),
    sleep,
  });

  return {
    config,
    devices,
    transport,
    locator,
    state,
    runner,
    daemon,
    close: () => state.close(),
  };
}
