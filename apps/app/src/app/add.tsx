import { Button, Host } from "@expo/ui";
import * as DocumentPicker from "expo-document-picker";
import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ApiError, addPhone } from "../api/client";
import {
  problemsWithPhone,
  toBase64,
  udidFromFileName,
  type PhoneForm,
} from "../phones/addPhone";
import { space, type, useTheme } from "../theme/tokens";
import { Field, Note, Problems, Screen, Section } from "../ui/Screen";

type Adding =
  | { readonly status: "idle" }
  | { readonly status: "adding" }
  | { readonly status: "failed"; readonly problems: readonly string[] };

/** Add a phone: its pairing, then its name and where to find it. */
export default function AddPhoneScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [form, setForm] = useState<PhoneForm>({ name: "", udid: "", host: "", pairing: undefined });
  const [adding, setAdding] = useState<Adding>({ status: "idle" });

  const change = (part: Partial<PhoneForm>) => {
    setForm((current) => ({ ...current, ...part }));
    setAdding({ status: "idle" });
  };

  async function choose() {
    const picked = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      copyToCacheDirectory: true,
      base64: false,
    });
    const file = picked.assets?.[0];
    if (picked.canceled || !file) return;
    try {
      const bytes = new Uint8Array(await (await fetch(file.uri)).arrayBuffer());
      const found = udidFromFileName(file.name);
      setForm((current) => ({
        ...current,
        pairing: { fileName: file.name, base64: toBase64(bytes) },
        // The file is named after the phone; do not overwrite what was typed.
        udid: current.udid.trim() === "" && found ? found : current.udid,
      }));
      setAdding({ status: "idle" });
    } catch {
      setAdding({ status: "failed", problems: ["That file could not be read."] });
    }
  }

  async function add() {
    const problems = problemsWithPhone(form);
    if (problems.length > 0 || !form.pairing) {
      setAdding({ status: "failed", problems });
      return;
    }
    setAdding({ status: "adding" });
    try {
      const id = await addPhone({
        ...(form.name.trim() !== "" && { name: form.name.trim() }),
        ...(form.udid.trim() !== "" && { udid: form.udid.trim() }),
        ...(form.host.trim() !== "" && { host: form.host.trim() }),
        pairRecord: form.pairing.base64,
      });
      // Straight to the phone, where the server looks for it.
      router.replace({ pathname: "/phones/[id]", params: { id, check: "1" } });
    } catch (error) {
      const known = error instanceof ApiError;
      const why = known ? error.message : "Something went wrong.";
      setAdding({
        status: "failed",
        problems: known && error.problems.length > 0 ? error.problems : [why],
      });
    }
  }

  return (
    <Screen title="Add a phone" back="/" backLabel="Phones">
      <Section title="Pairing">
        <Text style={[styles.body, { color: theme.ink }]}>
          The server talks to a phone using its pairing: the file a computer keeps once the phone
          has trusted it.
        </Text>
        <View style={styles.choose}>
          <Host matchContents>
            <Button
              label={form.pairing ? "Choose another file" : "Choose the pairing file"}
              variant="outlined"
              onPress={() => void choose()}
            />
          </Host>
          {form.pairing && (
            <Text style={[styles.file, { color: theme.muted }]} numberOfLines={1}>
              {form.pairing.fileName}
            </Text>
          )}
        </View>
        <Note>
          The file is sent to your server and kept there, readable by the service alone. It gives
          full access to the phone, so the server never shows it or sends it anywhere.
        </Note>
      </Section>

      <Section title="Phone">
        <Note>
          With the phone at home and awake, the pairing is all the server needs: it finds the
          phone and asks its name and identifier. Fill these in to choose a name, or to add a
          phone that is not at home right now.
        </Note>
        <Field
          label="Name (optional)"
          value={form.name}
          onChange={(name) => change({ name })}
          maxLength={60}
        />
        <Field
          label="Identifier (optional)"
          value={form.udid}
          onChange={(udid) => change({ udid })}
        />
        <Note>
          The phone's identifier (UDID), for example 00008140-000A1B2C3D4E001C. It is filled in
          from the pairing file's name when the file is named after it.
        </Note>
        <Field
          label="Address (optional)"
          value={form.host}
          onChange={(host) => change({ host })}
        />
        <Note>
          Leave empty and the server looks for the phone on your network, which needs a network
          range set under Server. Give an address only if the phone always has the same one.
        </Note>
      </Section>

      {adding.status === "failed" && <Problems problems={adding.problems} />}

      <View style={styles.actions}>
        <Host matchContents>
          <Button
            label={adding.status === "adding" ? "Looking for the phone…" : "Add phone"}
            disabled={adding.status === "adding"}
            onPress={() => void add()}
          />
        </Host>
        <Host matchContents>
          <Button label="Cancel" variant="text" onPress={() => router.dismissTo("/")} />
        </Host>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: type.body },
  choose: { flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" },
  file: { fontSize: type.secondary, flexShrink: 1 },
  actions: { flexDirection: "row", alignItems: "center", gap: space.md },
});
