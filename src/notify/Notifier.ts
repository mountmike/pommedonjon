export type Notification =
  /**
   * Sent just before a backup starts. The phone's passcode prompt says
   * nothing about why it is asking, so this is the owner's only explanation.
   */
  | {
      readonly kind: "backup-starting";
      readonly deviceId: string;
      readonly deviceName: string;
    }
  | {
      readonly kind: "backup-succeeded";
      readonly deviceId: string;
      readonly deviceName: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "backup-failed";
      readonly deviceId: string;
      readonly deviceName: string;
      readonly reason: string;
      readonly message: string;
    }
  | {
      readonly kind: "backup-stale";
      readonly deviceId: string;
      readonly deviceName: string;
      readonly lastSuccessAt: Date;
    };

/**
 * Tells people what the service is doing. Which channel carries these (push
 * to the phone, email) is deliberately not decided here.
 */
export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

export type LogLevel = "info" | "warning" | "error";

/** One structured log line. */
export type Logger = (
  level: LogLevel,
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

/** Writes one JSON object per line to stdout, for the container's log. */
export const jsonLogger: Logger = (level, message, fields) => {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`,
  );
};

/**
 * Records notifications in the service log and sends them nowhere. A stand-in
 * until a real channel is chosen: with this notifier the owner gets no
 * heads-up on their phone.
 */
export class LogNotifier implements Notifier {
  constructor(private readonly log: Logger) {}

  notify(notification: Notification): Promise<void> {
    const { kind, ...fields } = notification;
    this.log("info", `notification: ${kind}`, fields);
    return Promise.resolve();
  }
}
