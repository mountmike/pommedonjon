import { Button, Host } from "@expo/ui";
import { Link, Redirect } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { apiBase } from "../api/client";
import { NEEDS_SERVER_ADDRESS } from "../api/server";
import { thisPhoneFirst, useThisPhone } from "../phones/me";
import { PhoneCard } from "../phones/PhoneCard";
import { useDevices } from "../phones/useDevices";
import { space, type, useTheme } from "../theme/tokens";

/** The home screen: every phone and its state. */
export default function PhonesScreen() {
  const theme = useTheme();
  // Remounting the list is the simplest honest "try again": it starts over.
  const [attempt, setAttempt] = useState(0);

  // The iPhone app has to be told where the server is before anything else.
  if (NEEDS_SERVER_ADDRESS && apiBase() === "") return <Redirect href="/connect" />;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.heading, { color: theme.ink }]} accessibilityRole="header">
          Phones
        </Text>
        <Phones key={attempt} onRetry={() => setAttempt((count) => count + 1)} />
        <View style={styles.links}>
          <Link href="/add" asChild>
            <Pressable accessibilityRole="link">
              <Text style={[styles.link, { color: theme.tint }]}>Add a phone</Text>
            </Pressable>
          </Link>
          <Link href="/settings" asChild>
            <Pressable accessibilityRole="link">
              <Text style={[styles.link, { color: theme.tint }]}>Server</Text>
            </Pressable>
          </Link>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Phones({ onRetry }: { onRetry: () => void }) {
  const theme = useTheme();
  const { state, now, refresh } = useDevices();
  const thisPhone = useThisPhone();

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
        No phones yet. Add one to start backing it up.
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
      {thisPhoneFirst(state.data, thisPhone).map((device) => (
        <PhoneCard
          key={device.id}
          device={device}
          now={now}
          isThisPhone={device.id === thisPhone}
          onChanged={refresh}
        />
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
  links: { flexDirection: "row", gap: space.xl, paddingHorizontal: space.xs },
  link: { fontSize: type.body },
  list: { gap: space.md },
  centre: { alignItems: "center", gap: space.md, paddingVertical: space.xxl },
  message: { fontSize: type.body, textAlign: "center" },
  stale: { fontSize: type.secondary },
});
