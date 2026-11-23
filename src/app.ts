import { mkdirSync } from "node:fs";
import path from "node:path";
import type { NightstandConfig } from "./config/config.js";
import { Daemon } from "./daemon/Daemon.js";
import { LogNotifier, type Logger, type Notifier } from "./notify/Notifier.js";
import { BackupRunner } from "./runner/BackupRunner.js";
import { Sidecar } from "./sidecar/Sidecar.js";
import { StateStore } from "./state/StateStore.js";
import { BackupStore } from "./storage/BackupStore.js";
import { SidecarBackupVerifier } from "./storage/BackupVerifier.js";
import type { DeviceTransport } from "./transport/DeviceTransport.js";
import { Pymobiledevice3Transport } from "./transport/pymobiledevice3/Pymobiledevice3Transport.js";

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
  readonly config: NightstandConfig;
  readonly transport: DeviceTransport;
  readonly state: StateStore;
  readonly runner: BackupRunner;
  readonly daemon: Daemon;
  readonly notifier: Notifier;
  close(): void;
}

/** Wire the real implementations together from a loaded config. */
export function createApp(
  config: NightstandConfig,
  log: Logger,
  env: NodeJS.ProcessEnv = process.env,
): App {
  const pythonPath = config.sidecar.pythonPath ?? env["NIGHTSTAND_PYTHON"];
  const sidecar = new Sidecar({
    ...(pythonPath !== undefined && { pythonPath }),
    ...(config.sidecar.scriptPath !== undefined && {
      scriptPath: config.sidecar.scriptPath,
    }),
  });
  const transport = new Pymobiledevice3Transport({ sidecar });

  mkdirSync(config.stateDir, { recursive: true });
  const state = new StateStore(path.join(config.stateDir, "nightstand.sqlite"));

  const store = new BackupStore(config.backupRoot);
  // No delivery channel has been chosen yet, so notifications only reach the
  // service log.
  const notifier = new LogNotifier(log);
  const clock = () => new Date();

  const runner = new BackupRunner({
    transport,
    store,
    verifier: new SidecarBackupVerifier(sidecar),
    state,
    notifier,
    log,
    clock,
    sleep,
    headsUpLeadSeconds: config.headsUpLeadSeconds,
  });
  const daemon = new Daemon({
    config,
    transport,
    runner,
    state,
    notifier,
    log,
    clock,
    sleep,
  });

  return { config, transport, state, runner, daemon, notifier, close: () => state.close() };
}
