import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectPairRecord } from "./pairRecord.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "nightstand-secret-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function record(mode: number): Promise<string> {
  const file = path.join(dir, "phone.plist");
  await writeFile(file, "<plist/>");
  await chmod(file, mode);
  return file;
}

describe("inspectPairRecord", () => {
  it.each([0o600, 0o400])("is content with an owner-only file (mode %o)", async (mode) => {
    expect(await inspectPairRecord(await record(mode))).toBeUndefined();
  });

  it.each([
    [0o644, "644"],
    [0o640, "640"],
    [0o604, "604"],
    [0o660, "660"],
  ])("warns when others can read it (mode %o), and says how to fix it", async (mode, shown) => {
    const finding = await inspectPairRecord(await record(mode));
    expect(finding?.level).toBe("warning");
    expect(finding?.problem).toContain(`mode ${shown}`);
    expect(finding?.problem).toContain("chmod 600");
  });

  it("reports a missing file as an error", async () => {
    expect(await inspectPairRecord(path.join(dir, "absent.plist"))).toEqual({
      level: "error",
      problem: `pair record ${path.join(dir, "absent.plist")} does not exist`,
    });
  });

  it("reports a directory where the file should be as an error", async () => {
    // What Docker creates when a bind-mounted file is missing on the host.
    const file = path.join(dir, "phone.plist");
    await mkdir(file);
    expect(await inspectPairRecord(file)).toMatchObject({
      level: "error",
      problem: expect.stringContaining("is not a file"),
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports a file its own user cannot read as an error",
    async () => {
      expect(await inspectPairRecord(await record(0o000))).toMatchObject({
        level: "error",
        problem: expect.stringContaining("cannot be read"),
      });
    },
  );

  it("never includes the file's contents in what it reports", async () => {
    const file = path.join(dir, "phone.plist");
    await writeFile(file, "HostPrivateKey-SECRET");
    await chmod(file, 0o644);
    expect((await inspectPairRecord(file))?.problem).not.toContain("SECRET");
  });
});
