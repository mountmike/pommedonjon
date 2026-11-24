import { Button, Host } from "@expo/ui";
import { Link, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { DeviceCheck } from "@pommedonjon/api-contract";
import { ApiError, checkPhone } from "../../../api/client";
import { describeCheck } from "../../../phones/addPhone";
import { BackupNowButton } from "../../../phones/BackupNowButton";
import { History } from "../../../phones/History";
import { StateDisplay } from "../../../phones/StateDisplay";
import { scheduleSummary } from "../../../phones/settingsWords";
import { useDevice, useSettings } from "../../../phones/useDevices";
import { radius, space, type, useTheme } from "../../../theme/tokens";

/** One phone: its state, "Back up now", and its history day by day. */
export default function PhoneScreen() {
  const theme = useTheme();
  const { id, check } = useLocalSearchParams<{ id: string; check?: string }>();
  // Remounting is the simplest honest "try again": it starts over.
  const [attempt, setAttempt] = useState(0);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Link href="/" asChild>
          <Pressable accessibilityRole="link" style={styles.back}>
            <Text style={[styles.backText, { color: theme.tint }]}>‹ Phones</Text>
          </Pressable>
        </Link>
        <Phone
          key={attempt}
          id={id}
          checkAtOnce={check === "1"}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

type Checking =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "done"; readonly check: DeviceCheck }
  | { readonly status: "failed"; readonly message: string };

/** Has the server look for the phone, and shows what it said. */
function Connection({ id, atOnce }: { id: string; atOnce: boolean }) {
  const theme = useTheme();
  const [checking, setChecking] = useState<Checking>({ status: "idle" });

  async function look() {
    setChecking({ status: "checking" });
    try {
      setChecking({ status: "done", check: await checkPhone(id) });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Something went wrong.";
      setChecking({ status: "failed", message });
    }
  }

  // A phone that has just been added is looked for straight away.
  useEffect(() => {
    if (atOnce) void look();
    // Only when the screen opens: `look` is not something to re-run on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const found = checking.status === "done" ? describeCheck(checking.check) : undefined;
  return (
    <View style={[styles.card, { backgroundColor: theme.surface }]}>
      {found?.lines.map((line) => (
        <View key={line.text} style={styles.checkLine}>
          <Text
            style={[
              styles.checkGlyph,
              { color: line.ok === null ? theme.muted : line.ok ? theme.tone.safe : theme.tone.overdue },
            ]}>
            {line.ok === null ? "–" : line.ok ? "✓" : "×"}
          </Text>
          <Text style={[styles.summary, { color: theme.ink }]}>{line.text}</Text>
        </View>
      ))}
      {found?.detail !== undefined && (
        <Text style={[styles.checkDetail, { color: theme.muted }]}>{found.detail}</Text>
      )}
      {checking.status === "failed" && (
        <Text style={[styles.checkDetail, { color: theme.tone.due }]}>{checking.message}</Text>
      )}
      <Host matchContents style={styles.change}>
        <Button
          label={
            checking.status === "checking"
              ? "Looking…"
              : checking.status === "idle"
                ? "Check this phone"
                : "Check again"
          }
          variant="outlined"
          disabled={checking.status === "checking"}
          onPress={() => void look()}
        />
      </Host>
      <Text style={[styles.checkDetail, { color: theme.muted }]}>
        The server looks for the phone on your network. Nothing appears on the phone.
      </Text>
    </View>
  );
}

function Phone({
  id,
  checkAtOnce,
  onRetry,
}: {
  id: string;
  checkAtOnce: boolean;
  onRetry: () => void;
}) {
  const theme = useTheme();
  const { state, now, refresh } = useDevice(id);
  const settings = useSettings(id).state;

  if (state.status === "loading") {
    return <ActivityIndicator style={styles.centre} color={theme.muted} />;
  }
  if (state.status === "failed") {
    return (
      <View style={styles.centre}>
        <Text style={[styles.message, { color: theme.ink }]}>{state.message}</Text>
        {!state.missing && (
          <Host matchContents>
            <Button label="Try again" onPress={onRetry} />
          </Host>
        )}
      </View>
    );
  }

  const device = state.data;
  return (
    <View style={styles.all}>
      <Text style={[styles.heading, { color: theme.ink }]} accessibilityRole="header">
        {device.name}
      </Text>
      {state.stale && (
        <Text style={[styles.stale, { color: theme.tone.due }]}>
          Can't reach the server. Showing what was last known.
        </Text>
      )}
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <StateDisplay device={device} now={now} />
        <BackupNowButton device={device} onStarted={refresh} />
      </View>
      <Text style={[styles.section, { color: theme.ink }]} accessibilityRole="header">
        Schedule
      </Text>
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        {settings.status === "ready" && (
          <Text style={[styles.summary, { color: theme.ink }]}>
            {scheduleSummary(settings.data)}
          </Text>
        )}
        <Link href={{ pathname: "/phones/[id]/settings", params: { id } }} asChild>
          <Pressable accessibilityRole="link" style={styles.change}>
            <Text style={[styles.changeText, { color: theme.tint }]}>
              Change name and schedule ›
            </Text>
          </Pressable>
        </Link>
      </View>
      <Text style={[styles.section, { color: theme.ink }]} accessibilityRole="header">
        Connection
      </Text>
      <Connection id={id} atOnce={checkAtOnce} />
      <Text style={[styles.section, { color: theme.ink }]} accessibilityRole="header">
        History
      </Text>
      <History runs={device.recentRuns} now={now} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // One centred column, however wide the window (DESIGN.md, "iPhone and web").
  content: {
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
    padding: space.lg,
    gap: space.md,
  },
  back: { alignSelf: "flex-start", paddingVertical: space.xs },
  backText: { fontSize: type.body },
  all: { gap: space.lg },
  heading: { fontSize: type.state, fontWeight: "700" },
  card: { borderRadius: radius.card, padding: space.lg, gap: space.lg },
  section: { fontSize: type.heading, fontWeight: "700", marginTop: space.sm },
  summary: { fontSize: type.body, flex: 1 },
  checkLine: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  checkGlyph: { width: 20, textAlign: "center", fontSize: type.body, fontWeight: "700" },
  checkDetail: { fontSize: type.small },
  change: { alignSelf: "flex-start" },
  changeText: { fontSize: type.body },
  centre: { alignItems: "center", gap: space.md, paddingVertical: space.xxl },
  message: { fontSize: type.body, textAlign: "center" },
  stale: { fontSize: type.secondary },
});
