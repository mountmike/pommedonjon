import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The parts of a child process the callers depend on. */
export type SidecarChild = Pick<ChildProcess, "stdout" | "stderr" | "once" | "kill">;

export type SpawnFn = (command: string, args: readonly string[]) => SidecarChild;

export interface SidecarOptions {
  /** A Python interpreter that can import pymobiledevice3. */
  readonly pythonPath?: string;
  /** Path to pommedonjon_sidecar.py. Defaults to the copy in this repo. */
  readonly scriptPath?: string;
  /** Test seam. */
  readonly spawn?: SpawnFn;
}

export interface JsonCommandResult {
  readonly exitCode: number | null;
  /** The JSON value from the last line of stdout, if there was one. */
  readonly value: unknown;
  /** The end of stderr, for error messages. */
  readonly stderrTail: string;
}

const defaultSpawn: SpawnFn = (command, args) =>
  spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });

const DEFAULT_SCRIPT_PATH = fileURLToPath(
  new URL("../../sidecar/pommedonjon_sidecar.py", import.meta.url),
);

const STDERR_TAIL_CHARS = 4000;

/**
 * Runs the Python sidecar. One instance is shared by everything that needs
 * the device-protocol side: the transport and the backup verifier.
 */
export class Sidecar {
  readonly #pythonPath: string;
  readonly #scriptPath: string;
  readonly #spawn: SpawnFn;

  constructor(options: SidecarOptions = {}) {
    this.#pythonPath = options.pythonPath ?? "python3";
    this.#scriptPath = options.scriptPath ?? DEFAULT_SCRIPT_PATH;
    this.#spawn = options.spawn ?? defaultSpawn;
  }

  /** Start a sidecar command and hand back the process for streaming. */
  spawn(args: readonly string[]): SidecarChild {
    return this.#spawn(this.#pythonPath, [this.#scriptPath, ...args]);
  }

  /**
   * Run a sidecar command that prints a single JSON object. Resolves whatever
   * the exit code, so the caller can read a structured failure; rejects only
   * if the process cannot be started or gives up on the timeout.
   */
  runJson(
    args: readonly string[],
    options: { readonly timeoutMs?: number } = {},
  ): Promise<JsonCommandResult> {
    return new Promise<JsonCommandResult>((resolve, reject) => {
      const child = this.spawn(args);
      let stdout = "";
      let stderrTail = "";
      let timedOut = false;

      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, options.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS);
      });
      child.once("error", (cause: Error) => {
        clearTimeout(timer);
        reject(new Error(`could not start the sidecar: ${cause.message}`, { cause }));
      });
      child.once("close", (exitCode: number | null) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`sidecar timed out after ${options.timeoutMs} ms`));
          return;
        }
        resolve({ exitCode, value: parseLastJsonLine(stdout), stderrTail });
      });
    });
  }
}

function parseLastJsonLine(stdout: string): unknown {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}
