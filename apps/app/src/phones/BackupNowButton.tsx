import { Button, Host } from "@expo/ui";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { DeviceSummary } from "@pommedonjon/api-contract";
import { ApiError, requestBackup } from "../api/client";
import { space, type, useTheme } from "../theme/tokens";

type Asking =
  | { readonly status: "idle" }
  | { readonly status: "asking" }
  | { readonly status: "failed"; readonly message: string };

/**
 * Whether "Back up now" is worth offering: not while a backup is running,
 * and not while the phone needs something only its owner can fix.
 */
export function canBackUpNow(device: DeviceSummary): boolean {
  return device.state !== "backing-up" && device.state !== "needs-you";
}

/**
 * The app's one prominent button. It says up front that the phone will ask
 * for its passcode, because a backup never happens with nobody there.
 */
export function BackupNowButton({
  device,
  onStarted,
}: {
  device: DeviceSummary;
  /** Called once the server has taken the request, to show the run at once. */
  onStarted: () => void;
}) {
  const theme = useTheme();
  const [asking, setAsking] = useState<Asking>({ status: "idle" });

  if (!canBackUpNow(device)) return null;

  async function start() {
    setAsking({ status: "asking" });
    try {
      await requestBackup(device.id);
      onStarted();
      setAsking({ status: "idle" });
    } catch (error) {
      const why = error instanceof ApiError ? error.message : "Something went wrong.";
      setAsking({ status: "failed", message: `Couldn't start the backup. ${why}` });
    }
  }

  return (
    <View style={styles.all}>
      <Host matchContents style={styles.button}>
        <Button
          label={asking.status === "asking" ? "Starting…" : "Back up now"}
          disabled={asking.status === "asking"}
          onPress={() => void start()}
        />
      </Host>
      {asking.status === "failed" ? (
        <Text style={[styles.note, { color: theme.tone.overdue }]}>{asking.message}</Text>
      ) : (
        <Text style={[styles.note, { color: theme.muted }]}>
          Have the phone with you: it will ask for your passcode.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  all: { gap: space.sm, alignItems: "flex-start" },
  button: { alignSelf: "flex-start" },
  note: { fontSize: type.small },
});
