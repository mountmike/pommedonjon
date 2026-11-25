import { readFileSync } from "node:fs";
import { z } from "zod";

const ManifestSchema = z.object({ version: z.string().min(1) });

export interface BuildInfo {
  /** The released version this build is, or follows: "0.1.0". */
  readonly version: string;
  /**
   * The commit an image was built from, when the build recorded one. Builds
   * between releases share a version, so this is what tells them apart.
   */
  readonly build: string | undefined;
}

/** package.json sits one level above this file, in the source tree and in the image. */
const MANIFEST = new URL("../package.json", import.meta.url);

export function readBuildInfo(
  env: NodeJS.ProcessEnv = process.env,
  manifest: URL = MANIFEST,
): BuildInfo {
  const { version } = ManifestSchema.parse(JSON.parse(readFileSync(manifest, "utf8")));
  const build = env["POMMEDONJON_BUILD"]?.trim();
  return { version, build: build ? build : undefined };
}

/** "0.1.0" or "0.1.0 (build 3f2a9c1)". */
export function describeBuild(info: BuildInfo): string {
  return info.build === undefined ? info.version : `${info.version} (build ${info.build})`;
}
