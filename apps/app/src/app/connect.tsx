import { Button } from "@expo/ui";
import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet } from "react-native";
import { ApiError, apiBase } from "../api/client";
import { connectTo, tidyServerUrl } from "../api/server";
import { appOpened } from "../phones/me";
import { Native } from "../ui/Native";
import { Field, Note, Problems, Screen, Section } from "../ui/Screen";

type Connecting =
  | { readonly status: "idle" }
  | { readonly status: "connecting" }
  | { readonly status: "failed"; readonly problems: readonly string[] };

/**
 * Where the server is: the iPhone app's first screen, once. The web app
 * never shows it, because the server it came from is the server.
 */
export default function ConnectScreen() {
  const router = useRouter();
  const [address, setAddress] = useState(apiBase());
  const [connecting, setConnecting] = useState<Connecting>({ status: "idle" });

  async function connect(typed: string = address) {
    const url = tidyServerUrl(typed);
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
    <Screen title="Connect">
      <Section title="Your server">
        <Field
          label="Address"
          value={address}
          onChange={(text) => {
            setAddress(text);
            setConnecting({ status: "idle" });
          }}
          placeholder="http://192.168.1.10:8377"
          keyboardType="url"
          onSubmit={(typed) => void connect(typed)}
        />
        <Note>
          The address you open pommedonjon at in a browser. This phone has to be on the same
          network as the server.
        </Note>
      </Section>
      {connecting.status === "failed" && <Problems problems={connecting.problems} />}
      <Native style={styles.button}>
        <Button
          label={connecting.status === "connecting" ? "Connecting…" : "Connect"}
          disabled={connecting.status === "connecting"}
          onPress={() => void connect()}
        />
      </Native>
    </Screen>
  );
}

const styles = StyleSheet.create({
  button: { alignSelf: "flex-start" },
});
