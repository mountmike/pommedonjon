import { StyleSheet, Text, View } from "react-native";
import type { DeviceSummary } from "@pommedonjon/api-contract";
import { radius, space, type, useTheme } from "../theme/tokens";
import { describeState } from "./words";

/** One phone on the home screen: its name, its state in words, and what it is waiting for. */
export function PhoneCard({ device, now }: { device: DeviceSummary; now: Date }) {
  const theme = useTheme();
  const words = describeState(device, now);
  const colour = theme.tone[words.tone];

  return (
    <View
      style={[styles.card, { backgroundColor: theme.surface }]}
      accessible
      accessibilityLabel={`${device.name}. ${words.title}. ${words.detail} ${words.next ?? ""}`}>
      <Text style={[styles.name, { color: theme.ink }]}>{device.name}</Text>
      <View style={styles.state}>
        <View style={[styles.badge, { borderColor: colour }]}>
          <Text style={[styles.glyph, { color: colour }]}>{words.glyph}</Text>
        </View>
        <View style={styles.words}>
          <Text style={[styles.title, { color: colour }]}>{words.title}</Text>
          {words.detail !== "" && (
            <Text style={[styles.detail, { color: theme.muted }]}>{words.detail}</Text>
          )}
        </View>
      </View>
      {words.next !== undefined && (
        <Text style={[styles.next, { color: theme.muted }]}>{words.next}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.card, padding: space.lg, gap: space.md },
  name: { fontSize: type.body, fontWeight: "600" },
  state: { flexDirection: "row", alignItems: "center", gap: space.md },
  badge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  glyph: { fontSize: type.heading, fontWeight: "600" },
  words: { flex: 1, gap: 2 },
  title: { fontSize: type.heading, fontWeight: "600" },
  detail: { fontSize: type.secondary },
  next: { fontSize: type.secondary },
});
