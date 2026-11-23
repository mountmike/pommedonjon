import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeSidecar } from "../testing/fakeSidecar.js";
import { BackupStore, CopySnapshots, NoSnapshots, snapshotName } from "./BackupStore.js";
import { SidecarBackupVerifier } from "./BackupVerifier.js";

const UDID = "00008140-000A1B2C3D4E001C";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nightstand-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeWorkingCopy(store: BackupStore, content: string) {
  const dir = store.workingDir("mike", UDID);
  await mkdir(path.join(dir, "ab"), { recursive: true });
  await writeFile(path.join(dir, "Manifest.db"), content);
  await writeFile(path.join(dir, "ab", "abcdef"), `payload ${content}`);
}

describe("BackupStore layout", () => {
  it("keeps each device's working copy and snapshots under its own directory", () => {
    const store = new BackupStore("/backups", new NoSnapshots());
    expect(store.workingRoot("mike")).toBe("/backups/mike/working");
    expect(store.workingDir("mike", UDID)).toBe(`/backups/mike/working/${UDID}`);
  });

  it("names snapshots so they sort by time and are safe as directory names", () => {
    expect(snapshotName(new Date("2026-11-24T00:38:50.123Z"))).toBe("2026-11-24T00-38-50Z");
  });
});

describe("CopySnapshots", () => {
  it("copies the working copy to a timestamped snapshot", async () => {
    const store = new BackupStore(root, new CopySnapshots(3));
    await writeWorkingCopy(store, "v1");

    const kept = await store.snapshot("mike", new Date("2026-11-24T00:38:50Z"));

    expect(kept).toBe(path.join(root, "mike", "snapshots", "2026-11-24T00-38-50Z"));
    expect(await readFile(path.join(kept as string, UDID, "Manifest.db"), "utf8")).toBe("v1");
    expect(await readFile(path.join(kept as string, UDID, "ab", "abcdef"), "utf8")).toBe(
      "payload v1",
    );
  });

  it("leaves earlier snapshots intact when the working copy is later overwritten", async () => {
    const store = new BackupStore(root, new CopySnapshots(3));
    await writeWorkingCopy(store, "v1");
    const first = (await store.snapshot("mike", new Date("2026-11-24T00:00:00Z"))) as string;

    // A later run rewrites the working copy, as a failed backup would.
    await writeWorkingCopy(store, "corrupt");

    expect(await readFile(path.join(first, UDID, "Manifest.db"), "utf8")).toBe("v1");
  });

  it("keeps only the newest snapshots", async () => {
    const store = new BackupStore(root, new CopySnapshots(2));
    await writeWorkingCopy(store, "v");
    for (const day of ["21", "22", "23", "24"]) {
      await store.snapshot("mike", new Date(`2026-11-${day}T20:00:00Z`));
    }
    expect((await readdir(path.join(root, "mike", "snapshots"))).sort()).toEqual([
      "2026-11-23T20-00-00Z",
      "2026-11-24T20-00-00Z",
    ]);
  });

  it("clears an interrupted copy and never mistakes it for a snapshot", async () => {
    const store = new BackupStore(root, new CopySnapshots(1));
    await writeWorkingCopy(store, "v1");
    const snapshots = path.join(root, "mike", "snapshots");
    await mkdir(path.join(snapshots, "2026-11-20T20-00-00Z.partial"), { recursive: true });

    await store.snapshot("mike", new Date("2026-11-24T20:00:00Z"));

    expect(await readdir(snapshots)).toEqual(["2026-11-24T20-00-00Z"]);
  });

  it("does not delete directories it did not create when pruning", async () => {
    const store = new BackupStore(root, new CopySnapshots(1));
    await writeWorkingCopy(store, "v1");
    const snapshots = path.join(root, "mike", "snapshots");
    await mkdir(path.join(snapshots, "keep-this-by-hand"), { recursive: true });

    await store.snapshot("mike", new Date("2026-11-23T20:00:00Z"));
    await store.snapshot("mike", new Date("2026-11-24T20:00:00Z"));

    expect((await readdir(snapshots)).sort()).toEqual([
      "2026-11-24T20-00-00Z",
      "keep-this-by-hand",
    ]);
  });

  it("refuses a keep count that would delete every snapshot", () => {
    expect(() => new CopySnapshots(0)).toThrow(RangeError);
  });
});

describe("NoSnapshots", () => {
  it("keeps nothing and says so", async () => {
    const store = new BackupStore(root, new NoSnapshots());
    await writeWorkingCopy(store, "v1");
    expect(await store.snapshot("mike", new Date())).toBeUndefined();
    expect(await readdir(path.join(root, "mike"))).toEqual(["working"]);
  });
});

describe("SidecarBackupVerifier", () => {
  it("passes a complete backup and reports whose it is", async () => {
    const { sidecar, children } = fakeSidecar((child) =>
      child.respond({ ok: true, problems: [], udid: UDID, isEncrypted: true }),
    );
    const result = await new SidecarBackupVerifier(sidecar).verify("/b/working/x");
    expect(result).toEqual({ ok: true, problems: [], udid: UDID, isEncrypted: true });
    expect(children[0]?.args).toEqual([
      "/app/sidecar.py",
      "verify",
      "--backup-dir",
      "/b/working/x",
    ]);
  });

  it("fails a backup whose status says finished but whose manifest is empty", async () => {
    const { sidecar } = fakeSidecar((child) =>
      child.respond(
        {
          ok: false,
          snapshotState: "finished",
          problems: ["Manifest.plist is empty", "Manifest.db is missing"],
        },
        1,
      ),
    );
    const result = await new SidecarBackupVerifier(sidecar).verify("/b");
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["Manifest.plist is empty", "Manifest.db is missing"]);
  });

  it("never reports ok when problems are listed", async () => {
    const { sidecar } = fakeSidecar((child) =>
      child.respond({ ok: true, problems: ["Manifest.db is empty"] }),
    );
    expect((await new SidecarBackupVerifier(sidecar).verify("/b")).ok).toBe(false);
  });

  it("fails closed when verification itself cannot run", async () => {
    const { sidecar } = fakeSidecar((child) => {
      child.stderr.write("python3: not found\n");
      void child.exit(127);
    });
    const result = await new SidecarBackupVerifier(sidecar).verify("/b");
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("verification did not run (exit code 127)");
    expect(result.problems[0]).toContain("python3: not found");
  });
});
