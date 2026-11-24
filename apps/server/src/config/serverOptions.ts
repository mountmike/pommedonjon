import path from "node:path";

/**
 * Where things are: the only settings that do not live in the database,
 * because the database is one of the things they locate. Fixed by the
 * image, and changeable through the environment.
 */
export interface ServerOptions {
  /** Where the SQLite database and the pair records are kept. */
  readonly stateDir: string;
  /** Where backups live: one directory per phone underneath. */
  readonly backupRoot: string;
  /**
   * The port the web app and API listen on, or undefined to listen on
   * nothing. There is no sign-in yet, so anything that can reach it can
   * manage the phones: publish it only on a network you trust.
   */
  readonly port: number | undefined;
  readonly sidecar: {
    readonly pythonPath: string | undefined;
    readonly scriptPath: string | undefined;
  };
  /**
   * A config file from before settings were kept in the database. Read
   * once, to bring its phones and settings in; see importConfig.
   */
  readonly legacyConfigFile: string | undefined;
}

export const DEFAULT_PORT = 8377;

export class OptionsError extends Error {
  override readonly name = "OptionsError";
}

function port(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return DEFAULT_PORT;
  if (value.trim().toLowerCase() === "off") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new OptionsError(`POMMEDONJON_PORT must be a port number or "off", not "${value}"`);
  }
  return number;
}

const stated = (value: string | undefined) =>
  value === undefined || value.trim() === "" ? undefined : value;

/** Read the server's options from the environment, with the image's defaults. */
export function readServerOptions(env: NodeJS.ProcessEnv): ServerOptions {
  return {
    stateDir: path.resolve(stated(env["POMMEDONJON_STATE_DIR"]) ?? "/state"),
    backupRoot: path.resolve(stated(env["POMMEDONJON_BACKUP_ROOT"]) ?? "/backups"),
    port: port(env["POMMEDONJON_PORT"]),
    sidecar: {
      pythonPath: stated(env["POMMEDONJON_PYTHON"]),
      scriptPath: stated(env["POMMEDONJON_SIDECAR"]),
    },
    legacyConfigFile: stated(env["POMMEDONJON_CONFIG"]),
  };
}
