import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { sliceBetweenUnique } from "./helpers/source-assertions";

const lifecycleSource = readFileSync(
  new URL("./macos-app-lifecycle.test.ts", import.meta.url),
  "utf8",
);

describe("macOS app lifecycle timeout", () => {
  test("the FIFO synchronization deadline uses the configured suite timeout", () => {
    const fifoReader = sliceBetweenUnique(
      lifecycleSource,
      "async function readFifoLine(",
      "\nfunction createApp(",
    );

    expect(lifecycleSource).toContain("setDefaultTimeout(testTimeoutMs);");
    expect(fifoReader).toContain("}, testTimeoutMs);");
    expect(fifoReader).not.toContain("5_000");
  });
});
