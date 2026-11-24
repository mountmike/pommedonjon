import { Button, Host } from "@expo/ui";
import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError, apiBase } from "../api/client";
import { connectTo, tidyServerUrl } from "../api/server";
import { appOpened } from "../phones/me";
import { space, type, useTheme } from "../theme/tokens";
import { Field, Note, Problems, Section } from "../ui/Screen";

type Connecting =
  | { readonly status: "idle" }
  | { readonly status: "connecting" }
  | { readonly status: "failed"; readonly problems: readonly string[] };

/**
 * Where the server is: the iPhone app's first screen, once. The web app
 * never shows it, because the server it came from is the server.
 */
export default function ConnectScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [address, setAddress] = useState(apiBase());
  const [connecting, setConnecting] = useState<Connecting>({ status: "idle" });

  async function connect() {
    const url = tidyServerUrl(address);
    if (url === undefined) {
      setConnecting({ status: "failed", problems: ["That does not look like an address."] });
      return;
    }
    setConnecting({ status: "connecting" });
    try {
      await connectTo(url);
      void appOpened();
      router.replace("/");
    } catch (error) {
      const why = error instanceof ApiError ? error.message : "Something went wrong.";
      setConnecting({
        status: "failed",
        problems: [`No pommedonjon server answered at ${url}. ${why}`],
      });
    }
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <View style={styles.content}>
        <Text style={[styles.heading, { color: theme.ink }]} accessibilityRole="header">
          Connect
        </Text>
        <Section title="Your server">
          <Field
            label="Address"
            value={address}
            onChange={(text) => {
              setAddress(text);
              setConnecting({ status: "idle" });
            }}
            placeholder="http://192.168.1.10:8377"
          />
          <Note>
            The address you open pommedonjon at in a browser. This phone has to be on the same
            network as the server.
          </Note>
        </Section>
        {connecting.status === "failed" && <Problems problems={connecting.problems} />}
        <Host matchContents style={styles.button}>
          <Button
            label={connecting.status === "connecting" ? "Connecting…" : "Connect"}
            disabled={connecting.status === "connecting"}
            onPress={() => void connect()}
          />
        </Host>
      </View>
    </SafeAreaView>
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
  heading: { fontSize: type.state, fontWeight: "700" },
  button: { alignSelf: "flex-start" },
});
