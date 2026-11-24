import { describe, expect, it } from "vitest";
import { tidyServerUrl } from "../src/api/serverUrl";

describe("tidyServerUrl", () => {
  it.each([
    ["http://192.168.1.10:8377", "http://192.168.1.10:8377"],
    ["192.168.1.10:8377", "http://192.168.1.10:8377"],
    ["  dockyard:8377/ ", "http://dockyard:8377"],
    ["https://backups.example.net/", "https://backups.example.net"],
    ["http://dockyard:8377/phones/mike", "http://dockyard:8377"],
    ["HTTP://Dockyard:8377", "http://dockyard:8377"],
  ])("makes %j into %s", (typed, url) => {
    expect(tidyServerUrl(typed)).toBe(url);
  });

  it.each(["", "   ", "http://", "not an address"])("finds no address in %j", (typed) => {
    expect(tidyServerUrl(typed)).toBeUndefined();
  });
});
