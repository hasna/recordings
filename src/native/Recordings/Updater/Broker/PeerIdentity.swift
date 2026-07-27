import Darwin
import Foundation
import RecordingsUpdateProtocol
import Security

struct BrokerPolicy: Codable, Sendable {
    let schemaVersion: Int
    let signingTeamIdentifier: String
    let allowedClientIdentifiers: [String]
    let applicationIdentifier: String
    let initialKeyEpoch: UInt64
    let allowedKeyEpochs: [UInt64]
    let lifecycle: String
    let rootMaintenanceSupported: Bool
    let keyRotationSupported: Bool

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case signingTeamIdentifier = "signing_team_identifier"
        case allowedClientIdentifiers = "allowed_client_identifiers"
        case applicationIdentifier = "application_identifier"
        case initialKeyEpoch = "initial_key_epoch"
        case allowedKeyEpochs = "allowed_key_epochs"
        case lifecycle
        case rootMaintenanceSupported = "root_maintenance_supported"
        case keyRotationSupported = "key_rotation_supported"
    }

    func validate() throws {
        guard schemaVersion == RecordingsUpdateConstants.protocolVersion else {
            throw BrokerSecurityError.invalidPolicy("unsupported schema")
        }
        guard signingTeamIdentifier.range(of: #"^[A-Z0-9]{10}$"#, options: .regularExpression) != nil else {
            throw BrokerSecurityError.invalidPolicy("invalid team identifier")
        }
        guard !allowedClientIdentifiers.isEmpty, allowedClientIdentifiers.count <= 16 else {
            throw BrokerSecurityError.invalidPolicy("invalid client identifier list")
        }
        guard initialKeyEpoch > 0, allowedKeyEpochs == [initialKeyEpoch]
        else {
            throw BrokerSecurityError.invalidPolicy("invalid key-epoch authorization")
        }
        guard lifecycle == RecordingsUpdateConstants.lifecycle,
              rootMaintenanceSupported == RecordingsUpdateConstants.rootMaintenanceSupported,
              keyRotationSupported == RecordingsUpdateConstants.keyRotationSupported
        else {
            throw BrokerSecurityError.invalidPolicy("unsupported updater lifecycle")
        }
        for identifier in allowedClientIdentifiers + [applicationIdentifier] {
            guard identifier.range(of: #"^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$"#, options: .regularExpression) != nil else {
                throw BrokerSecurityError.invalidPolicy("invalid bundle identifier")
            }
        }
    }
}

struct AuthenticatedPeer: Sendable {
    let effectiveUserID: uid_t
    let processIdentifier: pid_t
    let signingIdentifier: String
    let signingTeamIdentifier: String
}

enum RootTrustStore {
    static func readPolicy() throws -> BrokerPolicy {
        let data = try readRootOwnedRegularFile(
            at: RecordingsUpdateConstants.policyPath,
            maximumBytes: 64 * 1024,
            expectedModeMask: 0o022
        )
        let policy: BrokerPolicy
        do {
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .useDefaultKeys
            policy = try decoder.decode(BrokerPolicy.self, from: data)
        } catch {
            throw BrokerSecurityError.invalidPolicy("malformed JSON")
        }
        try policy.validate()
        return policy
    }

    static func readEnvelopePublicKey(epoch: UInt64) throws -> Data {
        guard epoch > 0 else { throw BrokerSecurityError.invalidTrustFile }
        let data = try readRootOwnedRegularFile(
            at: RecordingsUpdateConstants.envelopePublicKeyDirectory + "/\(epoch).raw",
            maximumBytes: 32,
            expectedModeMask: 0o022
        )
        guard data.count == 32 else { throw BrokerSecurityError.invalidTrustFile }
        return data
    }

    static func readBootstrapMarker() throws -> Data {
        try readRootOwnedRegularFile(
            at: RecordingsUpdateConstants.bootstrapMarkerPath,
            maximumBytes: 1024 * 1024,
            expectedModeMask: 0o022
        )
    }

    private static func readRootOwnedRegularFile(
        at path: String,
        maximumBytes: Int,
        expectedModeMask: mode_t
    ) throws -> Data {
        let parentDirectory = URL(fileURLWithPath: path).deletingLastPathComponent().path
        guard DarwinACLValidator.rootOwnedDirectoryAncestryHasNoExtendedACL(
            to: parentDirectory
        ) else {
            throw BrokerSecurityError.invalidTrustFile
        }
        let descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw BrokerSecurityError.invalidTrustFile }
        defer { Darwin.close(descriptor) }

        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == 0,
              (metadata.st_mode & expectedModeMask) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor),
              metadata.st_size > 0,
              metadata.st_size <= maximumBytes
        else {
            throw BrokerSecurityError.invalidTrustFile
        }

        var result = Data()
        result.reserveCapacity(Int(metadata.st_size))
        var offset: off_t = 0
        var buffer = [UInt8](repeating: 0, count: min(16 * 1024, maximumBytes + 1))
        while offset < metadata.st_size {
            let requested = min(buffer.count, Int(metadata.st_size - offset))
            let count = buffer.withUnsafeMutableBytes {
                pread(descriptor, $0.baseAddress, requested, offset)
            }
            guard count > 0 else { throw BrokerSecurityError.invalidTrustFile }
            result.append(contentsOf: buffer.prefix(count))
            offset += off_t(count)
        }
        var trailingByte: UInt8 = 0
        guard pread(descriptor, &trailingByte, 1, offset) == 0,
              DarwinACLValidator.descriptorHasNoExtendedACL(descriptor)
        else {
            throw BrokerSecurityError.invalidTrustFile
        }
        return result
    }
}

/// PRIVATE API, DELIBERATE — RISK ACCEPTED.
///
/// The peer's audit token is the only race-free identity for an XPC connection: it names the
/// exact process that opened the connection, whereas a PID can be reused between the time
/// the kernel reports it and the time we resolve its code signature. `NSXPCConnection`
/// exposes `-auditToken` in the runtime but declares it in no public header (the public
/// header offers only `processIdentifier`, `effectiveUserIdentifier` and
/// `auditSessionIdentifier`), so this declaration is the only contract we have and Apple may
/// change or remove it in any macOS update.
///
/// Two things keep that risk bounded, and both must stay:
///   1. `authenticate` checks `responds(to:)` before casting, so a macOS that drops the
///      property makes peer authentication throw rather than read a garbage struct.
///   2. `authenticate` cross-checks the token's PID and EUID against the *public*
///      `processIdentifier` and `effectiveUserIdentifier`. Any future ABI drift that
///      silently changed the returned layout would disagree with those and be rejected,
///      so the failure mode is a refused peer, never a mis-identified one.
///
/// The supported long-term replacement is `-[NSXPCListener setConnectionCodeSigningRequirement:]`
/// (macOS 13+), which moves requirement enforcement into XPC itself. Migrating is tracked
/// separately because this code also reads signing flags and entitlements back off the
/// resolved `SecCode`, which that API does not provide.
@objc private protocol XPCConnectionAuditTokenProviding {
    var auditToken: audit_token_t { get }
}

struct PeerIdentityPolicy {
    let policy: BrokerPolicy

    func authenticate(_ connection: NSXPCConnection) throws -> AuthenticatedPeer {
        // See XPCConnectionAuditTokenProviding: fail closed if the private property is gone
        // instead of reinterpreting whatever the cast would land on.
        guard connection.responds(to: NSSelectorFromString("auditToken")) else {
            throw BrokerSecurityError.peerAuditTokenUnavailable
        }
        var token = unsafeBitCast(connection, to: XPCConnectionAuditTokenProviding.self).auditToken
        // The audit token is authoritative, but it must agree with the two public
        // properties. Disagreement means the private ABI moved under us; refuse the peer.
        guard audit_token_to_pid(token) == connection.processIdentifier,
              audit_token_to_euid(token) == connection.effectiveUserIdentifier
        else {
            throw BrokerSecurityError.peerAuditTokenUnavailable
        }
        let tokenData = withUnsafeBytes(of: &token) { Data($0) }
        let attributes = [kSecGuestAttributeAudit as String: tokenData] as CFDictionary
        var guest: SecCode?
        let guestStatus = SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest)
        guard guestStatus == errSecSuccess, let guest else {
            throw BrokerSecurityError.peerCodeUnavailable(guestStatus)
        }

        let identifiers = policy.allowedClientIdentifiers
            .map { "identifier \(Self.requirementQuoted($0))" }
            .joined(separator: " or ")
        let requirementText = """
        anchor apple generic and
        certificate leaf[field.1.2.840.113635.100.6.1.13] exists and
        certificate 1[field.1.2.840.113635.100.6.2.6] exists and
        certificate leaf[subject.OU] = \(Self.requirementQuoted(policy.signingTeamIdentifier)) and
        (\(identifiers))
        """
        var requirement: SecRequirement?
        let requirementStatus = SecRequirementCreateWithString(
            requirementText as CFString,
            [],
            &requirement
        )
        guard requirementStatus == errSecSuccess, let requirement else {
            throw BrokerSecurityError.invalidPolicy("could not compile peer requirement")
        }
        let validationStatus = SecCodeCheckValidity(
            guest,
            SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode),
            requirement
        )
        guard validationStatus == errSecSuccess else {
            throw BrokerSecurityError.peerRejected(validationStatus)
        }

        var signingInformation: CFDictionary?
        // `SecCodeCopySigningInformation` is typed against `SecStaticCode`. In C a
        // `SecCodeRef` is accepted directly (a dynamic code is a static code plus running
        // state) but Swift imports the two as unrelated CF types, so the relationship has
        // to be restated. This is a representation cast only — no ownership transfer.
        let staticGuest = unsafeBitCast(guest, to: SecStaticCode.self)
        let informationStatus = SecCodeCopySigningInformation(
            staticGuest,
            SecCSFlags(rawValue: kSecCSSigningInformation | kSecCSRequirementInformation),
            &signingInformation
        )
        guard informationStatus == errSecSuccess,
              let information = signingInformation as? [String: Any],
              let identifier = information[kSecCodeInfoIdentifier as String] as? String,
              let team = information[kSecCodeInfoTeamIdentifier as String] as? String,
              identifiersContain(identifier),
              team == policy.signingTeamIdentifier,
              Self.hasHardenedRuntime(information),
              Self.hasNoDangerousDebugOrLoaderEntitlements(information)
        else {
            throw BrokerSecurityError.peerMetadataRejected
        }

        return AuthenticatedPeer(
            effectiveUserID: audit_token_to_euid(token),
            processIdentifier: audit_token_to_pid(token),
            signingIdentifier: identifier,
            signingTeamIdentifier: team
        )
    }

    private func identifiersContain(_ identifier: String) -> Bool {
        policy.allowedClientIdentifiers.contains(identifier)
    }

    private static func requirementQuoted(_ value: String) -> String {
        "\"" + value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    private static func hasHardenedRuntime(_ information: [String: Any]) -> Bool {
        guard let flags = information[kSecCodeInfoFlags as String] as? NSNumber else {
            return false
        }
        // `kSecCodeSignatureRuntime` is a member of the `CF_OPTIONS(uint32_t,
        // SecCodeSignatureFlags)` set in CSCommon.h, so Swift exposes it as
        // `SecCodeSignatureFlags.runtime` and not as a bare `kSec…` global.
        return flags.uint32Value & SecCodeSignatureFlags.runtime.rawValue != 0
    }

    private static func hasNoDangerousDebugOrLoaderEntitlements(
        _ information: [String: Any]
    ) -> Bool {
        let entitlements: [String: Any]
        if let values = information[kSecCodeInfoEntitlementsDict as String] as? [String: Any] {
            entitlements = values
        } else if information[kSecCodeInfoEntitlementsDict as String] == nil,
                  information[kSecCodeInfoEntitlements as String] == nil {
            entitlements = [:]
        } else {
            // A present but non-dictionary entitlement blob is not safely
            // inspectable here, so dynamic-peer admission fails closed.
            return false
        }
        let forbidden = [
            "com.apple.security.get-task-allow",
            "com.apple.security.cs.disable-library-validation",
            "com.apple.security.cs.allow-dyld-environment-variables",
        ]
        return forbidden.allSatisfy { entitlements[$0] == nil }
    }
}

enum BrokerSecurityError: Error, CustomStringConvertible {
    case invalidPolicy(String)
    case invalidTrustFile
    case peerCodeUnavailable(OSStatus)
    case peerAuditTokenUnavailable
    case peerRejected(OSStatus)
    case peerMetadataRejected

    var description: String {
        switch self {
        case let .invalidPolicy(reason): "Invalid root-owned broker policy: \(reason)"
        case .invalidTrustFile: "A root-owned broker trust file is missing or unsafe"
        case let .peerCodeUnavailable(status): "Could not resolve the XPC peer code identity (\(status))"
        case .peerAuditTokenUnavailable:
            "Could not read a trustworthy audit token for the XPC peer"
        case let .peerRejected(status): "The XPC peer code identity was rejected (\(status))"
        case .peerMetadataRejected: "The XPC peer signing metadata was rejected"
        }
    }
}
