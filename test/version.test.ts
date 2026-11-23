import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeBuild, readBuildInfo } from "../src/version.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "nightstand-version-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function manifest(content: string): Promise<URL> {
  const file = path.join(dir, "package.json");
  await writeFile(file, content);
  return pathToFileURL(file);
}

describe("readBuildInfo", () => {
  it("reads the version from the real package.json by default", () => {
    expect(readBuildInfo({}).version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("takes the version from package.json and the commit from the environment", async () => {
    const url = await manifest('{"name":"nightstand","version":"0.3.1"}');
    expect(readBuildInfo({ NIGHTSTAND_BUILD: "3f2a9c1" }, url)).toEqual({
      version: "0.3.1",
      build: "3f2a9c1",
    });
  });

  it.each([undefined, "", "  "])("has no build when the environment says %j", async (value) => {
    const url = await manifest('{"version":"0.3.1"}');
    const env = value === undefined ? {} : { NIGHTSTAND_BUILD: value };
    expect(readBuildInfo(env, url).build).toBeUndefined();
  });

  it("refuses a package.json with no version rather than reporting a made-up one", async () => {
    await expect(manifest('{"name":"nightstand"}').then((url) => readBuildInfo({}, url))).rejects.toThrow();
  });
});

describe("describeBuild", () => {
  it("shows the version alone for a release build", () => {
    expect(describeBuild({ version: "0.3.1", build: undefined })).toBe("0.3.1");
  });

  it("adds the commit, which is what tells builds between releases apart", () => {
    expect(describeBuild({ version: "0.3.1", build: "3f2a9c1" })).toBe("0.3.1 (build 3f2a9c1)");
  });
});
