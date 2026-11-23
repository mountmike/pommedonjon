import { describe, expect, it } from "vitest";
import { formatLogLine, LogNotifier, type LogLevel } from "./Notifier.js";

const NOW = new Date("2026-11-24T08:35:09.432Z");

describe("formatLogLine", () => {
  it("writes the time, level and message followed by the fields", () => {
    expect(JSON.parse(formatLogLine(NOW, "info", "backup starting", { device: "mike", runId: 2 }))).toEqual({
      time: "2026-11-24T08:35:09.432Z",
      level: "info",
      message: "backup starting",
      device: "mike",
      runId: 2,
    });
  });

  it("keeps the line's own message when a field is also called message", () => {
    // Seen on the real phone: a failed run logged "TimeoutError" as its
    // message, so the line no longer said that a backup had failed.
    const line = JSON.parse(
      formatLogLine(NOW, "warning", "backup failed", {
        reason: "unreachable",
        message: "TimeoutError",
      }),
    );

    expect(line).toMatchObject({
      message: "backup failed",
      detail: "TimeoutError",
      reason: "unreachable",
    });
  });

  it("does not let fields replace the time or the level", () => {
    const line = JSON.parse(formatLogLine(NOW, "error", "x", { time: "never", level: "info" }));

    expect(line).toEqual({ time: "2026-11-24T08:35:09.432Z", level: "error", message: "x" });
  });

  it("works without fields", () => {
    expect(JSON.parse(formatLogLine(NOW, "info", "idle"))).toEqual({
      time: "2026-11-24T08:35:09.432Z",
      level: "info",
      message: "idle",
    });
  });
});

describe("LogNotifier", () => {
  it("logs a failed backup's reason and message without losing which notification it was", async () => {
    const lines: { level: LogLevel; message: string; fields: unknown }[] = [];
    const notifier = new LogNotifier((level, message, fields) => {
      lines.push({ level, message, fields });
    });

    await notifier.notify({
      kind: "backup-failed",
      deviceId: "mike",
      deviceName: "Mike's iPhone",
      reason: "unreachable",
      message: "TimeoutError",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe("notification: backup-failed");
    expect(lines[0]?.fields).toMatchObject({ reason: "unreachable", message: "TimeoutError" });
  });
});
