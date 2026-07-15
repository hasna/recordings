import { describe, expect, test } from "bun:test";
import {
  runMacOSPermissionRequest,
  type PermissionHelperRunner,
} from "../cli/macos-permissions.js";

describe("macOS permission helper exit relay", () => {
  test("runs the installed app executable directly and relays denied status", () => {
    const invocations: Array<{
      executable: string;
      arguments_: string[];
      options: { stdio: "inherit" };
    }> = [];
    const runner: PermissionHelperRunner = (executable, arguments_, options) => {
      invocations.push({ executable, arguments_, options });
      return { status: 1 };
    };

    const result = runMacOSPermissionRequest("/Applications/Recordings.app", runner);

    expect(result).toEqual({ exitCode: 1, errorMessage: undefined });
    expect(invocations).toEqual([{
      executable: "/Applications/Recordings.app/Contents/MacOS/Recordings",
      arguments_: ["--request-permissions", "--open-permission-settings"],
      options: { stdio: "inherit" },
    }]);
  });

  test("relays a fully granted helper status as success", () => {
    const result = runMacOSPermissionRequest(
      "/Applications/Recordings.app",
      () => ({ status: 0 }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeUndefined();
  });

  test("maps launch errors and missing statuses to failure", () => {
    const failed = runMacOSPermissionRequest(
      "/Applications/Recordings.app",
      () => ({ status: null, error: new Error("launch failed") }),
    );
    const missingStatus = runMacOSPermissionRequest(
      "/Applications/Recordings.app",
      () => ({ status: null }),
    );

    expect(failed).toEqual({ exitCode: 1, errorMessage: "launch failed" });
    expect(missingStatus.exitCode).toBe(1);
  });
});
