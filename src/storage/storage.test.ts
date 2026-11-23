import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeSidecar } from "../testing/fakeSidecar.js";
import { BackupStore } from "./BackupStore.js";
import { SidecarBackupVerifier } from "./BackupVerifier.js";

const UDID = "00008140-000A1B2C3D4E001C";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nightstand-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("BackupStore layout", () => {
  it("gives each phone one directory holding its backup in the standard layout", () => {
    const store = new BackupStore("/backups");
    expect(store.deviceDir("mike")).toBe("/backups/mike");
    expect(store.backupDir("mike", UDID)).toBe(`/backups/mike/${UDID}`);
    expect(store.markerPath("mike")).toBe("/backups/mike/verified.json");
  });
});

describe("BackupStore verified marker", () => {
  it("says nothing is verified before any run", async () => {
    expect(await new BackupStore(root).verified("mike")).toBeUndefined();
  });

  it("records whose backup verified and when", async () => {
    const store = new BackupStore(root);
    await store.beginRun("mike");
    await store.markVerified("mike", UDID, new Date("2026-11-24T08:05:45.059Z"));

    expect(await store.verified("mike")).toEqual({
      udid: UDID,
      verifiedAt: "2026-11-24T08:05:45.059Z",
    });
    // Plain JSON an outside script can read without nightstand.
    expect(JSON.parse(await readFile(path.join(root, "mike", "verified.json"), "utf8"))).toEqual({
      udid: UDID,
      verifiedAt: "2026-11-24T08:05:45.059Z",
    });
  });

  it("withdraws the claim as soon as the next run begins", async () => {
    const store = new BackupStore(root);
    await store.beginRun("mike");
    await store.markVerified("mike", UDID, new Date("2026-11-24T08:05:45Z"));

    await store.beginRun("mike");

    expect(await store.verified("mike")).toBeUndefined();
    expect(await readdir(path.join(root, "mike"))).toEqual([]);
  });

  it("leaves the backup itself alone when a run begins", async () => {
    const store = new BackupStore(root);
    const dir = store.backupDir("mike", UDID);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "Manifest.db"), "v1");

    await store.beginRun("mike");

    expect(await readFile(path.join(dir, "Manifest.db"), "utf8")).toBe("v1");
  });

  it("keeps each phone's marker separate", async () => {
    const store = new BackupStore(root);
    await store.beginRun("mike");
    await store.beginRun("lolo");
    await store.markVerified("mike", UDID, new Date("2026-11-24T08:05:45Z"));

    expect(await store.verified("mike")).toBeDefined();
    expect(await store.verified("lolo")).toBeUndefined();
  });

  it("leaves no partial file behind after writing the marker", async () => {
    const store = new BackupStore(root);
    await store.beginRun("mike");
    await store.markVerified("mike", UDID, new Date("2026-11-24T08:05:45Z"));
    expect(await readdir(path.join(root, "mike"))).toEqual(["verified.json"]);
  });

  it.each(["", "not json", '{"udid":7}', "[]"])(
    "treats a marker it cannot read as not verified: %j",
    async (content) => {
      const store = new BackupStore(root);
      await store.beginRun("mike");
      await writeFile(store.markerPath("mike"), content);
      expect(await store.verified("mike")).toBeUndefined();
    },
  );
});

describe("SidecarBackupVerifier", () => {
  it("passes a complete backup and reports whose it is", async () => {
    const { sidecar, children } = fakeSidecar((child) =>
      child.respond({ ok: true, problems: [], udid: UDID, isEncrypted: true }),
    );
    const result = await new SidecarBackupVerifier(sidecar).verify("/b/mike/x");
    expect(result).toEqual({ ok: true, problems: [], udid: UDID, isEncrypted: true });
    expect(children[0]?.args).toEqual([
      "/app/sidecar.py",
      "verify",
      "--backup-dir",
      "/b/mike/x",
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
