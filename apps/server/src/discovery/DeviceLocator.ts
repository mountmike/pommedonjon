import type { DeviceConfig } from "../config/config.js";
import type { Logger } from "../log.js";
import {
  DeviceError,
  type DeviceStatus,
  type DeviceTarget,
  type DeviceTransport,
} from "../transport/DeviceTransport.js";

/** Remembers where each phone was last reached. */
export interface AddressBook {
  lastAddress(deviceId: string): string | undefined;
  rememberAddress(deviceId: string, host: string, at: Date): void;
}

/** The part of the port scanner the locator needs. */
export interface AddressScanner {
  readonly enabled: boolean;
  /**
   * Addresses worth trying that this caller has not been given before.
   * `fresh`: look again now, for someone who is waiting on the answer.
   */
  candidates(caller: string, options?: { readonly fresh?: boolean }): Promise<string[]>;
}

export interface Located {
  /** Where the phone answered. */
  readonly host: string;
  readonly status: DeviceStatus;
}

export interface DeviceLocatorDeps {
  readonly transport: Pick<DeviceTransport, "probe">;
  readonly addresses: AddressBook;
  readonly scanner: AddressScanner;
  readonly log: Logger;
  readonly clock: () => Date;
}

export function targetAt(device: DeviceConfig, host: string): DeviceTarget {
  return {
    udid: device.udid,
    endpoint: {
      host,
      pairRecordPath: device.pairRecordPath,
      ...(device.port !== undefined && { port: device.port }),
    },
  };
}

/**
 * Finds a phone on the network and asks it about itself.
 *
 * An address is only ever a place to look. What makes a device "this phone"
 * is that it accepts this phone's pair record and reports this phone's UDID,
 * which the transport's probe checks. So a wrong or stale address can waste
 * a probe but can never lead to backing up the wrong phone.
 *
 * Where it looks, in order:
 *
 * 1. The `host` in the config, if one is set. Then nowhere else: someone who
 *    pins an address has said where the phone is.
 * 2. The address the phone was last reached at.
 * 3. Every address in the configured ranges that has the lockdown port open.
 */
export class DeviceLocator {
  constructor(private readonly deps: DeviceLocatorDeps) {}

  /** Rejects with {@link DeviceError}; "unreachable" when the phone is not found. */
  async locate(device: DeviceConfig): Promise<Located> {
    const { transport, addresses, scanner, log, clock } = this.deps;

    if (device.host !== undefined) {
      return {
        host: device.host,
        status: await transport.probe(targetAt(device, device.host)),
      };
    }

    const lastKnown = addresses.lastAddress(device.id);
    let lastKnownError: DeviceError | undefined;
    if (lastKnown !== undefined) {
      try {
        return { host: lastKnown, status: await transport.probe(targetAt(device, lastKnown)) };
      } catch (error) {
        if (!(error instanceof DeviceError)) throw error;
        lastKnownError = error;
      }
    }

    if (!scanner.enabled) {
      throw (
        lastKnownError ??
        new DeviceError(
          `no address is known for ${device.id}: set its host, or discovery ranges`,
          "unreachable",
        )
      );
    }

    // Each candidate is some Apple device; only this phone's pair record
    // will be accepted by this phone. The others refuse, which is expected
    // and not worth reporting.
    const candidates = (await scanner.candidates(device.id)).filter((host) => host !== lastKnown);
    const found = await Promise.all(
      candidates.map(async (host): Promise<Located | undefined> => {
        try {
          return { host, status: await transport.probe(targetAt(device, host)) };
        } catch (error) {
          if (error instanceof DeviceError) return undefined;
          throw error;
        }
      }),
    );
    const located = found.find((candidate) => candidate !== undefined);
    if (!located) {
      throw new DeviceError(
        lastKnown === undefined
          ? `${device.id} was not found in the discovery ranges`
          : `${device.id} did not answer at ${lastKnown} and was not found in the discovery ranges`,
        "unreachable",
      );
    }

    addresses.rememberAddress(device.id, located.host, clock());
    log("info", "found the phone at a new address", {
      device: device.id,
      host: located.host,
      ...(lastKnown !== undefined && { previous: lastKnown }),
    });
    return located;
  }
}
