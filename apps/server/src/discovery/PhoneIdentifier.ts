import { Socket } from "node:net";
import type { DeviceConfig } from "../config/config.js";
import type { DeviceSource } from "../settings/DeviceDirectory.js";
import { DeviceError, type DeviceTransport } from "../transport/DeviceTransport.js";

/** Whether something accepts a TCP connection at an address in time. */
export type KnockFn = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

const tcpKnock: KnockFn = (host, port, timeoutMs) =>
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

/** How long an answer about an address is trusted. Addresses change hands slowly. */
const REMEMBER_PHONE_MS = 5 * 60 * 1000;
/** A browser on a computer asks on every page; do not knock on it every time. */
const REMEMBER_NOBODY_MS = 60 * 1000;
/** How long the knock on an address waits for an answer. */
const KNOCK_TIMEOUT_MS = 3000;
/** How many addresses' answers are kept at once. */
const MAX_REMEMBERED = 256;

/**
 * Works out which phone a request came from, by its address: the server
 * connects back to that address with each phone's pairing, and the phone
 * that accepts one is the phone that asked. Nothing has to be set up on
 * the phone or in the app, and one phone cannot pass for another, because
 * only the real one holds the other half of its pairing.
 *
 * An address is not a lasting identity, so the answer is kept only briefly.
 */
export class PhoneIdentifier {
  readonly #known = new Map<string, { readonly at: number; readonly deviceId: string | undefined }>();
  readonly #asking = new Map<string, Promise<string | undefined>>();
  readonly #knock: KnockFn;

  constructor(
    private readonly deps: {
      readonly devices: DeviceSource;
      readonly transport: Pick<DeviceTransport, "identify">;
      readonly clock: () => Date;
      /** The lockdown port. */
      readonly port: number;
      /**
       * Whether a phone is being backed up right now. Such a phone is not
       * asked who it is: a second connection during a backup is one more
       * thing to go wrong. Left out, none is ever taken to be.
       */
      readonly isBusy?: (deviceId: string) => boolean;
      /** Test seam. */
      readonly knock?: KnockFn;
    },
  ) {
    this.#knock = deps.knock ?? tcpKnock;
  }

  /** The id of the phone at this address, or undefined if it is none of them. */
  whoIsAt(address: string): Promise<string | undefined> {
    const now = this.deps.clock().getTime();
    const known = this.#known.get(address);
    if (known) {
      const good = known.deviceId === undefined ? REMEMBER_NOBODY_MS : REMEMBER_PHONE_MS;
      // A phone that has since been removed is nobody.
      const stillHere = known.deviceId === undefined || this.deps.devices.get(known.deviceId);
      if (now - known.at < good && stillHere) return Promise.resolve(known.deviceId);
    }
    // Several requests from one address at once share one look.
    const asking = this.#asking.get(address);
    if (asking) return asking;
    const look = this.#look(address).finally(() => this.#asking.delete(address));
    this.#asking.set(address, look);
    return look;
  }

  async #look(address: string): Promise<string | undefined> {
    const deviceId = await this.#find(address);
    const now = this.deps.clock().getTime();
    // What is remembered is bounded: forget what is out of date, and if
    // that is not enough, everything. It is only a saving of effort.
    if (this.#known.size >= MAX_REMEMBERED) {
      for (const [known, answer] of this.#known) {
        if (now - answer.at >= REMEMBER_PHONE_MS) this.#known.delete(known);
      }
      if (this.#known.size >= MAX_REMEMBERED) this.#known.clear();
    }
    this.#known.set(address, { at: now, deviceId });
    return deviceId;
  }

  async #find(address: string): Promise<string | undefined> {
    const devices = this.deps.devices
      .all()
      .filter((device) => !(this.deps.isBusy?.(device.id) ?? false));
    if (devices.length === 0) return undefined;
    // A computer has nothing listening there, and says so at once. A phone
    // can take a few seconds to answer, so it is given them.
    if (!(await this.#knock(address, this.deps.port, KNOCK_TIMEOUT_MS))) return undefined;
    const answers = await Promise.all(
      devices.map(async (device: DeviceConfig): Promise<string | undefined> => {
        try {
          const status = await this.deps.transport.identify({
            host: address,
            pairRecordPath: device.pairRecordPath,
          });
          return status.udid.toLowerCase() === device.udid.toLowerCase() ? device.id : undefined;
        } catch (error) {
          if (error instanceof DeviceError) return undefined;
          throw error;
        }
      }),
    );
    return answers.find((deviceId) => deviceId !== undefined);
  }
}

/**
 * The address a request came from, as the phone would be reached at it.
 * IPv4 addresses arrive wrapped on a dual-stack socket: "::ffff:192.168.1.5".
 */
export function plainAddress(remote: string | undefined): string | undefined {
  if (remote === undefined || remote === "") return undefined;
  const unwrapped = remote.startsWith("::ffff:") ? remote.slice("::ffff:".length) : remote;
  return unwrapped;
}
