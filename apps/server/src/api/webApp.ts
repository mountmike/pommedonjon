import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Beside the server's own code: /app/web in the image. */
const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web", import.meta.url));

/**
 * Where the built web app is, if there is one. `POMMEDONJON_WEB_DIR` names
 * it; otherwise it is looked for beside the server. A directory without an
 * `index.html` is not a web app, and the server then answers the API only.
 */
export function findWebApp(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env["POMMEDONJON_WEB_DIR"] ?? DEFAULT_WEB_DIR;
  return existsSync(path.join(dir, "index.html")) ? dir : undefined;
}
