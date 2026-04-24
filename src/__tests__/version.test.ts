import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json";
import { VERSION } from "../version.js";

describe("VERSION", () => {
  test("matches package.json", () => {
    expect(VERSION).toBe(packageJson.version);
  });
});
