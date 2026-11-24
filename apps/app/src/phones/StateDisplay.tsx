import { StyleSheet, Text, View } from "react-native";
import type { DeviceSummary } from "@pommedonjon/api-contract";
import { space, type, useTheme } from "../theme/tokens";
import { describeState, lastTryWords } from "./words";

/**
 * A phone's state in words, with what it is waiting for and how its last
 * try went if that needs saying. Shared by the home screen and the phone's
 * own page.
 */
export function StateDisplay({ device, now }: { device: DeviceSummary; now: Date }) {
  const theme = useTheme();
  const words = describeState(device, now);
  const lastTry = lastTryWords(device, now);
  const colour = theme.tone[words.tone];

  return (
    <View style={styles.all}>
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
      {lastTry !== undefined && (
        <Text style={[styles.line, { color: theme.tone.due }]}>{lastTry}</Text>
      )}
      {words.next !== undefined && (
        <Text style={[styles.line, { color: theme.muted }]}>{words.next}</Text>
      )}
    </View>
  );
}

/** The same, as one sentence for a screen reader. */
export function stateLabel(device: DeviceSummary, now: Date): string {
  const words = describeState(device, now);
  return [device.name, words.title, words.detail, lastTryWords(device, now), words.next]
    .filter((part) => part !== undefined && part !== "")
    .join(". ");
}

const styles = StyleSheet.create({
  all: { gap: space.md },
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
  line: { fontSize: type.secondary },
});
