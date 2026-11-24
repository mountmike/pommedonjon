import { Socket } from "node:net";
import { addressesIn } from "./ranges.js";

/** Resolves true if something accepts a TCP connection there in time. */
export type ConnectFn = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

const tcpConnect: ConnectFn = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = new Socket();
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });

export interface PortScannerOptions {
  /**
   * IPv4 ranges to sweep, e.g. ["192.168.1.0/24"]. A function, so that a
   * change made while running applies to the next sweep.
   */
  readonly ranges: readonly string[] | (() => readonly string[]);
  readonly port: number;
  /** A sweep is not repeated more often than this; in between, the last result is reused. */
  readonly minIntervalMs: number;
  readonly clock: () => Date;
  readonly connect?: ConnectFn;
  /** How long the first knock on each address waits. */
  readonly timeoutMs?: number;
  /** How long the second knock waits, on addresses that ignored the first. */
  readonly retryTimeoutMs?: number;
  readonly concurrency?: number;
}

/**
 * Finds which addresses in the configured ranges have the lockdown port
 * open. That is all it says: any Apple device answers there, so a caller
 * still has to prove which device it is with a pair record.
 *
 * Sweeps are rationed. A phone that is away is the normal case, and without
 * a limit every poll for every phone would knock on every address.
 */
export class PortScanner {
  readonly #ranges: () => readonly string[];
  readonly #connect: ConnectFn;
  readonly #timeoutMs: number;
  readonly #retryTimeoutMs: number;
  readonly #concurrency: number;
  #last:
    | { readonly at: number; readonly sweep: number; readonly open: Promise<string[]> }
    | undefined;
  /** The last sweep each caller has been given, so none is handed out twice. */
  readonly #seen = new Map<string, number>();

  constructor(private readonly options: PortScannerOptions) {
    const { ranges } = options;
    this.#ranges = typeof ranges === "function" ? ranges : () => ranges;
    this.#connect = options.connect ?? tcpConnect;
    this.#timeoutMs = options.timeoutMs ?? 2000;
    this.#retryTimeoutMs = options.retryTimeoutMs ?? 6000;
    this.#concurrency = options.concurrency ?? 128;
  }

  get enabled(): boolean {
    return this.#ranges().length > 0;
  }

  /**
   * Addresses with the port open that this caller has not been given yet.
   *
   * A new sweep starts only if the last one is old enough. Callers that ask
   * while one is running, or soon after, share its result, so several phones
   * being looked for at once cost one sweep. Each caller gets each sweep's
   * result once; asking again before the next sweep returns nothing, so a
   * phone that is away is not re-tested against the same addresses on every
   * poll.
   */
  async candidates(caller: string): Promise<string[]> {
    const now = this.options.clock().getTime();
    if (!this.#last || now - this.#last.at >= this.options.minIntervalMs) {
      this.#last = { at: now, sweep: (this.#last?.sweep ?? 0) + 1, open: this.#sweep() };
    }
    if (this.#seen.get(caller) === this.#last.sweep) return [];
    this.#seen.set(caller, this.#last.sweep);
    return this.#last.open;
  }

  async #sweep(): Promise<string[]> {
    const addresses = [...new Set(this.#ranges().flatMap(addressesIn))];
    const open = new Set(await this.#pass(addresses, this.#timeoutMs));
    // A phone has been seen to ignore one connection attempt and accept the
    // next, and to take over six seconds to accept one. So everything that
    // did not answer gets a second, more patient knock.
    const quiet = addresses.filter((address) => !open.has(address));
    for (const address of await this.#pass(quiet, this.#retryTimeoutMs)) open.add(address);
    return addresses.filter((address) => open.has(address));
  }

  async #pass(addresses: readonly string[], timeoutMs: number): Promise<string[]> {
    const open: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < addresses.length) {
        const address = addresses[next++] as string;
        if (await this.#connect(address, this.options.port, timeoutMs)) {
          open.push(address);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#concurrency, addresses.length) }, worker),
    );
    return open;
  }
}
