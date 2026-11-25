import { Platform, PlatformColor, useColorScheme, type ColorValue } from "react-native";
import type { Tone } from "../phones/words";

/** The colours of the System theme (DESIGN.md, "Colour"). */
export interface Theme {
  readonly background: ColorValue;
  readonly surface: ColorValue;
  readonly ink: ColorValue;
  readonly muted: ColorValue;
  readonly tint: ColorValue;
  /** The hairline between rows of a list. */
  readonly separator: ColorValue;
  readonly tone: Readonly<Record<Tone, ColorValue>>;
}

/**
 * On the iPhone, the system's own named colours: they follow light and
 * dark and the accessibility settings with nothing for the app to do.
 */
function systemTheme(): Theme {
  return {
    background: PlatformColor("systemGroupedBackground"),
    surface: PlatformColor("secondarySystemGroupedBackground"),
    ink: PlatformColor("label"),
    muted: PlatformColor("secondaryLabel"),
    tint: PlatformColor("systemBlue"),
    separator: PlatformColor("separator"),
    tone: {
      safe: PlatformColor("systemGreen"),
      due: PlatformColor("systemOrange"),
      overdue: PlatformColor("systemRed"),
      busy: PlatformColor("systemBlue"),
      neutral: PlatformColor("secondaryLabel"),
    },
  };
}

/** Everywhere else, values that stand in for them, each checked for contrast. */
const LIGHT: Theme = {
  background: "#F2F2F7",
  surface: "#FFFFFF",
  ink: "#000000",
  muted: "#6C6C70",
  tint: "#0066CC",
  separator: "#C6C6C8",
  tone: { safe: "#1E7B34", due: "#8A4B00", overdue: "#C4281C", busy: "#0066CC", neutral: "#6C6C70" },
};

const DARK: Theme = {
  background: "#000000",
  surface: "#1C1C1E",
  ink: "#FFFFFF",
  muted: "#AEAEB2",
  tint: "#4DA3FF",
  separator: "#38383A",
  tone: { safe: "#30D158", due: "#FF9F0A", overdue: "#FF6961", busy: "#4DA3FF", neutral: "#AEAEB2" },
};

export function useTheme(): Theme {
  const scheme = useColorScheme();
  if (Platform.OS === "ios") return systemTheme();
  return scheme === "dark" ? DARK : LIGHT;
}

/** Multiples of four (DESIGN.md, "Type, space and shape"). */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { card: 12, control: 10 } as const;
export const type = { state: 34, heading: 22, body: 17, secondary: 15, small: 13 } as const;
