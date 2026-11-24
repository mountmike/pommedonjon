import { Button, Host } from "@expo/ui";
import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PhoneCard } from "../phones/PhoneCard";
import { useDevices } from "../phones/useDevices";
import { space, type, useTheme } from "../theme/tokens";

/** The home screen: every phone and its state. */
export default function PhonesScreen() {
  const theme = useTheme();
  // Remounting the list is the simplest honest "try again": it starts over.
  const [attempt, setAttempt] = useState(0);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.heading, { color: theme.ink }]} accessibilityRole="header">
          Phones
        </Text>
        <Phones key={attempt} onRetry={() => setAttempt((count) => count + 1)} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Phones({ onRetry }: { onRetry: () => void }) {
  const theme = useTheme();
  const { state, now, refresh } = useDevices();

  if (state.status === "loading") {
    return <ActivityIndicator style={styles.centre} color={theme.muted} />;
  }
  if (state.status === "failed") {
    return (
      <View style={styles.centre}>
        <Text style={[styles.message, { color: theme.ink }]}>{state.message}</Text>
        <Host matchContents>
          <Button label="Try again" onPress={onRetry} />
        </Host>
      </View>
    );
  }
  if (state.data.length === 0) {
    return (
      <Text style={[styles.message, styles.centre, { color: theme.muted }]}>
        No phones have been added yet.
      </Text>
    );
  }
  return (
    <View style={styles.list}>
      {state.stale && (
        <Text style={[styles.stale, { color: theme.tone.due }]}>
          Can't reach the server. Showing what was last known.
        </Text>
      )}
      {state.data.map((device) => (
        <PhoneCard key={device.id} device={device} now={now} onChanged={refresh} />
      ))}
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
    gap: space.lg,
  },
  heading: { fontSize: type.state, fontWeight: "700" },
  list: { gap: space.md },
  centre: { alignItems: "center", gap: space.md, paddingVertical: space.xxl },
  message: { fontSize: type.body, textAlign: "center" },
  stale: { fontSize: type.secondary },
});
