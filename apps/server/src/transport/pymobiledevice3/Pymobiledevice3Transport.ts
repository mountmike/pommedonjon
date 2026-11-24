import { createInterface } from "node:readline";
import { Sidecar, type SidecarChild } from "../../sidecar/Sidecar.js";
import {
  BackupError,
  DeviceError,
  type BackupEvent,
  type BackupOptions,
  type BackupResult,
  type BackupRun,
  type DeviceStatus,
  type DeviceEndpoint,
  type DeviceTarget,
  type DeviceTransport,
} from "../DeviceTransport.js";
import {
  addressArgs,
  endpointArgs,
  parseProbeResult,
  parseSidecarLine,
  type SidecarMessage,
} from "./sidecarProtocol.js";

export interface Pymobiledevice3TransportOptions {
  readonly sidecar: Sidecar;
  /** How long a probe may take before the device counts as unreachable. */
  readonly probeTimeoutMs?: number;
  /** Milliseconds since the epoch; the clock used to time the passcode prompt. */
  readonly now?: () => number;
}

/** A little over the sidecar's own 20 second probe timeout. */
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/**
 * Device access by way of pymobiledevice3, through the Python sidecar.
 */
export class Pymobiledevice3Transport implements DeviceTransport {
  readonly #sidecar: Sidecar;
  readonly #probeTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: Pymobiledevice3TransportOptions) {
    this.#sidecar = options.sidecar;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Run the sidecar's probe and read what the device said about itself. */
  async #ask(args: readonly string[]): Promise<DeviceStatus> {
    let result;
    try {
      result = await this.#sidecar.runJson(["probe", ...args], {
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
    return parseProbeResult(result.value);
  }

  identify(endpoint: DeviceEndpoint): Promise<DeviceStatus> {
    return this.#ask(addressArgs(endpoint));
  }

  async probe(target: DeviceTarget): Promise<DeviceStatus> {
    const status = await this.#ask(endpointArgs(target));
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
      this.#now,
      options.signal,
    );
  }
}

/**
 * A passcode prompt that nobody touches closes after 60 seconds (measured:
 * 58 to 61). One that is dismissed on the phone closes when it is dismissed,
 * and the device then reports the same "Device locked" error either way. So
 * a prompt that closed well short of a minute was cancelled by a person.
 * Measured once: 2.6 seconds.
 */
const PROMPT_CANCELLED_BELOW_MS = 45_000;

/** How much of the sidecar's stderr to keep for an error message. */
const STDERR_TAIL_CHARS = 4000;

class SidecarBackupRun implements BackupRun {
  readonly done: Promise<BackupResult>;
  readonly #listeners = new Set<(event: BackupEvent) => void>();
  readonly #child: SidecarChild;
  #cancelled = false;

  constructor(
    child: SidecarChild,
    udid: string,
    now: () => number,
    signal?: AbortSignal,
  ) {
    this.#child = child;

    this.done = new Promise<BackupResult>((resolve, reject) => {
      let outcome: Exclude<SidecarMessage, { kind: "event" }> | undefined;
      let stderrTail = "";
      let promptShownAt: number | undefined;
      let promptOpenMs: number | undefined;

      if (child.stdout) {
        createInterface({ input: child.stdout }).on("line", (line) => {
          const message = parseSidecarLine(line);
          if (!message) return;
          if (message.kind === "event") {
            if (message.event.type === "passcode-required") {
              promptShownAt = now();
            } else if (message.event.type === "passcode-dismissed" && promptShownAt !== undefined) {
              promptOpenMs = now() - promptShownAt;
            }
            this.#emit(message.event);
          } else outcome ??= message;
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
        } else if (
          outcome?.kind === "error" &&
          outcome.reason === "device-locked" &&
          promptOpenMs !== undefined &&
          promptOpenMs < PROMPT_CANCELLED_BELOW_MS
        ) {
          reject(
            new BackupError(
              `the passcode prompt was dismissed on the phone after ${Math.round(promptOpenMs / 1000)} s`,
              "passcode-cancelled",
            ),
          );
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
