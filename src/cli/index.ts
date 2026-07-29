#!/usr/bin/env bun

import { program } from "./command-context.js";
import "./commands-recording.js";
import "./commands-storage.js";
import "./commands-app.js";
import "./commands-check.js";
import "./commands-listen.js";
import "./commands-shortcut.js";
import "./commands-mcp.js";
import "./commands-misc.js";

program.parseAsync().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${msg}`);
  process.exit(1);
});
