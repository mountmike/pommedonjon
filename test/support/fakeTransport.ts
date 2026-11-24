import {
  BackupError,
  DeviceError,
  type BackupEvent,
  type BackupOptions,
  type BackupResult,
  type BackupRun,
  type BatteryStatus,
  type DeviceStatus,
  type DeviceTarget,
  type DeviceTransport,
} from "../../src/transport/DeviceTransport.js";

export class FakeBackupRun implements BackupRun {
  readonly done: Promise<BackupResult>;
  cancelled = false;
  readonly #listeners = new Set<(event: BackupEvent) => void>();
  #resolve!: (result: BackupResult) => void;
  #reject!: (error: BackupError) => void;

  constructor(readonly options: BackupOptions) {
    this.done = new Promise<BackupResult>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // A test may fail a run nobody is awaiting yet.
    this.done.catch(() => undefined);
  }

  onEvent(listener: (event: BackupEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  cancel(): void {
    this.cancelled = true;
    this.#reject(new BackupError("backup cancelled", "cancelled"));
  }

  emit(...events: BackupEvent[]): void {
    for (const event of events) {
      for (const listener of this.#listeners) listener(event);
    }
  }

  succeed(durationMs = 1000): void {
    this.#resolve({
      udid: this.options.udid,
      backupDir: `${this.options.backupRoot}/${this.options.udid}`,
      durationMs,
    });
  }

  fail(error: BackupError): void {
    this.#reject(error);
  }
}

export const FAKE_UDID = "00008140-000A1B2C3D4E001C";

export function fakeStatus(overrides: Partial<DeviceStatus> = {}): DeviceStatus {
  return {
    udid: FAKE_UDID,
    name: "Test iPhone",
    productType: "iPhone17,5",
    osVersion: "26.6.1",
    buildVersion: "23G83",
    battery: {
      levelPercent: 80,
      isCharging: true,
      externalPowerConnected: true,
      fullyCharged: false,
    },
    backupEncryptionEnabled: true,
    ...overrides,
  };
}

/**
 * A transport with no phone behind it. `probeResult` is what a probe returns
 * or throws; `onBackup` scripts each backup after the caller has subscribed.
 */
export class FakeTransport implements DeviceTransport {
  probeResult: DeviceStatus | DeviceError = fakeStatus();
  readonly probes: DeviceTarget[] = [];
  readonly backups: FakeBackupRun[] = [];
  onBackup: (run: FakeBackupRun) => void = (run) => run.succeed();

  probe(target: DeviceTarget): Promise<DeviceStatus> {
    this.probes.push(target);
    return this.probeResult instanceof DeviceError
      ? Promise.reject(this.probeResult)
      : Promise.resolve(this.probeResult);
  }

  startBackup(options: BackupOptions): BackupRun {
    const run = new FakeBackupRun(options);
    this.backups.push(run);
    options.signal?.addEventListener("abort", () => run.cancel(), { once: true });
    setImmediate(() => this.onBackup(run));
    return run;
  }
}
