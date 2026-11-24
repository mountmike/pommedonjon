/**
 * The few Komodo calls the deploy script needs, over its HTTP API.
 *
 * Runs directly under Node (no build step), so it sticks to syntax Node can
 * strip: no enums, no parameter properties.
 */

export interface KomodoCredentials {
  /** Where Komodo Core answers, e.g. https://komodo.example.ts.net */
  readonly url: string;
  readonly key: string;
  readonly secret: string;
}

export interface UpdateLog {
  readonly stage: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly success: boolean;
}

/** Komodo's record of one action, such as a deploy. */
export interface Update {
  readonly _id?: { readonly $oid?: string };
  readonly status: "Queued" | "InProgress" | "Complete";
  readonly success: boolean;
  readonly logs: readonly UpdateLog[];
}

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const VARIABLES = {
  url: "KOMODO_URL",
  key: "KOMODO_API_KEY",
  secret: "KOMODO_API_SECRET",
} as const;

/** `NAME=value` lines; blank lines and `#` comments ignored; quotes optional. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const name = line.slice(0, equals).trim().replace(/^export\s+/, "");
    let value = line.slice(equals + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

/**
 * Credentials from the environment, falling back to a file of the same
 * names. Throws a message that names what is missing and never echoes a
 * value.
 */
export function resolveCredentials(
  env: Record<string, string | undefined>,
  file: Record<string, string>,
): KomodoCredentials {
  const pick = (name: string) => {
    const value = env[name]?.trim() || file[name]?.trim();
    return value ? value : undefined;
  };
  const found = {
    url: pick(VARIABLES.url),
    key: pick(VARIABLES.key),
    secret: pick(VARIABLES.secret),
  };
  const missing = Object.entries(VARIABLES)
    .filter(([field]) => found[field as keyof typeof found] === undefined)
    .map(([, name]) => name);
  if (missing.length > 0) {
    throw new Error(`missing Komodo settings: ${missing.join(", ")}`);
  }
  return {
    url: (found.url as string).replace(/\/+$/, ""),
    key: found.key as string,
    secret: found.secret as string,
  };
}

export interface KomodoClient {
  deployStack(stack: string): Promise<Update>;
  getUpdate(id: string): Promise<Update>;
}

export function createKomodoClient(
  credentials: KomodoCredentials,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): KomodoClient {
  async function call<Result>(kind: "read" | "execute", type: string, params: object) {
    const response = await fetchFn(`${credentials.url}/${kind}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": credentials.key,
        "x-api-secret": credentials.secret,
      },
      body: JSON.stringify({ type, params }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Komodo ${type} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text) as Result;
  }

  return {
    deployStack: (stack) => call<Update>("execute", "DeployStack", { stack }),
    getUpdate: (id) => call<Update>("read", "GetUpdate", { id }),
  };
}

/**
 * Wait for an action Komodo has accepted to finish. Komodo answers a deploy
 * request at once with a record that is still in progress; the outcome is
 * only on the completed record.
 */
export async function waitForUpdate(
  client: Pick<KomodoClient, "getUpdate">,
  started: Update,
  options: {
    readonly sleep: (ms: number) => Promise<void>;
    readonly intervalMs?: number;
    readonly timeoutMs?: number;
  },
): Promise<Update> {
  const id = started._id?.$oid;
  if (started.status === "Complete" || id === undefined) return started;
  const interval = options.intervalMs ?? 2000;
  const attempts = Math.ceil((options.timeoutMs ?? 15 * 60_000) / interval);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await options.sleep(interval);
    const update = await client.getUpdate(id);
    if (update.status === "Complete") return update;
  }
  throw new Error("timed out waiting for Komodo to finish; check the stack in Komodo");
}

/** The end of a long output, which is where a build or deploy says what went wrong. */
export function tail(text: string, lines: number): string {
  const all = text.trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

/** One update, laid out stage by stage for a terminal. */
export function describeUpdate(update: Update, linesPerStage = 12): string {
  const out: string[] = [];
  for (const log of update.logs) {
    out.push(`${log.success ? "ok  " : "FAIL"} ${log.stage}`);
    const detail = [log.stdout, log.stderr].filter((part) => part.trim() !== "").join("\n");
    // A stage that worked needs no detail; one that failed needs its ending.
    if (!log.success && detail !== "") {
      out.push(...tail(detail, linesPerStage).split("\n").map((line) => `     ${line}`));
    }
  }
  out.push(update.success ? "deployed" : "deploy failed");
  return out.join("\n");
}
