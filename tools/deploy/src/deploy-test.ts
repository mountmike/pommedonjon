/**
 * Deploy the current commit to the test environment.
 *
 *   pnpm deploy:test    push HEAD to the `test` branch, have Komodo build
 *                       and deploy it, and show how each stage went
 *
 * The test stack in Komodo follows the `test` branch and builds from source,
 * so "deploy" means: move that branch here, then ask Komodo to deploy.
 *
 * It does not show the service's own log. Read that on the server, with
 * `docker logs`, or in Komodo.
 *
 * Needs KOMODO_URL, KOMODO_API_KEY and KOMODO_API_SECRET, from the
 * environment or from local/komodo.env (which git ignores).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createKomodoClient,
  describeUpdate,
  parseEnvFile,
  resolveCredentials,
  waitForUpdate,
} from "./komodo.ts";

const STACK = process.env["KOMODO_STACK"] ?? "pommedonjon-test";
const BRANCH = "test";
// The repository root is three levels up from this file.
const ENV_FILE = new URL("../../../local/komodo.env", import.meta.url);

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function main(): Promise<number> {
  const [command = "deploy"] = process.argv.slice(2);
  const file = existsSync(ENV_FILE) ? parseEnvFile(readFileSync(ENV_FILE, "utf8")) : {};
  const komodo = createKomodoClient(resolveCredentials(process.env, file));

  if (command !== "deploy") {
    process.stderr.write(`unknown command "${command}"; the only one is "deploy"\n`);
    return 2;
  }

  const commit = git("rev-parse", "--short", "HEAD");
  if (git("status", "--porcelain") !== "") {
    process.stderr.write(
      `note: uncommitted changes are not deployed; deploying commit ${commit}\n`,
    );
  }
  // The test branch is only a pointer to "what is on test now", so it is
  // moved, not merged into.
  process.stdout.write(`pushing ${commit} to ${BRANCH}\n`);
  git("push", "--force", "origin", `HEAD:refs/heads/${BRANCH}`);

  process.stdout.write(`asking Komodo to deploy ${STACK}\n`);
  const update = await waitForUpdate(komodo, await komodo.deployStack(STACK), { sleep });
  process.stdout.write(`${describeUpdate(update)}\n`);
  if (!update.success) return 1;
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`deploy:test: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
