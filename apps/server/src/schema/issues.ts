import type { z } from "zod";

/** "devices[0].policy.window" from ["devices", 0, "policy", "window"]. */
export function formatPath(path: readonly PropertyKey[]): string {
  let text = "";
  for (const part of path) {
    if (typeof part === "number") text += `[${part}]`;
    else text += text === "" ? String(part) : `.${String(part)}`;
  }
  return text;
}

/**
 * One line per problem, each naming the full path of the value at fault.
 * Schemas in this project phrase their messages to follow the path, for
 * example "must be at least 10", so a line reads
 * "pollIntervalSeconds must be at least 10".
 */
export function describeIssues(error: z.ZodError): string[] {
  const lines: string[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        lines.push(`${formatPath([...issue.path, key])} is not a recognised setting`);
      }
      continue;
    }
    const where = formatPath(issue.path);
    lines.push(where === "" ? issue.message : `${where} ${issue.message}`);
  }
  return lines;
}
