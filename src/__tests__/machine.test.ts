import { describe, expect, test } from "bun:test";
import { currentMachineId } from "../lib/machine.js";

describe("currentMachineId", () => {
  test("uses the same host identifier written into native-created recordings", () => {
    expect(currentMachineId({}, "station05.local")).toBe("station05.local");
  });

  test("supports an explicit fleet machine identity override", () => {
    expect(currentMachineId({ HASNA_MACHINE_ID: "station05" }, "station05.local")).toBe("station05");
  });
});
