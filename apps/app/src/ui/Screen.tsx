import { Host, Switch } from "@expo/ui";
import { Link, type Href } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { radius, space, type, useTheme } from "../theme/tokens";

/**
 * The frame every screen but the first shares: one centred column, a way
 * back, and a title (DESIGN.md, "iPhone and web").
 */
export function Screen({
  title,
  back,
  backLabel = "Back",
  children,
}: {
  title: string;
  back: Href;
  backLabel?: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Back to the screen that is already there, not a new copy on top. */}
        <Link href={back} dismissTo asChild>
          <Pressable accessibilityRole="link" style={styles.back}>
            <Text style={[styles.backText, { color: theme.tint }]}>‹ {backLabel}</Text>
          </Pressable>
        </Link>
        <Text style={[styles.heading, { color: theme.ink }]} accessibilityRole="header">
          {title}
        </Text>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/** A titled group of settings on a card. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.muted }]} accessibilityRole="header">
        {title}
      </Text>
      <View style={[styles.card, { backgroundColor: theme.surface }]}>{children}</View>
    </View>
  );
}

/** A label with its control beside it. */
export function Row({
  label,
  indented = false,
  children,
}: {
  label: string;
  /** Belongs to the switch above it. */
  indented?: boolean;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.row, indented && styles.indented]}>
      <Text style={[styles.rowLabel, { color: theme.ink }]}>{label}</Text>
      {children}
    </View>
  );
}

/** Small print under a setting, saying what it means. */
export function Note({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[styles.note, { color: theme.muted }]}>{children}</Text>;
}

/** A switch with its label. */
export function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Host matchContents>
      <Switch label={label} value={value} onValueChange={onChange} />
    </Host>
  );
}

/** A line of text to type, with its label above it. */
export function Field({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
}) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.muted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        accessibilityLabel={label}
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        maxLength={maxLength}
        autoCorrect={false}
        autoCapitalize="none"
        style={[
          styles.input,
          { color: theme.ink, borderColor: theme.separator, backgroundColor: theme.background },
        ]}
      />
    </View>
  );
}

/** What is wrong, one line each, where the screen's main button is. */
export function Problems({ problems }: { problems: readonly string[] }) {
  const theme = useTheme();
  return (
    <>
      {problems.map((problem) => (
        <Text key={problem} style={[styles.problem, { color: theme.tone.overdue }]}>
          {problem}
        </Text>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
    padding: space.lg,
    gap: space.lg,
  },
  back: { alignSelf: "flex-start", paddingVertical: space.xs },
  backText: { fontSize: type.body },
  heading: { fontSize: type.state, fontWeight: "700" },
  section: { gap: space.sm },
  sectionTitle: {
    fontSize: type.small,
    fontWeight: "600",
    textTransform: "uppercase",
    paddingHorizontal: space.lg,
  },
  card: { borderRadius: radius.card, padding: space.lg, gap: space.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    flexWrap: "wrap",
  },
  indented: { paddingLeft: space.lg },
  rowLabel: { fontSize: type.body },
  note: { fontSize: type.small },
  field: { gap: space.xs },
  fieldLabel: { fontSize: type.small },
  input: {
    fontSize: type.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.control,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  problem: { fontSize: type.secondary },
});
