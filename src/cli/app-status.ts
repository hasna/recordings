import { Command } from "commander";
import { registerEventsCommands } from "@hasna/events/commander";
import chalk from "chalk";
import { spawnSync } from "child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "fs";
import { dirname, join as pathJoin } from "path";
import { fileURLToPath } from "url";
import { loadConfig, ensureDataDir } from "../lib/config.js";
import { countStoreRecordings, getStore } from "../store.js";
import {
  startRecording,
  stopRecording,
  isRecording,
  checkRecordingDeps,
  recordDuration,
} from "../lib/recorder.js";
import {
  transcribeAudio,
  transcribeAudioStream,
  verifyTranscriptionCredential,
  type CredentialProbeResult,
} from "../lib/transcriber.js";
import {
  probeMicrophoneCapture,
  captureProbeSubject,
  microphoneGrantInstruction,
  classifyPermissionState,
  // RECORDINGS_BUNDLE_IDENTIFIER is imported from ./macos-permissions.js below, which is the
  // ruled canonical name. capture-probe.js re-exports the same symbol from lib/macos-bundle.ts;
  // importing it from both is a duplicate identifier, not a second constant.
  DEFAULT_PROBE_SECONDS,
  MAX_PROBE_SECONDS,
  TCC_UNREADABLE_STATE,
  type CaptureProbeResult,
} from "../lib/capture-probe.js";
import {
  describeActiveStore,
  localStoreIsBehindSchema,
  probeRecordingPersistence,
  renderPersistenceMarker,
  type PersistenceProbeResult,
} from "../lib/persistence-probe.js";
import { enhanceText, processText, resolveTranscriberModel } from "../lib/enhancer.js";
import type { Recording, RecordingFilter } from "../types/index.js";
import { VERSION } from "../version.js";
import { applyEnhancementOptions } from "./options.js";
import { removeCodexServerBlock, upsertCodexStdioBlock } from "./mcp-config.js";
import {
  describeTccAuthorizationSubject,
  RECORDINGS_BUNDLE_IDENTIFIER,
  resolveTccGrant,
  runMacOSPermissionRequest,
  type TccGrantDurability,
  type TccGrantReport,
} from "./macos-permissions.js";
// Blocker 3 resolved here: `RECORDINGS_BUNDLE_ID` is deliberately NOT imported from
// `macos-shortcut.js`. It was a second definition of `RECORDINGS_BUNDLE_IDENTIFIER`, which this
// branch could not depend on before because the constant arrives with #24 — importing it then
// would have left the branch uncompilable rather than merely duplicated. That base now exists, so
// the TODO(rebase) is discharged rather than carried.
import {
  DEFAULT_TOGGLE_RECORDING_CHORD,
  ShortcutParseError,
  TOGGLE_RECORDING_DEFAULTS_KEY,
  TRIGGER_DEFAULTS_EXECUTABLE,
  TRIGGER_GRANT_REQUIREMENTS,
  USE_FN_KEY_DEFAULTS_KEY,
  formatShortcut,
  listBindableKeys,
  parseShortcutChord,
  readTriggerState,
  runningAppBundlePaths,
  writeShortcut,
  writeUseFnKey,
} from "./macos-shortcut.js";
import {
  describeTriggerPickup,
  probeTriggerDiagnostics,
  type TriggerDiagnosis,
} from "./trigger-probe.js";
import { currentMachineId } from "../lib/machine.js";
import { recordingCreateIdentity } from "../lib/recording-create-identity.js";
import {
  createInstallerEnvironment,
  resolveInstallBunExecutable,
} from "../lib/bun-runtime.js";
import {
  assertExpectedReleaseHostname,
  assertReleaseOnlyOptions,
  parseLaunchTimeout,
  prepareReleaseInstallInputs,
} from "../lib/release-install-policy.js";

export type MacOSAppStatus = {
  platform: string;
  package_root: string;
  installer_path: string;
  installer_available: boolean;
  native_sources_path: string;
  native_sources_available: boolean;
  installed_app_path: string;
  legacy_install_paths: string[];
  installed: boolean;
  executable_path: string;
  executable: boolean;
  app_code_hash: string | null;
  ad_hoc_signed: boolean;
  signing_identifier: string | null;
  team_identifier: string | null;
  designated_requirement: string | null;
  signature_authorities: string[];
  microphone_permission: string;
  accessibility_permission: string;
  ambiguous_installations: boolean;
  microphone_grant_durability: TccGrantDurability;
  accessibility_grant_durability: TccGrantDurability;
  microphone_stored_requirement: string | null;
  accessibility_stored_requirement: string | null;
  log_path: string;
};

export function getMacOSAppStatus(): MacOSAppStatus {
  const packageRoot = findPackageRoot();
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const canonicalAppPath = pathJoin(home, "Applications", "Recordings.app");
  const legacyInstallPaths = findLegacyMacOSAppPaths(home, canonicalAppPath);
  // Report on the bundle that is actually on disk. Pinning the canonical path meant that on a
  // machine where the app lives anywhere else, every permission answer described a bundle that
  // did not exist — so the grants of the bundle actually holding them were never examined.
  const installedAppPath = resolveInstalledAppPath(home, canonicalAppPath, legacyInstallPaths);
  // A grant belongs to a bundle, so a state can only be reported for one that exists. Passing
  // a path that is not there produced `allowed_identity_unverified` — an "allowed" string for
  // a machine with nothing installed.
  const installedAppPathForGrants = existsSync(installedAppPath) ? installedAppPath : null;
  const executablePath = pathJoin(installedAppPath, "Contents", "MacOS", "Recordings");
  const logPath = pathJoin(home, ".hasna", "recordings", "Recordings.log");
  const installerPath = getMacOSInstallerPath(packageRoot);
  const nativeSourcesPath = pathJoin(packageRoot, "src", "native", "Recordings");
  const signingInfo = getCodeSigningInfo(installedAppPath);
  // Ambiguity is a warning about WHICH bundle answered, not a substitute for the answer.
  // Replacing the permission state with it discarded the one fact the operator needed.
  // It must be flagged whenever more than one bundle exists — especially when the canonical
  // path is absent, which is exactly when the answer comes from a bundle nobody named.
  const ambiguousInstallations =
    [canonicalAppPath, ...legacyInstallPaths].filter((path) => existsSync(path)).length > 1;
  const microphoneGrant = getTccGrant("kTCCServiceMicrophone", home, installedAppPathForGrants);
  const accessibilityGrant = getTccGrant(
    "kTCCServiceAccessibility",
    home,
    installedAppPathForGrants,
  );

  return {
    platform: process.platform,
    package_root: packageRoot,
    installer_path: installerPath,
    installer_available: existsSync(installerPath),
    native_sources_path: nativeSourcesPath,
    native_sources_available: existsSync(pathJoin(nativeSourcesPath, "Package.swift")),
    installed_app_path: installedAppPath,
    legacy_install_paths: legacyInstallPaths,
    installed: existsSync(installedAppPath),
    executable_path: executablePath,
    executable: existsSync(executablePath),
    app_code_hash: signingInfo.cdHash,
    ad_hoc_signed: signingInfo.adHoc,
    signing_identifier: signingInfo.identifier,
    team_identifier: signingInfo.teamIdentifier,
    designated_requirement: signingInfo.designatedRequirement,
    signature_authorities: signingInfo.authorities,
    microphone_permission: microphoneGrant.state,
    accessibility_permission: accessibilityGrant.state,
    ambiguous_installations: ambiguousInstallations,
    microphone_grant_durability: microphoneGrant.durability,
    accessibility_grant_durability: accessibilityGrant.durability,
    microphone_stored_requirement: microphoneGrant.storedRequirement,
    accessibility_stored_requirement: accessibilityGrant.storedRequirement,
    log_path: logPath,
  };
}

/// Every caveat that qualifies a reported permission state, built once so the text output and
/// `--json` cannot drift apart. `--json` consumers previously received none of these.
export function buildPermissionWarnings(status: MacOSAppStatus): string[] {
  const warnings: string[] = [];
  if (status.platform !== "darwin") return warnings;

  if (!status.installed) {
    warnings.push(
      `no app bundle exists at ${status.installed_app_path}, so the states above describe no `
        + "installed code — install the app before trusting them",
    );
  }
  if (status.ambiguous_installations) {
    warnings.push(
      "more than one Recordings.app is installed, so the states above may describe a bundle "
        + `other than the one macOS granted: reporting on ${status.installed_app_path}, also `
        + `present are ${status.legacy_install_paths.join(", ")}`,
    );
  }
  for (const [service, durability] of [
    ["Microphone", status.microphone_grant_durability],
    ["Accessibility", status.accessibility_grant_durability],
  ] as const) {
    if (durability === "dies_on_rebuild_cdhash_pinned") {
      warnings.push(
        `the ${service} grant is pinned to one exact build, so the next rebuild will silently `
          + "revoke it — re-sign with a stable certificate identity to keep it",
      );
    }
  }
  for (const [service, state] of [
    ["Microphone", status.microphone_permission],
    ["Accessibility", status.accessibility_permission],
  ] as const) {
    if (state === "undetermined_tcc_database_unreadable") {
      warnings.push(
        `the TCC database holding the ${service} decision could not be read, so that state is `
          + "unknown rather than ungranted — the usual cause is that this process lacks Full "
          + "Disk Access",
      );
    }
  }
  return warnings;
}

/// Picks the bundle to report on when the canonical install is absent.
///
/// The order is deliberate rather than lexicographic: sorting picked whichever path sorted
/// first, so `/Applications/Recordings.app` could silently answer for a grant held by the
/// bundle in `~/.hasna/recordings`. Preference follows the installer's own policy —
/// `install_macos_app.sh` installs to `$HOME/Applications` and classifies the
/// `~/.hasna/recordings` copy as a duplicate to archive — so a real install location wins over
/// one the installer treats as stale. Callers must still surface `ambiguous_installations`:
/// this returns a defensible choice, not a certainty.
export function resolveInstalledAppPath(
  home: string,
  canonicalPath: string,
  legacyPaths: string[],
): string {
  const preference = [
    canonicalPath,
    pathJoin("/", "Applications", "Recordings.app"),
    pathJoin(home, ".hasna", "recordings", "Recordings.app"),
  ];
  for (const candidate of preference) {
    if (existsSync(candidate)) return candidate;
  }
  return legacyPaths.find((candidate) => existsSync(candidate)) ?? canonicalPath;
}

export function findLegacyMacOSAppPaths(home: string, canonicalPath: string): string[] {
  const candidates = [
    pathJoin(home, ".hasna", "recordings", "Recordings.app"),
    pathJoin("/", "Applications", "Recordings.app"),
  ];
  const userApplications = pathJoin(home, "Applications");
  if (existsSync(userApplications)) {
    for (const entry of readdirSync(userApplications, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("Recordings.app.")) {
        candidates.push(pathJoin(userApplications, entry.name));
      }
    }
  }
  return [...new Set(candidates)]
    .filter((candidate) => candidate !== canonicalPath && existsSync(candidate))
    .sort();
}

export function resetMacOSPermissions(): void {
  const services = ["Microphone", "Accessibility"];
  for (const service of services) {
    // Absolute path: this is the one command here that destroys grants, and `security` on a
    // Hasna station already resolves to a shadowing CLI ahead of /usr/bin. Resolving a
    // grant-destroying tool through PATH is not a risk worth carrying.
    const result = spawnSync(
      "/usr/bin/tccutil",
      ["reset", service, RECORDINGS_BUNDLE_IDENTIFIER],
      { stdio: "inherit" },
    );
    if (result.error) {
      console.error(chalk.red(result.error.message));
      process.exit(1);
    }
  }
}

export function getCodeSigningInfo(appPath: string): {
  cdHash: string | null;
  adHoc: boolean;
  identifier: string | null;
  teamIdentifier: string | null;
  designatedRequirement: string | null;
  authorities: string[];
} {
  if (process.platform !== "darwin" || !existsSync(appPath)) {
    return {
      cdHash: null,
      adHoc: false,
      identifier: null,
      teamIdentifier: null,
      designatedRequirement: null,
      authorities: [],
    };
  }
  const result = spawnSync("/usr/bin/codesign", ["-d", "-r-", "--verbose=4", appPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const cdHash = output.match(/^CDHash=([a-fA-F0-9]+)/m)?.[1]?.toLowerCase() ?? null;
  const adHoc = /Signature=adhoc/.test(output);
  const identifier = output.match(/^Identifier=(.+)$/m)?.[1]?.trim() ?? null;
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
  const designatedRequirement = output.match(/^designated => (.+)$/m)?.[1]?.trim() ?? null;
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1]!.trim());
  return { cdHash, adHoc, identifier, teamIdentifier, designatedRequirement, authorities };
}

/// Reports the authorization state for one TCC service. An `allowed` row is only reported
/// as `allowed` when the grant's stored code requirement still validates against the
/// installed bundle — see `resolveTccPermission`.
///
/// Rebase note (#24 x #25): this branch previously carried its own `getTccPermission()` plus a
/// local `tccAuthValueLabel()`, which returned a flat `"<label>_identity_unverified"` string for
/// every readable row. `macos-permissions.ts` (#24) supersedes both: it verifies the grant's
/// stored code requirement against the installed bundle, so it can distinguish a genuinely
/// verified `allowed` from `allowed_identity_unverified`, and it reads "no such table" as
/// absence rather than refusal. The local copies were deleted rather than kept alongside it —
/// two readers of one TCC database would disagree exactly where verification matters.
export function getTccGrant(service: string, home: string, appPath: string | null): TccGrantReport {
  if (process.platform !== "darwin") {
    return { state: "unsupported", storedRequirement: null, durability: "unknown" };
  }
  return resolveTccGrant({ service, home, appPath });
}

export function findPackageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const packagePath = pathJoin(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (pkg.name === "@hasna/recordings") {
          return current;
        }
      } catch {
        // Keep walking upward.
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
}

export function getMacOSInstallerPath(packageRoot = findPackageRoot()): string {
  return pathJoin(packageRoot, "scripts", "install_macos_app.sh");
}


