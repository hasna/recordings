#!/usr/bin/env bun

export * from "./macos-artifact/common";
export * from "./macos-artifact/artifacts";
export * from "./macos-artifact/layout";
export * from "./macos-artifact/archive";
export * from "./macos-artifact/manifest";
export * from "./macos-artifact/app-verification";
export * from "./macos-artifact/release";
export * from "./macos-artifact/journal";
export * from "./macos-artifact/publication-state";
export * from "./macos-artifact/publication";
export * from "./macos-artifact/recovery-capabilities";
export * from "./macos-artifact/recovery-install";
export * from "./macos-artifact/recovery-state";
export * from "./macos-artifact/recovery-journal";
export * from "./macos-artifact/cli";

import { main } from "./macos-artifact/cli";

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
