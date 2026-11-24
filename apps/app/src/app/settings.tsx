import { Button, Host } from "@expo/ui";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import type { ServerInfo } from "@pommedonjon/api-contract";
import {
  ApiError,
  fetchServerInfo,
  fetchServerSettings,
  saveServerSettings,
} from "../api/client";
import { parseRanges } from "../phones/addPhone";
import { space, type, useTheme } from "../theme/tokens";
import { Field, Note, Problems, Screen, Section } from "../ui/Screen";

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly info: ServerInfo };

type Saving =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | { readonly status: "failed"; readonly problems: readonly string[] };

/** The server's own settings, and what it is. */
export default function ServerSettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [ranges, setRanges] = useState("");
  const [saving, setSaving] = useState<Saving>({ status: "idle" });

  // Loaded once: this is a form, and must not change under its owner's hands.
  useEffect(() => {
    let stopped = false;
    Promise.all([fetchServerInfo(), fetchServerSettings()]).then(
      ([info, settings]) => {
        if (stopped) return;
        setRanges(settings.discoveryRanges.join(", "));
        setLoaded({ status: "ready", info });
      },
      (error: unknown) => {
        if (stopped) return;
        const message = error instanceof ApiError ? error.message : "Something went wrong.";
        setLoaded({ status: "failed", message });
      },
    );
    return () => {
      stopped = true;
    };
  }, []);

  async function save() {
    setSaving({ status: "saving" });
    try {
      const saved = await saveServerSettings({ discoveryRanges: parseRanges(ranges) });
      setRanges(saved.discoveryRanges.join(", "));
      setSaving({ status: "saved" });
    } catch (error) {
      const known = error instanceof ApiError;
      const why = known ? error.message : "Something went wrong.";
      setSaving({
        status: "failed",
        problems: known && error.problems.length > 0 ? error.problems : [`Couldn't save. ${why}`],
      });
    }
  }

  return (
    <Screen title="Server" back="/" backLabel="Phones">
      {loaded.status === "loading" && <ActivityIndicator color={theme.muted} />}
      {loaded.status === "failed" && (
        <Text style={[styles.body, { color: theme.ink }]}>{loaded.message}</Text>
      )}
      {loaded.status === "ready" && (
        <>
          <Section title="Finding phones">
            <Field
              label="Network range"
              value={ranges}
              onChange={(text) => {
                setRanges(text);
                setSaving({ status: "idle" });
              }}
              placeholder="192.168.1.0/24"
            />
            <Note>
              The part of your network the phones are on, for example 192.168.1.0/24. A phone's
              address changes from time to time, so the server looks through this range for a
              phone that is not where it last was. Separate more than one with commas.
            </Note>
            {saving.status === "failed" && <Problems problems={saving.problems} />}
            <View style={styles.actions}>
              <Host matchContents>
                <Button
                  label={saving.status === "saving" ? "Saving…" : "Save"}
                  disabled={saving.status === "saving"}
                  onPress={() => void save()}
                />
              </Host>
              {saving.status === "saved" && (
                <Text style={[styles.saved, { color: theme.tone.safe }]}>Saved.</Text>
              )}
            </View>
          </Section>

          <Section title="About">
            <Detail label="Version" value={loaded.info.version} />
            <Detail label="Backups are kept in" value={loaded.info.backupRoot} />
            <Detail label="Phones" value={String(loaded.info.phones)} />
            <Note>
              There is no sign-in yet. Anyone who can reach this page can manage the phones, so
              keep it on a network you trust.
            </Note>
          </Section>

          <Host matchContents>
            <Button label="Done" variant="text" onPress={() => router.replace("/")} />
          </Host>
        </>
      )}
    </Screen>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.detail}>
      <Text style={[styles.detailLabel, { color: theme.muted }]}>{label}</Text>
      <Text style={[styles.body, { color: theme.ink }]} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: type.body },
  actions: { flexDirection: "row", alignItems: "center", gap: space.md },
  saved: { fontSize: type.secondary },
  detail: { gap: 2 },
  detailLabel: { fontSize: type.small },
});
