import { z } from "zod";
import { rangeProblem } from "../discovery/ranges.js";
import { describeIssues } from "../schema/issues.js";
import type { StateStore } from "../state/StateStore.js";

/** An IPv4 range in CIDR form, small enough to sweep. */
const range = z.string({ error: 'must be an IPv4 range like "192.168.1.0/24"' }).transform(
  (value, ctx) => {
    const problem = rangeProblem(value.trim());
    if (problem !== undefined) {
      ctx.issues.push({ code: "custom", message: problem, input: value });
      return z.NEVER;
    }
    return value.trim();
  },
);

/** The settings that belong to the server as a whole, not to one phone. */
export const ServerSettingsSchema = z.strictObject(
  {
    /**
     * The network ranges the phones live on, e.g. ["192.168.1.0/24"]. Swept
     * for the lockdown port when a phone is not where it was last reached.
     */
    discoveryRanges: z.array(range, { error: "must be a list" }).max(8, {
      error: "must be 8 ranges or fewer",
    }),
    /** A sweep is not repeated more often than this. */
    scanIntervalSeconds: z
      .number({ error: "must be a number" })
      .min(30, { error: "must be at least 30" }),
    /** How often each phone is considered for a backup. */
    pollIntervalSeconds: z
      .number({ error: "must be a number" })
      .min(10, { error: "must be at least 10" })
      .max(3600, { error: "must be an hour or less" }),
  },
  { error: "must be an object" },
);
export type ServerSettings = Readonly<z.infer<typeof ServerSettingsSchema>>;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  discoveryRanges: [],
  scanIntervalSeconds: 300,
  pollIntervalSeconds: 120,
};

const KEY = "server";

export type ServerSettingsChange =
  | { readonly ok: true; readonly settings: ServerSettings }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The server's own settings, kept in the database and read live. */
export class ServerSettingsStore {
  readonly #state: Pick<StateStore, "serverSetting" | "saveServerSetting">;
  #current: ServerSettings;

  constructor(state: Pick<StateStore, "serverSetting" | "saveServerSetting">) {
    this.#state = state;
    const saved = state.serverSetting(KEY);
    if (saved === undefined) {
      this.#current = DEFAULT_SERVER_SETTINGS;
      return;
    }
    // Saved by an older version, a setting added since takes its default.
    const parsed = ServerSettingsSchema.safeParse({
      ...DEFAULT_SERVER_SETTINGS,
      ...(typeof saved === "object" && saved !== null ? saved : {}),
    });
    if (!parsed.success) {
      throw new Error(
        "the state database holds server settings this version cannot read: " +
          describeIssues(parsed.error).join("; "),
      );
    }
    this.#current = parsed.data;
  }

  get(): ServerSettings {
    return this.#current;
  }

  /** Replace some of the settings. Nothing is saved unless all of it is acceptable. */
  change(wanted: unknown): ServerSettingsChange {
    if (typeof wanted !== "object" || wanted === null || Array.isArray(wanted)) {
      return { ok: false, problems: ["must be an object"] };
    }
    const parsed = ServerSettingsSchema.safeParse({ ...this.#current, ...wanted });
    if (!parsed.success) return { ok: false, problems: describeIssues(parsed.error) };
    this.#state.saveServerSetting(KEY, parsed.data);
    this.#current = parsed.data;
    return { ok: true, settings: parsed.data };
  }
}
