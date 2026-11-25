import { describe, expect, it } from "vitest";
import { thisPhoneFirst } from "../src/phones/me";

const phones = [{ id: "laurel" }, { id: "mike" }, { id: "spare" }];

describe("thisPhoneFirst", () => {
  it("puts the phone the app is on first, and leaves the rest in order", () => {
    expect(thisPhoneFirst(phones, "mike").map((phone) => phone.id)).toEqual([
      "mike",
      "laurel",
      "spare",
    ]);
  });

  it("changes nothing when the app is not on one of the phones", () => {
    expect(thisPhoneFirst(phones, undefined)).toEqual(phones);
    expect(thisPhoneFirst(phones, "someone-else")).toEqual(phones);
  });

  it("leaves the list it was given alone", () => {
    thisPhoneFirst(phones, "spare");
    expect(phones.map((phone) => phone.id)).toEqual(["laurel", "mike", "spare"]);
  });
});
