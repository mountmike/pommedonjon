import type { ButtonProps } from "@expo/ui";

type Look = NonNullable<ButtonProps["modifiers"]>;

/*
 * How a button looks beyond its variant. The web's buttons already look
 * right from the variant alone; the iPhone's are in buttonLook.ios.ts.
 */

/** A quiet button, such as Cancel: text in the theme's blue. */
export const quietButton: Look = [];

/** A button that destroys something, such as Remove. */
export const destructiveButton: Look = [];
