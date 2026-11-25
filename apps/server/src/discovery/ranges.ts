/**
 * The largest range that may be swept: /22, about a thousand addresses. A
 * home network is normally a /24. The cap stops a typo such as /8 from
 * turning into sixteen million connection attempts.
 */
export const SMALLEST_PREFIX = 22;

const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

interface Range {
  readonly base: number;
  readonly prefix: number;
}

function parse(cidr: string): Range | string {
  const match = CIDR.exec(cidr);
  if (!match) return 'must be an IPv4 range like "192.168.1.0/24"';
  const [a, b, c, d, prefix] = match.slice(1).map(Number) as [number, number, number, number, number];
  if ([a, b, c, d].some((octet) => octet > 255)) {
    return 'must be an IPv4 range like "192.168.1.0/24"';
  }
  if (prefix > 32) return "must have a prefix length of 32 or less";
  if (prefix < SMALLEST_PREFIX) {
    return `must be /${SMALLEST_PREFIX} or smaller (at most ${2 ** (32 - SMALLEST_PREFIX)} addresses)`;
  }
  // Unsigned arithmetic throughout: JavaScript's bitwise operators are signed.
  const address = a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
  const size = 2 ** (32 - prefix);
  return { base: address - (address % size), prefix };
}

/** Why a range is not acceptable, or undefined if it is. */
export function rangeProblem(cidr: string): string | undefined {
  const parsed = parse(cidr);
  return typeof parsed === "string" ? parsed : undefined;
}

function format(address: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(address / 2 ** shift) % 256).join(".");
}

/**
 * Every address in a range that a device could have. The network and
 * broadcast addresses are left out, except in a /31 or /32 where there are
 * none.
 */
export function addressesIn(cidr: string): string[] {
  const parsed = parse(cidr);
  if (typeof parsed === "string") throw new RangeError(`${cidr} ${parsed}`);
  const size = 2 ** (32 - parsed.prefix);
  const [first, count] = size <= 2 ? [parsed.base, size] : [parsed.base + 1, size - 2];
  return Array.from({ length: count }, (_, index) => format(first + index));
}
