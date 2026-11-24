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
  isThisPhone = false,
  onChanged,
}: {
  device: DeviceSummary;
  now: Date;
  /** The phone the app is running on: marked, and listed first. */
  isThisPhone?: boolean;
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
            <View style={styles.names}>
              <Text style={[styles.name, { color: theme.ink }]}>{device.name}</Text>
              {isThisPhone && (
                <Text style={[styles.thisPhone, { color: theme.tint, borderColor: theme.tint }]}>
                  This iPhone
                </Text>
              )}
            </View>
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
  names: { flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 1 },
  name: { fontSize: type.body, fontWeight: "600" },
  thisPhone: {
    fontSize: type.small,
    fontWeight: "600",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: space.sm,
    paddingVertical: 1,
    overflow: "hidden",
  },
  chevron: { fontSize: type.heading, lineHeight: type.heading },
});
