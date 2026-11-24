/**
 * Run the server and the web app on this machine, with made-up phones.
 *
 *   pnpm preview    build everything, then serve the app at
 *                   http://localhost:8399 with three phones that do not
 *                   exist: one backed up, one due, one overdue
 *
 * For looking at the app's screens without a real phone or a real backup.
 * The phones sit at addresses reserved for documentation, so the server
 * never reaches anything; it only ever reports them as away.
 *
 * Everything it writes goes under local/preview, which git ignores, and is
 * made afresh on every start.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PORT = Number(process.env["PORT"] ?? 8399);

// The repository root is three levels up from this file.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SERVER = path.join(ROOT, "apps/server/dist");
const WEB = path.join(ROOT, "apps/app/dist");
const DIR = path.join(ROOT, "local/preview");

/** Each made-up phone, and how many hours ago its last good backup ended. */
const PHONES = [
  { id: "mike", name: "Mike's iPhone", host: "192.0.2.10", hoursAgo: 2 },
  { id: "laurel", name: "Laurel's iPhone", host: "192.0.2.11", hoursAgo: 25 },
  { id: "spare", name: "Spare iPhone", host: "192.0.2.12", hoursAgo: 100 },
] as const;

/** The part of the server's state store this needs. */
interface Store {
  startRun(deviceId: string, at: Date): number;
  finishRun(runId: number, at: Date, result: { outcome: "succeeded"; durationMs: number }): void;
  close(): void;
}

function writeConfig(): string {
  const file = path.join(DIR, "pommedonjon.json");
  const config = {
    backupRoot: path.join(DIR, "backups"),
    stateDir: path.join(DIR, "state"),
    api: { port: PORT },
    devices: PHONES.map((phone, index) => ({
      id: phone.id,
      name: phone.name,
      udid: `00000000-${String(index + 1).padStart(16, "0")}`,
      host: phone.host,
      // No such file: there is no pairing, because there is no phone.
      pairRecordPath: path.join(DIR, `no-pairing-${index + 1}`),
    })),
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

async function seedState(): Promise<void> {
  const module: unknown = await import(
    pathToFileURL(path.join(SERVER, "state/StateStore.js")).href
  );
  const { StateStore } = module as { StateStore: new (file: string) => Store };
  const store = new StateStore(path.join(DIR, "state/pommedonjon.sqlite"));
  const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);
  for (const phone of PHONES) {
    const durationMs = 282_000;
    const finished = hoursAgo(phone.hoursAgo);
    const run = store.startRun(phone.id, new Date(finished.getTime() - durationMs));
    store.finishRun(run, finished, { outcome: "succeeded", durationMs });
  }
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
  const config = writeConfig();
  await seedState();

  console.log(`the app, with made-up phones: http://localhost:${PORT}`);
  const server = spawn(
    process.execPath,
    [path.join(SERVER, "cli.js"), "daemon", "--config", config],
    { stdio: "inherit", env: { ...process.env, POMMEDONJON_WEB_DIR: WEB } },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.kill(signal));
  }
  return new Promise((resolve) => {
    server.on("exit", (code) => resolve(code ?? 0));
  });
}

process.exitCode = await main();
