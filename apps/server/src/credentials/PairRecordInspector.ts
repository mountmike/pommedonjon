import { z } from "zod";
import type { Sidecar } from "../sidecar/Sidecar.js";

/** Whether a file is a pair record at all, without saying what is in it. */
export interface PairRecordInspector {
  /** Undefined if it looks like a pair record; otherwise what is wrong with it. */
  problemWith(file: string): Promise<string | undefined>;
}

const ReplySchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);

/**
 * Asks the sidecar, because a pair record is a property list, often in
 * Apple's binary form, and Python reads both forms out of the box.
 */
export class SidecarPairRecordInspector implements PairRecordInspector {
  constructor(private readonly sidecar: Pick<Sidecar, "runJson">) {}

  async problemWith(file: string): Promise<string | undefined> {
    const result = await this.sidecar.runJson(["check-pair-record", "--pair-record", file], {
      timeoutMs: 10_000,
    });
    const reply = ReplySchema.safeParse(result.value);
    if (!reply.success) return "it could not be read";
    return reply.data.ok ? undefined : reply.data.message;
  }
}
