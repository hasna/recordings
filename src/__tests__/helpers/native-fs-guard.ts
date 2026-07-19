import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

let compiledAddon: string | undefined;

export function ensureNativeFsGuardAddon(repositoryRoot = resolve(import.meta.dir, "../../..")): string {
  if (compiledAddon) return compiledAddon;
  if (process.platform === "darwin") {
    compiledAddon = join(
      repositoryRoot,
      "scripts",
      "native",
      "prebuilds",
      "darwin-universal",
      "recordings_fs_guard.node",
    );
    return compiledAddon;
  }
  const outputDirectory = join(repositoryRoot, "node_modules", ".cache", "recordings-native-fs-guard");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const output = join(outputDirectory, "recordings_fs_guard.node");
  const result = Bun.spawnSync([
    "/usr/bin/cc",
    "-shared",
    "-fPIC",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-DNAPI_VERSION=9",
    "-DNODE_GYP_MODULE_NAME=recordings_fs_guard",
    "-I",
    join(repositoryRoot, "node_modules", "node-api-headers", "include"),
    join(repositoryRoot, "scripts", "native", "recordings_fs_guard.c"),
    "-o",
    output,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`could not compile native filesystem guard fixture: ${result.stderr}`);
  }
  chmodSync(output, 0o755);
  compiledAddon = output;
  return output;
}
