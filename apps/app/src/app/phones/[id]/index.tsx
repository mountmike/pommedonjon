import { Button, Host } from "@expo/ui";
import { Link, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BackupNowButton } from "../../phones/BackupNowButton";
import { History } from "../../phones/History";
import { StateDisplay } from "../../phones/StateDisplay";
import { useDevice } from "../../phones/useDevices";
import { radius, space, type, useTheme } from "../../theme/tokens";

/** One phone: its state, "Back up now", and its history day by day. */
export default function PhoneScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
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
        <Phone key={attempt} id={id} onRetry={() => setAttempt((count) => count + 1)} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Phone({ id, onRetry }: { id: string; onRetry: () => void }) {
  const theme = useTheme();
  const { state, now, refresh } = useDevice(id);

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
  centre: { alignItems: "center", gap: space.md, paddingVertical: space.xxl },
  message: { fontSize: type.body, textAlign: "center" },
  stale: { fontSize: type.secondary },
});
