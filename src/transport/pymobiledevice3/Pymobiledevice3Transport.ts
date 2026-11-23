import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { Sidecar, type SidecarChild } from "../../sidecar/Sidecar.js";
import {
  BackupError,
  DeviceError,
  type BackupEvent,
  type BackupOptions,
  type BackupResult,
  type BackupRun,
  type BatteryStatus,
  type DeviceInfo,
  type DeviceStatus,
  type DeviceTarget,
  type DeviceTransport,
} from "../DeviceTransport.js";
import { parseUsbmuxList } from "./parse.js";
import {
  endpointArgs,
  parseProbeResult,
  parseSidecarLine,
  type SidecarMessage,
} from "./sidecarProtocol.js";

export type ExecFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string }>;

export interface Pymobiledevice3TransportOptions {
  readonly sidecar: Sidecar;
  /**
   * The pymobiledevice3 executable, used only by listDevices. Defaults to
   * finding it on PATH.
   */
  readonly cliPath?: string;
  /** How long a probe may take before the device counts as unreachable. */
  readonly probeTimeoutMs?: number;
  /** Test seam. */
  readonly exec?: ExecFn;
}

const execFileAsync = promisify(execFile);

const defaultExec: ExecFn = (file, args) =>
  execFileAsync(file, [...args], { maxBuffer: 16 * 1024 * 1024 });

/** A little over the sidecar's own 20 second probe timeout. */
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/**
 * Device access by way of pymobiledevice3: the Python sidecar for probing and
 * backups, and the pymobiledevice3 CLI for listing what usbmuxd can see.
 */
export class Pymobiledevice3Transport implements DeviceTransport {
  readonly #sidecar: Sidecar;
  readonly #cliPath: string;
  readonly #probeTimeoutMs: number;
  readonly #exec: ExecFn;

  constructor(options: Pymobiledevice3TransportOptions) {
    this.#sidecar = options.sidecar;
    this.#cliPath = options.cliPath ?? "pymobiledevice3";
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#exec = options.exec ?? defaultExec;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const { stdout } = await this.#exec(this.#cliPath, ["usbmux", "list"]);
    return parseUsbmuxList(stdout);
  }

  async probe(target: DeviceTarget): Promise<DeviceStatus> {
    let result;
    try {
      result = await this.#sidecar.runJson(["probe", ...endpointArgs(target)], {
        timeoutMs: this.#probeTimeoutMs,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A probe that hangs is a device that is not answering.
      throw new DeviceError(
        message,
        message.includes("timed out") ? "unreachable" : "failed",
        { cause },
      );
    }
    if (result.value === undefined) {
      const detail = result.stderrTail.trim();
      throw new DeviceError(
        `probe ended with exit code ${result.exitCode} and no result` +
          (detail ? `: ${detail}` : ""),
        "failed",
      );
    }
    const status = parseProbeResult(result.value);
    if (status.udid !== target.udid) {
      // The address answered, but it is a different device. Never back up
      // one phone into another phone's directory.
      throw new DeviceError(
        `the device at this endpoint is ${status.udid}, not ${target.udid}`,
        "failed",
      );
    }
    return status;
  }

  async getBattery(target: DeviceTarget): Promise<BatteryStatus> {
    return (await this.probe(target)).battery;
  }

  startBackup(options: BackupOptions): BackupRun {
    const args = [
      "backup",
      ...endpointArgs(options),
      "--backup-root",
      options.backupRoot,
    ];
    if (options.full) args.push("--full");
    return new SidecarBackupRun(
      this.#sidecar.spawn(args),
      options.udid,
      options.signal,
    );
  }
}

/** How much of the sidecar's stderr to keep for an error message. */
const STDERR_TAIL_CHARS = 4000;

class SidecarBackupRun implements BackupRun {
  readonly done: Promise<BackupResult>;
  readonly #listeners = new Set<(event: BackupEvent) => void>();
  readonly #child: SidecarChild;
  #cancelled = false;

  constructor(child: SidecarChild, udid: string, signal?: AbortSignal) {
    this.#child = child;

    this.done = new Promise<BackupResult>((resolve, reject) => {
      let outcome: Exclude<SidecarMessage, { kind: "event" }> | undefined;
      let stderrTail = "";

      if (child.stdout) {
        createInterface({ input: child.stdout }).on("line", (line) => {
          const message = parseSidecarLine(line);
          if (!message) return;
          if (message.kind === "event") this.#emit(message.event);
          else outcome ??= message;
        });
      }
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS);
      });

      child.once("error", (cause: Error) => {
        reject(
          new BackupError(
            `could not start the backup helper: ${cause.message}`,
            "failed",
            { cause },
          ),
        );
      });

      child.once("close", (code: number | null, killedBy: NodeJS.Signals | null) => {
        if (this.#cancelled) {
          reject(new BackupError("backup cancelled", "cancelled"));
        } else if (outcome?.kind === "finished" && code === 0) {
          resolve({
            udid,
            backupDir: outcome.backupDir,
            durationMs: outcome.durationMs,
          });
        } else if (outcome?.kind === "error") {
          reject(new BackupError(outcome.message, outcome.reason));
        } else {
          const how = killedBy ? `signal ${killedBy}` : `exit code ${code}`;
          const detail = stderrTail.trim();
          reject(
            new BackupError(
              `backup helper ended (${how}) without reporting a result` +
                (detail ? `: ${detail}` : ""),
              "failed",
            ),
          );
        }
      });
    });

    if (signal) {
      if (signal.aborted) this.cancel();
      else signal.addEventListener("abort", () => this.cancel(), { once: true });
    }
  }

  onEvent(listener: (event: BackupEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#child.kill("SIGTERM");
  }

  #emit(event: BackupEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
