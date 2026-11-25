import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Sidecar, type SidecarChild } from "../../src/sidecar/Sidecar.js";

/** Stands in for a sidecar process: tests write its output and end it. */
export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: (NodeJS.Signals | number | undefined)[] = [];

  constructor(
    readonly command: string,
    readonly args: readonly string[],
  ) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }

  say(...messages: object[]): void {
    for (const message of messages) {
      this.stdout.write(`${JSON.stringify(message)}\n`);
    }
  }

  /** Close stdio, then report the exit the way a real child process does. */
  async exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.stdout.end();
    this.stderr.end();
    await new Promise((resolve) => setImmediate(resolve));
    this.emit("close", code, signal);
  }

  /** Print one JSON object and exit, as the one-shot commands do. */
  respond(value: object, code = 0): void {
    this.say(value);
    void this.exit(code);
  }
}

export interface FakeSidecar {
  readonly sidecar: Sidecar;
  /** Every process started so far, oldest first. */
  readonly children: FakeChild[];
}

/**
 * A Sidecar whose processes are fakes. `onSpawn` runs for each one as it
 * starts, which is where a test scripts a one-shot command's reply.
 */
export function fakeSidecar(onSpawn?: (child: FakeChild) => void): FakeSidecar {
  const children: FakeChild[] = [];
  const sidecar = new Sidecar({
    pythonPath: "/venv/bin/python",
    scriptPath: "/app/sidecar.py",
    spawn: (command, args) => {
      const child = new FakeChild(command, args);
      children.push(child);
      // Let the caller attach its listeners before any output arrives.
      if (onSpawn) setImmediate(() => onSpawn(child));
      return child as unknown as SidecarChild;
    },
  });
  return { sidecar, children };
}
