import { Host } from "@expo/ui";
import type { ComponentProps, ReactNode } from "react";
import { StyleSheet } from "react-native";

/**
 * Where Expo UI's controls live: real SwiftUI controls on the iPhone, plain
 * equivalents on the web (DESIGN.md, "Component kit").
 *
 * Safe areas are the screen's business, not each control's. Left to its
 * default, a host that scrolls under the status bar pads its own contents
 * down by the status bar's height, and the control drifts out of its row.
 */
export function Native({
  fill = false,
  style,
  children,
}: {
  /** Take the row's whole width, so a switch sits at the end of its row. */
  fill?: boolean;
  style?: ComponentProps<typeof Host>["style"];
  children: ReactNode;
}) {
  return (
    <Host
      matchContents={fill ? { vertical: true } : true}
      ignoreSafeArea="all"
      style={[fill && styles.fill, style]}>
      {children}
    </Host>
  );
}

const styles = StyleSheet.create({
  fill: { alignSelf: "stretch" },
});
