import { randomBytes } from "node:crypto";
import { DeviceError, type DeviceTransport } from "../transport/DeviceTransport.js";
import type { AddressScanner } from "./DeviceLocator.js";

/** A phone that answered and accepted a pair record. */
export interface FoundPhone {
  readonly udid: string;
  /** What the phone calls itself, e.g. "Mike's iPhone". */
  readonly name: string;
  /** Where it answered. */
  readonly host: string;
}

/**
 * Finds the phone a pair record belongs to, before anything else is known
 * about it: which is how a phone can be added from its pairing alone.
 */
export interface PhoneFinder {
  /**
   * Look at the address given, or through the network ranges if none is.
   * Undefined if no phone there accepted the pair record.
   */
  find(pairRecordPath: string, host?: string): Promise<FoundPhone | undefined>;
}

export function createPhoneFinder(deps: {
  readonly transport: Pick<DeviceTransport, "identify">;
  readonly scanner: AddressScanner;
}): PhoneFinder {
  const { transport, scanner } = deps;
  return {
    async find(pairRecordPath, host) {
      const candidates =
        host !== undefined
          ? [host]
          : scanner.enabled
            ? // A caller of its own, so it is given the sweep whoever else has had it.
              // And afresh: the phone may have been asleep at the last sweep.
              await scanner.candidates(`find:${randomBytes(4).toString("hex")}`, { fresh: true })
            : [];
      // Each candidate is some Apple device. Only the phone this pair record
      // belongs to accepts it; the others refuse, which is expected.
      const found = await Promise.all(
        candidates.map(async (candidate): Promise<FoundPhone | undefined> => {
          try {
            const status = await transport.identify({ host: candidate, pairRecordPath });
            return { udid: status.udid, name: status.name, host: candidate };
          } catch (error) {
            if (error instanceof DeviceError) return undefined;
            throw error;
          }
        }),
      );
      return found.find((phone) => phone !== undefined);
    },
  };
}
