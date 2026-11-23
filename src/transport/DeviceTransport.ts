/**
 * The seam between nightstand's orchestration logic and whatever actually
 * speaks Apple's device protocols. The first implementation drives
 * pymobiledevice3 through a Python sidecar; anything else that can satisfy
 * this interface could replace it without the daemon noticing. Nothing in
 * this file may mention a specific tool.
 *
 * Shapes that arrive from outside the program (a device's status, the events
 * of a backup) are Zod schemas with their types derived from them, so the
 * same definition both checks the data and types it.
 */

import { z } from "zod";

/** How a usbmux daemon on the host can reach a device. */
export type ConnectionType = "usb" | "network";

/** Where and how to reach one device. */
export type DeviceEndpoint =
  /**
   * Through the host's usbmux daemon. Works on a Mac, or on Linux with
   * usbmuxd (USB) or netmuxd (network). Used for setup and development.
   */
  | { readonly kind: "usbmux"; readonly connection: ConnectionType }
  /**
   * Straight to the device's lockdown port over the network, authenticated
   * with a pair record file. Needs no daemon and no root: this is what the
   * service uses in a container.
   */
  | {
      readonly kind: "tcp";
      /** IP address or resolvable name. */
      readonly host: string;
      /** Defaults to the lockdown port, 62078. */
      readonly port?: number;
      /** Pair record plist exported from a host that has paired with the device. */
      readonly pairRecordPath: string;
    };

export interface DeviceTarget {
  /** Stable hardware identifier, e.g. "00008140-000A1B2C3D4E001C". */
  readonly udid: string;
  readonly endpoint: DeviceEndpoint;
}

/** A device a usbmux daemon currently knows about. */
export interface DeviceInfo {
  readonly udid: string;
  readonly name: string;
  /** Apple's model identifier, e.g. "iPhone17,5". */
  readonly productType: string;
  readonly osVersion: string;
  readonly buildVersion: string;
  /** Every route the device is reachable over right now. Never empty. */
  readonly connections: readonly ConnectionType[];
}

export const BatteryStatusSchema = z.object({
  /** 0 to 100. */
  levelPercent: z.number().min(0).max(100),
  isCharging: z.boolean(),
  /** True when on external power, whether or not it is still charging. */
  externalPowerConnected: z.boolean(),
  fullyCharged: z.boolean(),
});
export type BatteryStatus = Readonly<z.infer<typeof BatteryStatusSchema>>;

/** What a reachable device says about itself. Reading it never prompts. */
export const DeviceStatusSchema = z.object({
  udid: z.string().min(1),
  name: z.string().min(1),
  /** Apple's model identifier, e.g. "iPhone17,5". */
  productType: z.string().min(1),
  osVersion: z.string().min(1),
  buildVersion: z.string().min(1),
  battery: BatteryStatusSchema,
  /** Whether the device will encrypt its backups. */
  backupEncryptionEnabled: z.boolean(),
});
export type DeviceStatus = Readonly<
  Omit<z.infer<typeof DeviceStatusSchema>, "battery"> & { battery: BatteryStatus }
>;

export type DeviceErrorReason =
  /** No answer: off the network, asleep, wrong address, firewalled. */
  | "unreachable"
  /** Reached, but it does not accept this host's pair record. */
  | "not-paired"
  | "failed";

export class DeviceError extends Error {
  override readonly name = "DeviceError";
  constructor(
    message: string,
    readonly reason: DeviceErrorReason,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface BackupOptions extends DeviceTarget {
  /**
   * Directory that holds one subdirectory per device, named by UDID, in the
   * standard Finder/iTunes backup layout.
   */
  readonly backupRoot: string;
  /** Discard local incremental state and take a full backup. */
  readonly full?: boolean;
  /** Aborting this cancels the run. */
  readonly signal?: AbortSignal;
}

export const BackupEventSchema = z.discriminatedUnion("type", [
  /** The transport has started talking to the device. */
  z.object({ type: z.literal("started") }),
  /**
   * The device is showing its passcode prompt and the backup is blocked until
   * someone types the passcode on the phone. A locked phone wakes to show it.
   */
  z.object({ type: z.literal("passcode-required") }),
  /**
   * The passcode prompt went away. This does not say why: the passcode may
   * have been typed, or the prompt may have timed out, in which case the run
   * fails with reason "device-locked" straight afterwards.
   */
  z.object({ type: z.literal("passcode-dismissed") }),
  /**
   * Overall progress as reported by the device, 0 to 100. Not linear in time:
   * an incremental has been seen to sit at 0 for half its run.
   */
  z.object({ type: z.literal("progress"), percent: z.number().min(0).max(100) }),
  /** Anything else the transport said that is worth keeping in a run log. */
  z.object({
    type: z.literal("log"),
    level: z.enum(["info", "warning", "error"]),
    message: z.string(),
  }),
]);
export type BackupEvent = Readonly<z.infer<typeof BackupEventSchema>>;

export interface BackupResult {
  readonly udid: string;
  /** Absolute path of this device's backup directory. */
  readonly backupDir: string;
  readonly durationMs: number;
}

export type BackupFailureReason =
  /** Cancelled by the caller. */
  | "cancelled"
  /**
   * The device refused because it is locked. Seen on iOS 26.6.1 when the
   * passcode prompt is left unanswered for 60 seconds.
   */
  | "device-locked"
  /** The device could not be reached, or the connection dropped. */
  | "unreachable"
  /** Reached, but it does not accept this host's pair record. */
  | "not-paired"
  /** Anything else. */
  | "failed";

export class BackupError extends Error {
  override readonly name = "BackupError";
  constructor(
    message: string,
    readonly reason: BackupFailureReason,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface BackupRun {
  /** Subscribe to events. Returns an unsubscribe function. */
  onEvent(listener: (event: BackupEvent) => void): () => void;
  /** Resolves when the backup completes; rejects with {@link BackupError}. */
  readonly done: Promise<BackupResult>;
  cancel(): void;
}

export interface DeviceTransport {
  /**
   * Devices the host's usbmux daemon knows about, one entry per UDID with its
   * routes merged. Useful for setup; a container has no usbmux daemon and
   * finds devices from configuration instead.
   */
  listDevices(): Promise<DeviceInfo[]>;
  /** Ask a device about itself. Rejects with {@link DeviceError}. */
  probe(target: DeviceTarget): Promise<DeviceStatus>;
  /** Rejects with {@link DeviceError}. */
  getBattery(target: DeviceTarget): Promise<BatteryStatus>;
  startBackup(options: BackupOptions): BackupRun;
}
