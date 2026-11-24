import { describe, expect, it } from "vitest";
import {
  createKomodoClient,
  describeUpdate,
  parseEnvFile,
  resolveCredentials,
  tail,
  waitForUpdate,
  type FetchFn,
  type Update,
} from "../../scripts/komodo.ts";

const creds = { url: "https://komodo.example.ts.net", key: "K", secret: "S" };

function update(overrides: Partial<Update> = {}): Update {
  return { _id: { $oid: "u1" }, status: "Complete", success: true, logs: [], ...overrides };
}

describe("parseEnvFile", () => {
  it("reads NAME=value lines, ignoring blanks and comments", () => {
    expect(
      parseEnvFile(
        ["# Komodo", "", "KOMODO_URL=https://komodo.example.ts.net", "KOMODO_API_KEY = abc "].join("\n"),
      ),
    ).toEqual({ KOMODO_URL: "https://komodo.example.ts.net", KOMODO_API_KEY: "abc" });
  });

  it("accepts quoted values and a leading export", () => {
    expect(parseEnvFile(`export KOMODO_API_SECRET="s3=cr3t"\nKOMODO_API_KEY='k'`)).toEqual({
      KOMODO_API_SECRET: "s3=cr3t",
      KOMODO_API_KEY: "k",
    });
  });

  it("skips lines that are not assignments", () => {
    expect(parseEnvFile("nonsense\n=novalue\nA=1")).toEqual({ A: "1" });
  });
});

describe("resolveCredentials", () => {
  const file = { KOMODO_URL: "https://file/", KOMODO_API_KEY: "fk", KOMODO_API_SECRET: "fs" };

  it("prefers the environment over the file, setting by setting", () => {
    expect(resolveCredentials({ KOMODO_API_KEY: "ek" }, file)).toEqual({
      url: "https://file",
      key: "ek",
      secret: "fs",
    });
  });

  it("drops trailing slashes from the address", () => {
    expect(resolveCredentials({ KOMODO_URL: "https://k.example//" }, file).url).toBe(
      "https://k.example",
    );
  });

  it("names every missing setting and never prints a value", () => {
    expect(() => resolveCredentials({ KOMODO_API_KEY: "top-secret", KOMODO_URL: " " }, {})).toThrow(
      "missing Komodo settings: KOMODO_URL, KOMODO_API_SECRET",
    );
    try {
      resolveCredentials({ KOMODO_API_KEY: "top-secret" }, {});
    } catch (error) {
      expect((error as Error).message).not.toContain("top-secret");
    }
  });
});

describe("createKomodoClient", () => {
  function recorder(reply: object, status = 200) {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetchFn: FetchFn = (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(reply)),
      });
    };
    return { calls, fetchFn };
  }

  it("asks Komodo to deploy a stack, authenticating with the key and secret", async () => {
    const { calls, fetchFn } = recorder(update({ status: "InProgress" }));
    const started = await createKomodoClient(creds, fetchFn).deployStack("pommedonjon-test");

    expect(started.status).toBe("InProgress");
    expect(calls).toEqual([
      {
        url: "https://komodo.example.ts.net/execute",
        headers: { "content-type": "application/json", "x-api-key": "K", "x-api-secret": "S" },
        body: { type: "DeployStack", params: { stack: "pommedonjon-test" } },
      },
    ]);
  });

  it("reads an update through the read endpoint", async () => {
    const { calls, fetchFn } = recorder({ id: "u1" });
    const client = createKomodoClient(creds, fetchFn);
    await client.getUpdate("u1");

    expect(calls.map((call) => [call.url, call.body])).toEqual([
      ["https://komodo.example.ts.net/read", { type: "GetUpdate", params: { id: "u1" } }],
    ]);
  });

  it("reports a refusal with its status and what Komodo said, not the credentials", async () => {
    const { fetchFn } = recorder({ error: "invalid api key" }, 401);
    const attempt = createKomodoClient(creds, fetchFn).deployStack("pommedonjon-test");
    await expect(attempt).rejects.toThrow("Komodo DeployStack failed with HTTP 401");
    await expect(attempt).rejects.toThrow("invalid api key");
  });
});

describe("waitForUpdate", () => {
  it("polls until Komodo marks the action complete", async () => {
    const replies = [
      update({ status: "InProgress" }),
      update({ status: "InProgress" }),
      update({ status: "Complete", success: true }),
    ];
    const slept: number[] = [];
    const finished = await waitForUpdate(
      { getUpdate: () => Promise.resolve(replies.shift() as Update) },
      update({ status: "Queued" }),
      { sleep: (ms) => Promise.resolve(void slept.push(ms)), intervalMs: 2000 },
    );

    expect(finished.status).toBe("Complete");
    expect(slept).toEqual([2000, 2000, 2000]);
  });

  it("returns at once when the action was already complete", async () => {
    const done = update({ status: "Complete" });
    const finished = await waitForUpdate(
      { getUpdate: () => Promise.reject(new Error("should not be called")) },
      done,
      { sleep: () => Promise.resolve() },
    );
    expect(finished).toBe(done);
  });

  it("gives up after the time limit instead of waiting for ever", async () => {
    await expect(
      waitForUpdate(
        { getUpdate: () => Promise.resolve(update({ status: "InProgress" })) },
        update({ status: "InProgress" }),
        { sleep: () => Promise.resolve(), intervalMs: 1000, timeoutMs: 3000 },
      ),
    ).rejects.toThrow("timed out waiting for Komodo");
  });
});

describe("describeUpdate", () => {
  it("lists the stages of a deploy that worked, without their output", () => {
    expect(
      describeUpdate(
        update({
          logs: [
            { stage: "Clone Repo", stdout: "lots of output", stderr: "", success: true },
            { stage: "Compose Up", stdout: "more", stderr: "", success: true },
          ],
        }),
      ),
    ).toBe("ok   Clone Repo\nok   Compose Up\ndeployed");
  });

  it("shows the end of the output of the stage that failed", () => {
    const stderr = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const text = describeUpdate(
      update({
        success: false,
        logs: [
          { stage: "Clone Repo", stdout: "", stderr: "", success: true },
          { stage: "Compose Up", stdout: "", stderr, success: false },
        ],
      }),
      3,
    );
    expect(text).toBe(
      ["ok   Clone Repo", "FAIL Compose Up", "     line 28", "     line 29", "     line 30", "deploy failed"].join(
        "\n",
      ),
    );
  });
});

describe("tail", () => {
  it("keeps the last lines and ignores trailing blank space", () => {
    expect(tail("a\nb\nc\n\n", 2)).toBe("b\nc");
    expect(tail("only", 5)).toBe("only");
  });
});
