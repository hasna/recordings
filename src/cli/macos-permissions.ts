import { spawnSync } from "node:child_process";
import { join } from "node:path";

export interface PermissionHelperProcessResult {
  status: number | null;
  error?: Error;
}

export type PermissionHelperRunner = (
  executable: string,
  arguments_: string[],
  options: { stdio: "inherit" },
) => PermissionHelperProcessResult;

export interface PermissionHelperResult {
  exitCode: number;
  errorMessage?: string;
}

const defaultPermissionHelperRunner: PermissionHelperRunner = (
  executable,
  arguments_,
  options,
) => spawnSync(executable, arguments_, options);

export function runMacOSPermissionRequest(
  appPath: string,
  runner: PermissionHelperRunner = defaultPermissionHelperRunner,
): PermissionHelperResult {
  const executable = join(appPath, "Contents", "MacOS", "Recordings");
  const result = runner(
    executable,
    ["--request-permissions", "--open-permission-settings"],
    { stdio: "inherit" },
  );
  return {
    exitCode: result.error ? 1 : (result.status ?? 1),
    errorMessage: result.error?.message,
  };
}
