export type LogLevel = "info" | "warning" | "error";

/** One structured log line. */
export type Logger = (
  level: LogLevel,
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

/**
 * One log line as JSON. `time`, `level` and `message` belong to the line
 * itself, so a field with one of those names cannot replace them: a field
 * called `message` is written as `detail`, and the other two are dropped.
 */
export function formatLogLine(
  now: Date,
  level: LogLevel,
  message: string,
  fields?: Readonly<Record<string, unknown>>,
): string {
  const { message: detail, time: _time, level: _level, ...rest } = fields ?? {};
  return JSON.stringify({
    time: now.toISOString(),
    level,
    message,
    ...rest,
    ...(detail !== undefined && { detail }),
  });
}

/** Writes one JSON object per line to stdout, for the container's log. */
export const jsonLogger: Logger = (level, message, fields) => {
  process.stdout.write(`${formatLogLine(new Date(), level, message, fields)}\n`);
};
