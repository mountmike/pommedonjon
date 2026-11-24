import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { apiBase, fetchServerInfo, setApiBase } from "./client";

export { tidyServerUrl } from "./serverUrl";

const KEY = "pommedonjon.server";

/**
 * Whether this app has to be told where the server is. The web app never
 * does: the server it came from is the server. The iPhone app does, once.
 */
export const NEEDS_SERVER_ADDRESS = Platform.OS !== "web" && !process.env.EXPO_PUBLIC_API_URL;

/** The server this app was last connected to, loaded once at start-up. */
export async function loadServerUrl(): Promise<string | undefined> {
  if (!NEEDS_SERVER_ADDRESS) return apiBase();
  const saved = (await AsyncStorage.getItem(KEY)) ?? undefined;
  if (saved !== undefined) setApiBase(saved);
  return saved;
}

/**
 * Connect to a server: check that it is one, then remember it. Rejects with
 * the reason if nothing that looks like pommedonjon answers there.
 */
export async function connectTo(url: string): Promise<void> {
  // Asked of the address itself, before anything is changed.
  await fetchServerInfo(url);
  setApiBase(url);
  if (NEEDS_SERVER_ADDRESS) await AsyncStorage.setItem(KEY, url);
}

export async function forgetServer(): Promise<void> {
  setApiBase("");
  if (NEEDS_SERVER_ADDRESS) await AsyncStorage.removeItem(KEY);
}
