import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DeviceSummary } from "@pommedonjon/api-contract";
import { radius, space, type, useTheme } from "../theme/tokens";
import { BackupNowButton } from "./BackupNowButton";
import { StateDisplay, stateLabel } from "./StateDisplay";

/**
 * One phone on the home screen: its name and state, which lead to its own
 * page, and "Back up now".
 */
export function PhoneCard({
  device,
  now,
  onChanged,
}: {
  device: DeviceSummary;
  now: Date;
  /** Something was asked of the server; look again. */
  onChanged: () => void;
}) {
  const theme = useTheme();

  return (
    <View style={[styles.card, { backgroundColor: theme.surface }]}>
      <Link href={{ pathname: "/phones/[id]", params: { id: device.id } }} asChild>
        <Pressable
          style={styles.open}
          accessibilityRole="link"
          accessibilityLabel={stateLabel(device, now)}
          accessibilityHint="Opens this phone's history">
          <View style={styles.top}>
            <Text style={[styles.name, { color: theme.ink }]}>{device.name}</Text>
            <Text style={[styles.chevron, { color: theme.muted }]}>›</Text>
          </View>
          <StateDisplay device={device} now={now} />
        </Pressable>
      </Link>
      <BackupNowButton device={device} onStarted={onChanged} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.card, padding: space.lg, gap: space.lg },
  open: { gap: space.md },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  name: { fontSize: type.body, fontWeight: "600" },
  chevron: { fontSize: type.heading, lineHeight: type.heading },
});
