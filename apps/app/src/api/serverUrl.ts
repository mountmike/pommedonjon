/** Tidy what someone typed into an address: "dockyard:8377 " becomes "http://dockyard:8377". */
export function tidyServerUrl(typed: string): string | undefined {
  const text = typed.trim();
  // Nothing, or a scheme with nothing after it.
  if (text === "" || /^https?:\/*$/i.test(text)) return undefined;
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname === "") return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}
