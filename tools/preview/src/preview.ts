/**
 * Run the server and the web app on this machine, with made-up phones.
 *
 *   pnpm preview    build everything, then serve the app at
 *                   http://localhost:8399 with three phones that do not
 *                   exist: one backed up, one due, one overdue, each with
 *                   some history
 *
 * For looking at the app's screens without a real phone or a real backup.
 * The phones sit at addresses reserved for documentation, so the server
 * never reaches anything; it only ever reports them as away.
 *
 * Everything it writes goes under local/preview, which git ignores, and is
 * made afresh on every start.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PORT = Number(process.env["PORT"] ?? 8399);

// The repository root is three levels up from this file.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SERVER = path.join(ROOT, "apps/server/dist");
const WEB = path.join(ROOT, "apps/app/dist");
const DIR = path.join(ROOT, "local/preview");

/** How a made-up backup ended, and how many hours ago. */
interface PastRun {
  readonly hoursAgo: number;
  /** Why it failed; left out for one that worked. */
  readonly failed?: string;
}

/**
 * Each made-up phone and its history, oldest first. Between them they show
 * every state a phone at home can be in without a backup running.
 */
const PHONES: readonly {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly runs: readonly PastRun[];
}[] = [
  {
    // Backed up two hours ago, after a week of ordinary days.
    id: "mike",
    name: "Mike's iPhone",
    host: "192.0.2.10",
    runs: [
      { hoursAgo: 170 },
      { hoursAgo: 146 },
      { hoursAgo: 122.5, failed: "device-locked" },
      { hoursAgo: 122 },
      { hoursAgo: 98 },
      { hoursAgo: 74 },
      { hoursAgo: 50.2, failed: "unreachable" },
      { hoursAgo: 50 },
      { hoursAgo: 26 },
      { hoursAgo: 2 },
    ],
  },
  {
    // Due, and the last try was cancelled on the phone.
    id: "laurel",
    name: "Laurel's iPhone",
    host: "192.0.2.11",
    runs: [{ hoursAgo: 73 }, { hoursAgo: 49 }, { hoursAgo: 25 }, { hoursAgo: 0.5, failed: "passcode-cancelled" }],
  },
  {
    // Overdue: nothing good for four days.
    id: "spare",
    name: "Spare iPhone",
    host: "192.0.2.12",
    runs: [{ hoursAgo: 124 }, { hoursAgo: 100 }, { hoursAgo: 30, failed: "device-locked" }],
  },
];

/** The part of the server's state store this needs. */
interface Store {
  addDevice(
    device: { id: string; name: string; udid: string; host: string | undefined; port: undefined },
    at: Date,
  ): void;
  startRun(deviceId: string, at: Date): number;
  recordEvent(runId: number, at: Date, event: { type: string }): void;
  finishRun(
    runId: number,
    at: Date,
    result:
      | { outcome: "succeeded"; durationMs: number }
      | { outcome: "failed"; reason: string; message: string },
  ): void;
  close(): void;
}

async function seedState(): Promise<void> {
  const module: unknown = await import(
    pathToFileURL(path.join(SERVER, "state/StateStore.js")).href
  );
  const { StateStore } = module as { StateStore: new (file: string) => Store };
  const store = new StateStore(path.join(DIR, "state/pommedonjon.sqlite"));
  const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);
  PHONES.forEach((phone, index) => {
    // No pairing is put beside them: there is no phone to pair with.
    store.addDevice(
      {
        id: phone.id,
        name: phone.name,
        udid: `00000000-${String(index + 1).padStart(16, "0")}`,
        host: phone.host,
        port: undefined,
      },
      hoursAgo(200 - index),
    );
    for (const past of phone.runs) {
      const finished = hoursAgo(past.hoursAgo);
      // A good backup takes minutes; a refused one is over in a minute.
      const durationMs = past.failed === undefined ? 282_000 : 62_000;
      const started = new Date(finished.getTime() - durationMs);
      const run = store.startRun(phone.id, started);
      // The phone asks for its passcode in every run that reaches it.
      if (past.failed !== "unreachable") {
        store.recordEvent(run, new Date(started.getTime() + 9000), { type: "passcode-required" });
      }
      store.finishRun(
        run,
        finished,
        past.failed === undefined
          ? { outcome: "succeeded", durationMs }
          : { outcome: "failed", reason: past.failed, message: "made up for the preview" },
      );
    }
  });
  store.close();
}

async function main(): Promise<number> {
  for (const [what, file] of [
    ["server", path.join(SERVER, "cli.js")],
    ["web app", path.join(WEB, "index.html")],
  ] as const) {
    if (!existsSync(file)) {
      console.error(`the ${what} is not built (no ${file}); run "pnpm build" first`);
      return 1;
    }
  }

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(path.join(DIR, "state"), { recursive: true });
  mkdirSync(path.join(DIR, "backups"), { recursive: true });
  await seedState();

  console.log(`the app, with made-up phones: http://localhost:${PORT}`);
  const server = spawn(process.execPath, [path.join(SERVER, "cli.js"), "daemon"], {
    stdio: "inherit",
    env: {
      ...process.env,
      POMMEDONJON_STATE_DIR: path.join(DIR, "state"),
      POMMEDONJON_BACKUP_ROOT: path.join(DIR, "backups"),
      POMMEDONJON_PORT: String(PORT),
      POMMEDONJON_WEB_DIR: WEB,
      // Never an earlier version's config file: this is a made-up world.
      POMMEDONJON_CONFIG: "",
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.kill(signal));
  }
  return new Promise((resolve) => {
    server.on("exit", (code) => resolve(code ?? 0));
  });
}

process.exitCode = await main();
