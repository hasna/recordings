import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareUnsignedUtf8 } from "../../scripts/macos_artifact";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("native privileged updater broker contract", () => {
  test("matches unsigned UTF-8 ordering for cross-runtime canonical material", () => {
    const astral = "\u{10000}";
    const privateUse = "\u{e000}";
    const decomposed = "e\u{301}";
    const precomposed = "\u{e9}";
    const values = [astral, precomposed, privateUse, "z", decomposed, "a"];
    const expected = ["a", decomposed, "z", precomposed, privateUse, astral];

    expect([...values].sort(compareUnsignedUtf8)).toEqual(expected);
    // JavaScript's native UTF-16 ordering puts the astral scalar before the
    // private-use scalar, proving this vector distinguishes the runtimes.
    expect([...values].sort()).not.toEqual(expected);

    const validation = source("src/native/Recordings/Updater/Broker/CodeValidation.swift");
    expect(validation).toContain("enum CanonicalReleaseOrder");
    expect(validation).toContain("left.utf8.lexicographicallyPrecedes(right.utf8)");
    expect(validation).toContain("return CanonicalReleaseOrder.sorted(actual)");
    expect(validation).toContain("CanonicalReleaseOrder.sorted(children)");
    expect(validation).not.toContain("return actual.sorted()");
    expect(validation).not.toContain("contentsOfDirectory(atPath: path).sorted()");

    const swiftTest = source(
      "src/native/Recordings/Updater/BrokerTests/CanonicalReleaseOrderTests.swift",
    );
    for (const scalar of ["\\u{10000}", "\\u{e000}", "e\\u{301}", "\\u{e9}"]) {
      expect(swiftTest).toContain(scalar);
    }
    expect(swiftTest).toContain(
      "CanonicalReleaseOrder.sorted(values) == expected",
    );

    const readme = source("README.md");
    expect(readme).toContain("root:wheel` `/Applications` directory with mode");
    expect(readme).toContain("`root:admin` mode `0775`");
    expect(readme).toContain("force fail-closed recovery or another availability loss");
    expect(readme).toContain("does not authorize an update or bypass");
  });

  test("admits only audit-token-authenticated signed XPC peers and no path options", () => {
    const peer = source("src/native/Recordings/Updater/Broker/PeerIdentity.swift");
    const protocol = source("src/native/Recordings/Updater/Protocol/UpdateProtocol.swift");
    expect(peer).toContain("connection.auditToken");
    expect(peer).toContain("kSecGuestAttributeAudit");
    expect(peer).toContain("SecCodeCheckValidity");
    expect(protocol).toContain("File descriptors, not paths");
    expect(protocol).not.toContain("options: NSDictionary");
    expect(protocol).toContain("setClasses");
  });

  test("binds a canonical signed envelope to all release components and monotonic policy", () => {
    const envelope = source("src/native/Recordings/Updater/Protocol/ReleaseEnvelope.swift");
    const packageManifest = source("src/native/Recordings/Package.swift");
    const envelopeTests = source(
      "src/native/Recordings/Updater/ProtocolTests/ReleaseEnvelopeValidationTests.swift",
    );
    for (const field of [
      "keyEpoch", "releaseSequence", "artifactByteCount", "manifestByteCount",
      "candidateTreeSHA256", "packageSHA256", "updateClientSHA256",
      "updateBrokerSHA256", "artifactVerifierSHA256", "bootstrapMarkerSHA256",
      "installerCertificateSHA256", "architectures", "minimumOSVersion",
      "expiresAtUTC",
    ]) expect(envelope).toContain(field);
    expect(envelope).toContain(".sortedKeys");
    expect(envelope).toContain("Curve25519.Signing.PublicKey");
    expect(envelope).toContain('#"^[0-9]+(?:\\.[0-9]+){0,2}$"#');
    expect(packageManifest).toContain('name: "RecordingsUpdateProtocolTests"');
    expect(packageManifest).toContain('path: "Updater/ProtocolTests"');
    expect(envelopeTests).toContain('payload(build: "0.2.13")');
  });

  test("rejects candidate metadata and embedded provenance that diverge from the signed release", () => {
    const validation = source("src/native/Recordings/Updater/Broker/CodeValidation.swift");
    const policy = source(
      "src/native/Recordings/Updater/Protocol/CandidateMetadataPolicy.swift",
    );
    const nativeBuild = source("src/native/Recordings/build.sh");
    expect(validation).toContain("CandidateMetadataPolicy.validate(");
    expect(validation).toContain("CandidateReleaseMetadataExpectation(");
    expect(validation).toContain("CandidateApplicationMetadata(");
    expect(validation).toContain("CandidateBuildProvenanceMetadata(");
    for (const binding of [
      'application.bundleIdentifier == expected.applicationIdentifier',
      'application.shortVersion == expected.version',
      'application.buildVersion == expected.build',
      'application.minimumOSVersion == expected.minimumOSVersion',
      'application.executable == expected.applicationExecutable',
      'provenance.schemaVersion == 4',
      '!provenance.containsLocalOnlyFields',
      'provenance.bundleIdentifier == expected.applicationIdentifier',
      'provenance.bundleVersion == expected.version',
      'provenance.bundleBuildVersion == expected.build',
      'provenance.sourceCommit == expected.sourceCommit',
      'provenance.teamIdentifier == expected.signingTeamIdentifier',
      'provenance.minimumMacOS == expected.minimumOSVersion',
      'provenance.architectures == expected.architectures',
      'companion.architectures == expected.architectures',
      'companion.sha256 == provenance.companionSHA256',
      'provenance.companionVersion == provenance.bundleVersion',
      'provenance.companionVersion == expected.version',
      'provenance.companionArchitectures == expected.architectures',
    ]) {
      expect(policy).toContain(binding);
    }
    expect(validation).toContain(
      'applicationPath + "/Contents/Resources/recordings-build-provenance.json"',
    );
    expect(validation).toContain("JSONDecoder().decode(ReleaseBuildProvenance.self");
    expect(validation).toContain("throw CodeValidationError.invalidBuildProvenance");
    expect(validation).toContain('applicationPath + "/Contents/Helpers/recordings"');
    expect(validation).toContain("let actualCompanionSHA256 = try sha256RegularFile(path: companionPath)");
    expect(validation).toContain("let actualCompanionArchitectures = try readArchitectures(companionPath)");
    expect(validation).toContain("let actualUpdateClientArchitectures = try readArchitectures(clientPath)");
    expect(validation).toContain("updateClientArchitectures: actualUpdateClientArchitectures");
    expect(policy).toContain("updateClientArchitectures == expected.architectures");
    const architectureTests = source(
      "src/native/Recordings/Updater/ProtocolTests/CandidateMetadataPolicyTests.swift",
    );
    for (const architectureCase of [
      '["arm64"]',
      '["x86_64"]',
      '[]',
      '["arm64", "x86_64", "i386"]',
    ]) {
      expect(architectureTests).toContain(architectureCase);
    }
    expect(validation).toContain("Set(provenanceObject.keys) == expectedProvenanceFields");
    expect(validation).toContain("Set(companionObject.keys) == expectedCompanionFields");
    expect(validation).not.toContain("process.executableURL = URL(fileURLWithPath: companionPath)");
    expect(nativeBuild).toContain('version="$(contract_run "$helper_executable" --version)"');
    expect(nativeBuild).toContain('[ "$version" != "$VERSION" ]');
  });

  test("rejects signed candidates unsupported by live pinned macOS ProductVersion evidence", () => {
    const broker = source("src/native/Recordings/Updater/Broker/BrokerMain.swift");
    const reader = source(
      "src/native/Recordings/Updater/Broker/HostOSProductVersion.swift",
    );
    const policy = source(
      "src/native/Recordings/Updater/Protocol/HostOSVersionPolicy.swift",
    );
    const policyTests = source(
      "src/native/Recordings/Updater/ProtocolTests/HostOSVersionPolicyTests.swift",
    );
    const journal = source(
      "src/native/Recordings/Updater/Broker/InstallJournal.swift",
    );
    const recovery = source(
      "src/native/Recordings/Updater/Broker/InstallRecovery.swift",
    );
    expect(reader).toContain('executablePath: "/usr/bin/sw_vers"');
    expect(reader).toContain('arguments: ["-productVersion"]');
    expect(reader).toContain("result.terminationStatus == 0");
    expect(reader).toContain("maximumOutputBytes: 65");
    expect(reader).toContain("timeout: 2");
    expect(reader).toContain("data.count <= 65");
    expect(policy).toContain("!host.lexicographicallyPrecedes(candidate)");
    expect(policy).toContain("hostProductVersionUnavailable");
    expect(policy).toContain("malformedHostProductVersion");
    expect(policy).toContain("candidateRequiresNewerOS");
    expect(journal).toContain('case minimumOSVersion = "minimum_os_version"');
    expect(journal).toContain(
      "HostOSVersionPolicy.isValidNumericVersion(value)",
    );
    expect(recovery).toContain("it can never resume mutation");
    expect(recovery).toContain("hostProductVersion: try HostOSProductVersionReader.read()");
    for (const evidence of [
      'candidateMinimumOSVersion: "26.0"',
      'hostProductVersion: "26.0.0"',
      'candidateMinimumOSVersion: "15.9.12"',
      'hostProductVersion: "15.10"',
      'candidateMinimumOSVersion: "26.1"',
      'hostProductVersion: "26.0.9"',
      'candidateMinimumOSVersion: "26.beta"',
      "hostProductVersion: nil",
    ]) {
      expect(policyTests).toContain(evidence);
    }
    const hostCheck = broker.indexOf("HostOSVersionPolicy.validate(");
    const bootstrapState = broker.indexOf("let result = try stateStore.perform(");
    const updateState = broker.indexOf("return try MonotonicReleaseStateStore().perform(");
    expect(hostCheck).toBeGreaterThan(0);
    expect(hostCheck).toBeLessThan(bootstrapState);
    expect(hostCheck).toBeLessThan(updateState);
  });

  test("gates managed bootstrap compatibility and bounds compatibility probe subprocesses", () => {
    const bootstrap = source(
      "src/native/Recordings/Updater/BootstrapPreflight/BootstrapPreflightMain.swift",
    );
    const runner = source(
      "src/native/Recordings/Updater/Protocol/BoundedProcess.swift",
    );
    const runnerTests = source(
      "src/native/Recordings/Updater/ProtocolTests/BoundedProcessRunnerTests.swift",
    );
    const brokerHost = source(
      "src/native/Recordings/Updater/Broker/HostOSProductVersion.swift",
    );
    const brokerValidation = source(
      "src/native/Recordings/Updater/Broker/CodeValidation.swift",
    );

    const envelopeVerification = bootstrap.indexOf(
      "let payload = try envelope.verify(publicKeyData: key.data)",
    );
    const hostCompatibility = bootstrap.indexOf("HostOSVersionPolicy.validate(");
    const manifestValidation = bootstrap.indexOf(
      "try validateManifest(manifest, payload: payload)",
    );
    const clientArchitecture = bootstrap.indexOf(
      "try requireArchitectures(client, expected: payload.architectures)",
    );
    const treeValidation = bootstrap.indexOf("let actualTreeDigest");
    expect(envelopeVerification).toBeGreaterThan(0);
    expect(hostCompatibility).toBeGreaterThan(envelopeVerification);
    expect(hostCompatibility).toBeLessThan(manifestValidation);
    expect(clientArchitecture).toBeGreaterThan(0);
    expect(clientArchitecture).toBeLessThan(treeValidation);

    expect(runner).toContain("public enum BoundedProcessRunner");
    expect(runner).toContain("F_SETFL, existingFlags | O_NONBLOCK");
    expect(runner).toContain("Darwin.poll(");
    expect(runner).toContain("Darwin.read(");
    expect(runner).toContain("try outputHandle.close()");
    expect(runner).not.toContain("read(upToCount:");
    expect(runner).not.toContain("DispatchWorkItem");
    expect(runner).not.toContain("asyncAfter(");
    expect(runner).toContain("Darwin.kill(processIdentifier, SIGKILL)");
    expect(runner).toContain("case timedOut");
    expect(runner).toContain("case outputTooLarge");
    expect(runner.indexOf("while !reachedEOF")).toBeLessThan(
      runner.lastIndexOf("process.waitUntilExit()"),
    );
    expect(brokerHost).toContain("BoundedProcessRunner.run(");
    expect(brokerValidation).toContain("BoundedProcessRunner.run(");
    expect(bootstrap.match(/BoundedProcessRunner\.run\(/g)?.length).toBe(3);
    expect(bootstrap).not.toContain("let process = Process()");
    expect(bootstrap).not.toContain("readDataToEndOfFile()");
    expect(bootstrap).not.toContain("waitUntilExit()");
    expect(runnerTests).toContain("BoundedProcessError.outputTooLarge");
    expect(runnerTests).toContain("BoundedProcessError.timedOut");
    expect(runnerTests).toContain("descendant retaining stdout");
    expect(runnerTests).toContain("(/bin/sleep 2; printf inherited) & exit 0");
  });

  test("reads candidate metadata through bounded no-follow stable root-owned files", () => {
    const validation = source("src/native/Recordings/Updater/Broker/CodeValidation.swift");
    const boundedReader = validation.match(
      /private static func readBoundedRegularFile[\s\S]*?\n    }\n}\n\nprivate struct ReleaseBuildProvenance/,
    )?.[0] ?? "";
    expect(boundedReader).toContain("O_NOFOLLOW");
    expect(boundedReader).toContain("metadata.st_uid == 0");
    expect(boundedReader).toContain("(metadata.st_mode & 0o022) == 0");
    expect(boundedReader).toContain("metadata.st_nlink == 1");
    expect(boundedReader).toContain("fstat(descriptor, &after)");
    expect(boundedReader).toContain("metadata.st_dev == after.st_dev");
    expect(boundedReader).toContain("metadata.st_ino == after.st_ino");
    expect(boundedReader).toContain("metadata.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec");
    expect(boundedReader).toContain("metadata.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec");
  });

  test("duplicates ingress immediately and copies retained snapshots into durable root staging", () => {
    const ingest = source("src/native/Recordings/Updater/Broker/ArtifactIngest.swift");
    expect(ingest).toContain("F_DUPFD_CLOEXEC");
    expect(ingest).toContain("O_EXCL | O_CLOEXEC | O_NOFOLLOW");
    expect(ingest).toContain("pread(sourceDescriptor");
    expect(ingest).toContain("sourceChangedDuringCopy");
    expect(ingest.match(/fsync\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  test("fails closed on extended ACLs across every root-owned broker trust boundary", () => {
    const updateProtocol = source(
      "src/native/Recordings/Updater/Protocol/UpdateProtocol.swift",
    );
    const validator = source(
      "src/native/Recordings/Updater/Broker/DarwinACLValidator.swift",
    );
    const launcher = source(
      "src/native/Recordings/Updater/VerifierLauncher/RecordingsVerifierLauncher.c",
    );
    const aclHelper = launcher.match(
      /int recordings_descriptor_has_no_extended_acl[\s\S]*?\n}\n\nstatic int validate_root_owned_directory_path/,
    )?.[0] ?? "";
    expect(aclHelper).toContain("errno = 0");
    expect(aclHelper).toContain("acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED)");
    expect(aclHelper).toContain("if (acl == NULL) return errno == ENOENT ? 1 : 0;");
    expect(aclHelper).toContain("(void)acl_free(acl);");
    expect(aclHelper).toMatch(/\(void\)acl_free\(acl\);\n    return 0;/);
    expect(aclHelper).not.toContain("acl_get_entry");
    expect(launcher).toContain("recordings_descriptor_has_no_extended_acl");
    expect(validator).toContain("recordings_descriptor_has_no_extended_acl(descriptor) == 1");
    expect(validator).toContain("O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW");
    expect(validator).toContain("rootOwnedDirectoryAncestryHasNoExtendedACL");
    expect(validator).toContain("var currentPath = \"/\"");
    expect(validator).toContain('return exactPath == "/Applications" &&');
    expect(validator).toContain("metadata.st_gid == 80");
    expect(validator).toContain("permissions == 0o775");
    expect(updateProtocol).toContain(
      'monotonicStateDirectory = "/private/var/db/com.hasna.recordings.updater"',
    );
    expect(validator).toContain("if (permissions & 0o022) == 0 { return true }");
    expect(validator).toContain(
      "descriptorIsSafeRootOwnedDirectory(child, exactPath: currentPath)",
    );
    const pathAdvance = validator.indexOf('currentPath = currentPath == "/"');
    const childValidation = validator.indexOf(
      "descriptorIsSafeRootOwnedDirectory(child, exactPath: currentPath)",
    );
    expect(pathAdvance).toBeGreaterThan(0);
    expect(pathAdvance).toBeLessThan(childValidation);

    const activation = source(
      "src/native/Recordings/Updater/Broker/AtomicActivation.swift",
    );
    expect(activation).toContain("descriptorIsSafeRootOwnedDirectory(");
    expect(activation).toContain('exactPath: "/Applications"');

    for (const path of [
      "PeerIdentity.swift",
      "ArtifactIngest.swift",
      "AtomicActivation.swift",
      "CodeValidation.swift",
      "MonotonicState.swift",
      "InstallJournal.swift",
      "InstallRecovery.swift",
      "VerifierRunner.swift",
      "CanonicalTreeCopy.swift",
    ]) {
      const implementation = source(`src/native/Recordings/Updater/Broker/${path}`);
      expect(implementation).toContain("DarwinACLValidator.");
    }
  });

  test("drops verifier privilege before sandboxed parsing and applies resource limits", () => {
    const launcher = source(
      "src/native/Recordings/Updater/VerifierLauncher/RecordingsVerifierLauncher.c",
    );
    expect(launcher).toContain("setgroups(1, groups)");
    expect(launcher).toContain("setgid(group_id)");
    expect(launcher).toContain("setuid(user_id)");
    expect(launcher).toContain("sandbox_init_with_parameters");
    expect(launcher).toContain('"OUTPUT_DIR", output_path');
    expect(launcher).toContain('(char *)"verify"');
    for (const limit of ["RLIMIT_CPU", "RLIMIT_AS", "RLIMIT_FSIZE", "RLIMIT_NOFILE", "RLIMIT_NPROC"]) {
      expect(launcher).toContain(limit);
    }
    expect(launcher).toContain("recordings_copy_canonical_application_tree");
    expect(launcher).toContain("fstatat(source_parent, name, &named, AT_SYMLINK_NOFOLLOW)");
    expect(launcher).toContain("openat(source_parent, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)");
  });

  test("persists highest-seen state before activation and pins the immutable cohort key epoch", () => {
    const state = source("src/native/Recordings/Updater/Broker/MonotonicState.swift");
    const policy = source("src/native/Recordings/Updater/Protocol/MonotonicReleasePolicy.swift");
    const peer = source("src/native/Recordings/Updater/Broker/PeerIdentity.swift");
    const broker = source("src/native/Recordings/Updater/Broker/BrokerMain.swift");
    const preparation = state.indexOf("try prepare(decision)");
    const seen = state.indexOf('writeState(payload: payload, payloadDigest: payloadDigest, phase: "seen")');
    const operation = state.indexOf("result = try operation(decision)");
    expect(preparation).toBeGreaterThan(0);
    expect(preparation).toBeLessThan(seen);
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(operation);
    expect(peer).toContain("allowedKeyEpochs == [initialKeyEpoch]");
    expect(state).toContain("MonotonicReleasePolicy.assess");
    expect(policy).toContain("allowedKeyEpochs == [initialKeyEpoch]");
    expect(policy).toContain("candidate.keyEpoch == initialKeyEpoch");
    expect(policy).toContain("candidate.cohortPackageSHA256 == current.cohortPackageSHA256");
    expect(policy).toContain("if current.phase == .seen");
    expect(policy).toContain("if current.phase == .aborted");
    expect(policy).toContain("candidate.releaseSequence > current.releaseSequence");
    expect(policy).toContain("throw MonotonicReleasePolicyError.pendingSeenRecoveryRequired");
    expect(state).toContain('case cohortPackageSHA256 = "cohort_package_sha256"');
    expect(state).not.toContain("payload.keyEpoch == current.keyEpoch + 1");
    expect(broker).toContain("readEnvelopePublicKey(epoch: policy.initialKeyEpoch)");
    expect(broker).toContain("BrokerOperationError.unsupportedLifecycle");
    expect(broker).toContain("markerDigest == payload.bootstrapMarkerSHA256");
    expect(state).toContain("phase: \"committed\"");
    expect(state).toContain("phase: \"aborted\"");
    expect(state).toContain("finalizeRecoveredAbort");
  });

  test("reports the explicit app-only lifecycle and fails closed on root cohort changes", () => {
    const protocol = source("src/native/Recordings/Updater/Protocol/UpdateProtocol.swift");
    const broker = source("src/native/Recordings/Updater/Broker/BrokerMain.swift");
    for (const value of [
      "bootstrap-v1-app-updates-only",
      "root_maintenance_supported",
      "key_rotation_supported",
      "unsupported_lifecycle",
    ]) {
      expect(protocol).toContain(value);
    }
    expect(broker).toContain("Only app-artifact updates are supported");
    expect(broker).toContain("managed reprovisioning");
    expect(broker).toContain("RecordingsUpdateReplyKey.keyEpoch");
  });

  test("separates bootstrap initialization from verifier-driven update activation", () => {
    const broker = source("src/native/Recordings/Updater/Broker/BrokerMain.swift");
    const state = source("src/native/Recordings/Updater/Broker/MonotonicState.swift");
    const bootstrap = broker.indexOf('payload.purpose == "bootstrap"');
    const verifier = broker.indexOf("ArtifactVerifierRunner().materialize");
    expect(bootstrap).toBeGreaterThan(0);
    expect(bootstrap).toBeLessThan(verifier);
    expect(broker).toContain("readBootstrapMarker");
    expect(broker).toContain("validateProtectedComponents");
    expect(broker).toContain("MonotonicReleaseStateStore().perform");
    expect(broker).toContain("case .advance, .resumeSeen, .alreadyCommitted:");
    expect(state).toContain("MonotonicReleaseCandidate(");
    expect(state).toContain("MonotonicReleaseStateSnapshot(");
    expect(state).toContain("case .resumeSeen: return .resumeSeen");
  });

  test("signer never prints key material and binds private key to selected epoch public key", () => {
    const signer = source("src/native/Recordings/Updater/Signer/SignerMain.swift");
    expect(signer).toContain("--public-key");
    expect(signer).toContain("privateKey.publicKey.rawRepresentation == publicKeyData");
    expect(signer).toContain("O_EXCL | O_CLOEXEC | O_NOFOLLOW");
    expect(signer).not.toContain("print(privateKey");
  });
});
