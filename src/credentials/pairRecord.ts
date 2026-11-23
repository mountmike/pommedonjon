import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

export interface SecretFinding {
  /** "error": the phone cannot be backed up. "warning": it can, but the secret is exposed. */
  readonly level: "error" | "warning";
  readonly problem: string;
}

/**
 * Check one pair record file the way an SSH client checks a private key.
 *
 * A pair record grants full access to a phone, with no passcode, for as long
 * as the pairing lasts. It should be readable by the user nightstand runs as
 * and by nobody else.
 */
export async function inspectPairRecord(file: string): Promise<SecretFinding | undefined> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return { level: "error", problem: `pair record ${file} does not exist` };
  }
  if (!info.isFile()) {
    return { level: "error", problem: `pair record ${file} is not a file` };
  }
  try {
    await access(file, constants.R_OK);
  } catch {
    return {
      level: "error",
      problem: `pair record ${file} cannot be read by the user nightstand runs as`,
    };
  }
  const others = info.mode & 0o077;
  if (others !== 0) {
    const mode = (info.mode & 0o777).toString(8).padStart(3, "0");
    return {
      level: "warning",
      problem:
        `pair record ${file} can be read by other users (mode ${mode}). It grants full ` +
        "access to the phone: make it readable by its owner only (chmod 600 on the host)",
    };
  }
  return undefined;
}
