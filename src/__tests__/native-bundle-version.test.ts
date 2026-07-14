import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import packageJson from "../../package.json";
import { VERSION } from "../version.js";

describe("native app bundle version", () => {
  test("matches the package and source versions", () => {
    const plist = readFileSync("src/native/Recordings/RecordingsLib/Info.plist", "utf8");
    const valueAfter = (key: string) => {
      const match = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
      return match?.[1];
    };

    expect(VERSION).toBe(packageJson.version);
    expect(valueAfter("CFBundleShortVersionString")).toBe(VERSION);
    expect(valueAfter("CFBundleVersion")).toBe(VERSION);
  });
});
