import type { DeviceCheck } from "@pommedonjon/api-contract";

const UDID = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9a-f]{40}/;

/**
 * A phone's identifier, from the name of its pairing file: computers name
 * the file after the phone, e.g. "00008140-000A1B2C3D4E001C.plist".
 */
export function udidFromFileName(fileName: string): string | undefined {
  return UDID.exec(fileName)?.[0];
}

export function looksLikeUdid(text: string): boolean {
  return new RegExp(`^(?:${UDID.source})$`).test(text.trim());
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Bytes as base64. Written out because not every runtime the app meets has one. */
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    text += ALPHABET[a >> 2];
    text += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    text += b === undefined ? "=" : ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    text += c === undefined ? "=" : ALPHABET[c & 0x3f];
  }
  return text;
}

/** What has been filled in on the "Add a phone" screen. */
export interface PhoneForm {
  readonly name: string;
  readonly udid: string;
  readonly host: string;
  /** The chosen pairing file, once one has been. */
  readonly pairing: { readonly fileName: string; readonly base64: string } | undefined;
}

/** What is still missing or wrong, before the server is asked. */
export function problemsWithPhone(form: PhoneForm): string[] {
  const problems: string[] = [];
  if (!form.pairing) problems.push("Choose the phone's pairing file.");
  // A name and an identifier left empty are asked of the phone itself.
  if (form.udid.trim() !== "" && !looksLikeUdid(form.udid)) {
    problems.push("That does not look like a phone's identifier.");
  }
  return problems;
}

/** One line of what a check found. `ok` is null where nothing could be said. */
export interface CheckLine {
  readonly ok: boolean | null;
  readonly text: string;
}

/** What the server found when it looked for a phone, as a short checklist. */
export function describeCheck(check: DeviceCheck): { lines: CheckLine[]; detail: string | undefined } {
  const lines: CheckLine[] = [
    check.reachable
      ? { ok: true, text: "At home: the phone answered." }
      : {
          ok: false,
          text:
            check.problem === "probe-failed"
              ? "Couldn't check on the phone."
              : "Not answering. It may be out, or asleep and slow to wake: try again.",
        },
  ];
  if (check.problem === "wrong-phone") {
    lines.push({ ok: false, text: "A different phone answered: the identifier does not match." });
  } else if (check.paired !== null) {
    lines.push(
      check.paired
        ? { ok: true, text: "Pairing accepted." }
        : { ok: false, text: "The phone refused its pairing. It needs pairing again." },
    );
  } else {
    lines.push({ ok: null, text: "Pairing: not known until the phone answers." });
  }
  if (check.encryptionOn !== null) {
    lines.push(
      check.encryptionOn
        ? { ok: true, text: "Backup encryption is on." }
        : { ok: false, text: "Backup encryption is off. Backups will not start until it is on." },
    );
  } else {
    lines.push({ ok: null, text: "Backup encryption: not known until the phone answers." });
  }

  const about = [
    check.model,
    check.osVersion === null ? null : `iOS ${check.osVersion}`,
    check.batteryPercent === null ? null : `battery ${Math.round(check.batteryPercent)}%`,
    check.onCharger === null ? null : check.onCharger ? "on a charger" : "on battery",
    check.locked === null ? null : check.locked ? "locked" : "unlocked",
  ].filter((part): part is string => part !== null);
  return { lines, detail: about.length > 0 ? about.join(", ") : undefined };
}

/** "192.168.1.0/24, 10.0.0.0/24" as a list, and back. */
export function parseRanges(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((range) => range.trim())
    .filter((range) => range !== "");
}
