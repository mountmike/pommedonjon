import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { loadServerUrl } from "../api/server";
import { appOpened } from "../phones/me";

export default function RootLayout() {
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
    // Coming back to the front counts as opening: someone is holding the phone.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void appOpened();
    });
    return () => {
      stopped = true;
      subscription.remove();
    };
  }, []);

  if (!ready) return null;
  return <Stack screenOptions={{ headerShown: false }} />;
}
