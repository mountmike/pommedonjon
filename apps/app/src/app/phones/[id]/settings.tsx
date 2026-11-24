import { Button, Host, Picker } from "@expo/ui";
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { DeviceSettings } from "@pommedonjon/api-contract";
import { ApiError, fetchSettings, removePhone, saveSettings } from "../../../api/client";
import {
  chargerWaitChoices,
  DEFAULT_CHARGER_WAIT_HOURS,
  DEFAULT_QUIET_HOURS,
  DEFAULT_UNLOCK_WAIT_HOURS,
  howOftenChoices,
  overdueChoices,
  plugInChoices,
  problemsWith,
  timeChoices,
  unlockWaitChoices,
  withChange,
  type Choice,
} from "../../../phones/settingsWords";
import { radius, space, type, useTheme } from "../../../theme/tokens";
import { Note, Problems, Row, Section, Toggle } from "../../../ui/Screen";

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready" };

type Saving =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "failed"; readonly problems: readonly string[] };

type Removing =
  | { readonly status: "idle" }
  /** Asked once; waiting to be told again. */
  | { readonly status: "confirming" }
  | { readonly status: "removing" }
  | { readonly status: "failed"; readonly message: string };

/** A phone's name and schedule, to change and save. */
export default function PhoneSettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [settings, setSettings] = useState<DeviceSettings | undefined>();
  const [saving, setSaving] = useState<Saving>({ status: "idle" });
  const [removing, setRemoving] = useState<Removing>({ status: "idle" });
  const back = { pathname: "/phones/[id]", params: { id } } as const;

  // Loaded once: this is a form, and must not change under its owner's hands.
  useEffect(() => {
    let stopped = false;
    fetchSettings(id).then(
      (found) => {
        if (stopped) return;
        setSettings(found);
        setLoaded({ status: "ready" });
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
  }, [id]);

  const change = (part: Partial<DeviceSettings>) => {
    setSettings((current) => (current ? withChange(current, part) : current));
    setSaving({ status: "idle" });
  };

  async function save(wanted: DeviceSettings) {
    const problems = problemsWith(wanted);
    if (problems.length > 0) {
      setSaving({ status: "failed", problems });
      return;
    }
    setSaving({ status: "saving" });
    try {
      await saveSettings(id, { ...wanted, name: wanted.name.trim() });
      router.replace(back);
    } catch (error) {
      const known = error instanceof ApiError;
      const why = known ? error.message : "Something went wrong.";
      setSaving({
        status: "failed",
        problems: known && error.problems.length > 0 ? error.problems : [`Couldn't save. ${why}`],
      });
    }
  }

  async function remove() {
    setRemoving({ status: "removing" });
    try {
      await removePhone(id);
      router.replace("/");
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Something went wrong.";
      setRemoving({ status: "failed", message });
    }
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Link href={back} asChild>
          <Pressable accessibilityRole="link" style={styles.back}>
            <Text style={[styles.backText, { color: theme.tint }]}>‹ Back</Text>
          </Pressable>
        </Link>
        <Text style={[styles.heading, { color: theme.ink }]} accessibilityRole="header">
          Settings
        </Text>

        {loaded.status === "loading" && (
          <ActivityIndicator style={styles.centre} color={theme.muted} />
        )}
        {loaded.status === "failed" && (
          <Text style={[styles.message, { color: theme.ink }]}>{loaded.message}</Text>
        )}
        {loaded.status === "ready" && settings && (
          <>
            <Section title="Name">
              <TextInput
                value={settings.name}
                onChangeText={(name) => change({ name })}
                accessibilityLabel="Name"
                maxLength={60}
                autoCorrect={false}
                style={[
                  styles.input,
                  { color: theme.ink, borderColor: theme.separator, backgroundColor: theme.background },
                ]}
              />
            </Section>

            <Section title="Schedule">
              <Toggle
                label="Back up automatically"
                value={settings.automatic}
                onChange={(automatic) => change({ automatic })}
              />
              {settings.automatic ? (
                <Row label="Back up">
                  <Choose
                    label="How often to back up"
                    choices={howOftenChoices(settings.dueAfterHours)}
                    value={settings.dueAfterHours}
                    onChange={(dueAfterHours) => change({ dueAfterHours })}
                  />
                </Row>
              ) : (
                <Note>Backups only happen when you press Back up now.</Note>
              )}
            </Section>

            {settings.automatic && (
              <Section title="When a backup may start">
                <Toggle
                  label="When I plug it in at home"
                  value={settings.startWhenPluggedIn}
                  onChange={(startWhenPluggedIn) => change({ startWhenPluggedIn })}
                />
                {settings.startWhenPluggedIn && (
                  <Row label="Within" indented>
                    <Choose
                      label="How long after plugging in"
                      choices={plugInChoices(settings.pluggedInWindowMinutes)}
                      value={settings.pluggedInWindowMinutes}
                      onChange={(pluggedInWindowMinutes) => change({ pluggedInWindowMinutes })}
                    />
                  </Row>
                )}
                <Toggle
                  label="When I unlock it at home"
                  value={settings.startWhenUnlockedAfterHours !== null}
                  onChange={(on) =>
                    change({ startWhenUnlockedAfterHours: on ? DEFAULT_UNLOCK_WAIT_HOURS : null })
                  }
                />
                {settings.startWhenUnlockedAfterHours !== null && (
                  <Row label="Once a backup has waited" indented>
                    <Choose
                      label="How long a backup waits before an unlock starts it"
                      choices={unlockWaitChoices(settings.startWhenUnlockedAfterHours)}
                      value={settings.startWhenUnlockedAfterHours}
                      onChange={(startWhenUnlockedAfterHours) =>
                        change({ startWhenUnlockedAfterHours })
                      }
                    />
                  </Row>
                )}
                <Toggle
                  label="Any time it's on a charger at home"
                  value={settings.startOnChargerAfterHours !== null}
                  onChange={(on) =>
                    change({ startOnChargerAfterHours: on ? DEFAULT_CHARGER_WAIT_HOURS : null })
                  }
                />
                {settings.startOnChargerAfterHours !== null && (
                  <Row label="Once a backup has waited" indented>
                    <Choose
                      label="How long a backup waits before any time on a charger starts it"
                      choices={chargerWaitChoices(settings.startOnChargerAfterHours)}
                      value={settings.startOnChargerAfterHours}
                      onChange={(startOnChargerAfterHours) => change({ startOnChargerAfterHours })}
                    />
                  </Row>
                )}
                <Note>
                  Every backup needs your passcode on the phone, so it starts at moments when
                  you're likely to be holding it. If nobody answers, it waits for the next
                  moment, and stops asking for the day after three.
                </Note>
              </Section>
            )}

            {settings.automatic && (
              <Section title="Quiet hours">
                <Toggle
                  label="No backups during quiet hours"
                  value={settings.quietHours !== null}
                  onChange={(on) => change({ quietHours: on ? { ...DEFAULT_QUIET_HOURS } : null })}
                />
                {settings.quietHours !== null && (
                  <>
                    <Row label="From" indented>
                      <Choose
                        label="Quiet hours start"
                        choices={timeChoices(settings.quietHours.start)}
                        value={settings.quietHours.start}
                        onChange={(start) =>
                          change({ quietHours: { start, end: settings.quietHours?.end ?? start } })
                        }
                      />
                    </Row>
                    <Row label="Until" indented>
                      <Choose
                        label="Quiet hours end"
                        choices={timeChoices(settings.quietHours.end)}
                        value={settings.quietHours.end}
                        onChange={(end) =>
                          change({ quietHours: { start: settings.quietHours?.start ?? end, end } })
                        }
                      />
                    </Row>
                    <Note>By the server's clock. "Back up now" still works in quiet hours.</Note>
                  </>
                )}
              </Section>
            )}

            <Section title="Warning">
              <Row label="Show as overdue after">
                <Choose
                  label="How long without a backup before it is overdue"
                  choices={overdueChoices(settings.staleAfterHours, settings.dueAfterHours)}
                  value={settings.staleAfterHours}
                  onChange={(staleAfterHours) => change({ staleAfterHours })}
                />
              </Row>
            </Section>

            {saving.status === "failed" && <Problems problems={saving.problems} />}

            <View style={styles.actions}>
              <Host matchContents>
                <Button
                  label={saving.status === "saving" ? "Saving…" : "Save"}
                  disabled={saving.status === "saving"}
                  onPress={() => void save(settings)}
                />
              </Host>
              <Host matchContents>
                <Button label="Cancel" variant="text" onPress={() => router.replace(back)} />
              </Host>
            </View>

            <Section title="Remove">
              {removing.status === "confirming" || removing.status === "removing" ? (
                <>
                  <Text style={[styles.confirm, { color: theme.ink }]}>
                    Remove {settings.name}? It will no longer be backed up, and its pairing on the
                    server is destroyed. The backups already made stay on the server.
                  </Text>
                  <View style={styles.actions}>
                    <Host matchContents>
                      <Button
                        label={removing.status === "removing" ? "Removing…" : "Yes, remove it"}
                        disabled={removing.status === "removing"}
                        onPress={() => void remove()}
                      />
                    </Host>
                    <Host matchContents>
                      <Button
                        label="Keep it"
                        variant="text"
                        onPress={() => setRemoving({ status: "idle" })}
                      />
                    </Host>
                  </View>
                </>
              ) : (
                <>
                  <Host matchContents>
                    <Button
                      label="Remove this phone"
                      variant="outlined"
                      onPress={() => setRemoving({ status: "confirming" })}
                    />
                  </Host>
                  {removing.status === "failed" && (
                    <Text style={[styles.problem, { color: theme.tone.overdue }]}>
                      {removing.message}
                    </Text>
                  )}
                </>
              )}
            </Section>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** A picker over a list of choices. */
function Choose<T extends string | number>({
  label,
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <Host matchContents>
      <Picker<T> selectedValue={value} onValueChange={onChange} accessibilityLabel={label}>
        {choices.map((choice) => (
          <Picker.Item key={String(choice.value)} label={choice.label} value={choice.value} />
        ))}
      </Picker>
    </Host>
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
  input: {
    fontSize: type.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.control,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  problem: { fontSize: type.secondary },
  confirm: { fontSize: type.body },
  actions: { flexDirection: "row", alignItems: "center", gap: space.md },
  centre: { paddingVertical: space.xxl },
  message: { fontSize: type.body, textAlign: "center" },
});
