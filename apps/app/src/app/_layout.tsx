import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { apiBase } from "../api/client";
import { loadServerUrl, NEEDS_SERVER_ADDRESS } from "../api/server";
import { appOpened } from "../phones/me";
import { useTheme } from "../theme/tokens";
import { NATIVE_HEADER } from "../ui/Screen";

export default function RootLayout() {
  const theme = useTheme();
  // On the iPhone the server's address is read back from storage first, so
  // no screen asks the server anything before it knows where the server is.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stopped = false;
    void loadServerUrl()
      .catch(() => undefined)
      .then((url) => {
        if (stopped) return;
        setReady(true);
        if (url !== undefined) void appOpened();
      });
    // Coming back to the front counts as opening: someone is holding the
    // phone. Only from the background: pulling down Control Centre also
    // makes the app inactive for a moment, and that is not an opening.
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      const cameBack = state === "active" && previous === "background";
      previous = state;
      // Nothing to tell before the iPhone app knows where the server is.
      const connected = !NEEDS_SERVER_ADDRESS || apiBase() !== "";
      if (cameBack && connected) void appOpened();
    });
    return () => {
      stopped = true;
      subscription.remove();
    };
  }, []);

  if (!ready) return null;
  return (
    <Stack
      screenOptions={{
        // The system's own bar, left as the system draws it: its colours
        // and blur already follow light and dark (DESIGN.md, "Colour").
        headerShown: NATIVE_HEADER,
        headerLargeTitleEnabled: true,
        headerLargeTitleShadowVisible: false,
        contentStyle: { backgroundColor: theme.background },
      }}
    />
  );
}
