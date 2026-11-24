import { StyleSheet, Text, View } from "react-native";
import type { RunSummary } from "@pommedonjon/api-contract";
import { radius, space, type, useTheme } from "../theme/tokens";
import { groupByDay } from "./runsByDay";
import { describeAttempt } from "./words";

/** A phone's past backups, day by day, most recent first. */
export function History({ runs, now }: { runs: readonly RunSummary[]; now: Date }) {
  const theme = useTheme();
  if (runs.length === 0) {
    return <Text style={[styles.empty, { color: theme.muted }]}>No backups yet.</Text>;
  }

  return (
    <View style={styles.days}>
      {groupByDay(runs, now).map((day) => (
        <View key={day.heading} style={styles.day}>
          <Text style={[styles.heading, { color: theme.muted }]} accessibilityRole="header">
            {day.heading}
          </Text>
          <View style={[styles.rows, { backgroundColor: theme.surface }]}>
            {day.runs.map((run, index) => {
              const words = describeAttempt(run);
              return (
                <View
                  key={run.startedAt}
                  style={[
                    styles.row,
                    index > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: theme.separator,
                    },
                  ]}
                  accessible
                  accessibilityLabel={`${words.title}. ${words.detail}`}>
                  <Text style={[styles.glyph, { color: theme.tone[words.tone] }]}>{words.glyph}</Text>
                  <View style={styles.words}>
                    <Text style={[styles.title, { color: theme.ink }]}>{words.title}</Text>
                    <Text style={[styles.detail, { color: theme.muted }]}>{words.detail}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  days: { gap: space.lg },
  day: { gap: space.sm },
  heading: { fontSize: type.small, fontWeight: "600", textTransform: "uppercase", paddingHorizontal: space.lg },
  rows: { borderRadius: radius.card, paddingHorizontal: space.lg },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md },
  glyph: { width: 24, textAlign: "center", fontSize: type.body, fontWeight: "700" },
  words: { flex: 1, gap: 2 },
  title: { fontSize: type.body },
  detail: { fontSize: type.secondary },
  empty: { fontSize: type.body, paddingHorizontal: space.lg },
});
