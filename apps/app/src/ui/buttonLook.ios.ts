import type { ButtonProps } from "@expo/ui";
import { buttonStyle, tint } from "@expo/ui/swift-ui/modifiers";
import { PlatformColor } from "react-native";

type Look = NonNullable<ButtonProps["modifiers"]>;

/*
 * On the iPhone, Expo UI's "text" variant is SwiftUI's plain style, which
 * draws its label in the text colour, so Cancel looked like a label and not
 * a button. Borderless is the system's own tinted text button.
 */

/** A quiet button, such as Cancel: text in the system's blue. */
export const quietButton: Look = [buttonStyle("borderless")];

/** A button that destroys something, such as Remove: the system's red. */
export const destructiveButton: Look = [tint(PlatformColor("systemRed"))];
