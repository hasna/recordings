import Foundation

public enum RecordingsUpdateConstants {
    public static let protocolVersion = 1
    public static let brokerVersion = "1.0.0"
    public static let lifecycle = "bootstrap-v1-app-updates-only"
    public static let rootMaintenanceSupported = false
    public static let keyRotationSupported = false
    public static let machServiceName = "com.hasna.recordings.updater"
    public static let applicationPath = "/Applications/Recordings.app"
    public static let brokerExecutablePath = "/Library/PrivilegedHelperTools/com.hasna.recordings.updater"
    public static let stateRoot = "/Library/Application Support/Hasna/Recordings/Updates"
    public static let trustRoot = "/Library/Application Support/Hasna/Recordings/Trust"
    public static let policyPath = trustRoot + "/broker-policy.json"
    public static let envelopePublicKeyDirectory = trustRoot + "/envelope-keys"
    public static let monotonicStateDirectory = "/private/var/db/com.hasna.recordings.updater"
    public static let monotonicStatePath = monotonicStateDirectory + "/release-state.json"
    public static let artifactVerifierPath = "/Library/PrivilegedHelperTools/com.hasna.recordings.artifact-verifier"
    public static let artifactVerifierSandboxProfilePath = trustRoot + "/artifact-verifier.sb"
    public static let bootstrapMarkerPath = trustRoot + "/bootstrap-marker.json"
    public static let artifactVerifierAccount = "_recordingsverify"
    public static let updateClientRelativePath = "Contents/Helpers/recordings-update-client"
}

public enum RecordingsUpdateErrorCode: String, Codable, Sendable {
    case invalidRequest = "invalid_request"
    case unauthorizedPeer = "unauthorized_peer"
    case brokerUnavailable = "broker_unavailable"
    case brokerNotPrivileged = "broker_not_privileged"
    case invalidDescriptor = "invalid_descriptor"
    case artifactTooLarge = "artifact_too_large"
    case invalidEnvelope = "invalid_envelope"
    case signatureRejected = "signature_rejected"
    case artifactMismatch = "artifact_mismatch"
    case rollbackRejected = "rollback_rejected"
    case unsupportedLifecycle = "unsupported_lifecycle"
    case codeIdentityRejected = "code_identity_rejected"
    case candidateRejected = "candidate_rejected"
    case activationFailed = "activation_failed"
    case internalFailure = "internal_failure"
}

public enum RecordingsUpdateReplyKey {
    public static let success = "success"
    public static let code = "code"
    public static let message = "message"
    public static let transactionID = "transaction_id"
    public static let releaseID = "release_id"
    public static let installedVersion = "installed_version"
    public static let lifecycle = "lifecycle"
    public static let rootMaintenanceSupported = "root_maintenance_supported"
    public static let keyRotationSupported = "key_rotation_supported"
    public static let keyEpoch = "key_epoch"
}

public func updateSuccessReply(
    transactionID: String? = nil,
    releaseID: String? = nil,
    installedVersion: String? = nil
) -> NSDictionary {
    let reply = NSMutableDictionary()
    reply[RecordingsUpdateReplyKey.success] = true
    reply[RecordingsUpdateReplyKey.code] = "ok"
    reply[RecordingsUpdateReplyKey.message] = "Update completed"
    reply[RecordingsUpdateReplyKey.lifecycle] = RecordingsUpdateConstants.lifecycle
    reply[RecordingsUpdateReplyKey.rootMaintenanceSupported] =
        RecordingsUpdateConstants.rootMaintenanceSupported
    reply[RecordingsUpdateReplyKey.keyRotationSupported] =
        RecordingsUpdateConstants.keyRotationSupported
    if let transactionID { reply[RecordingsUpdateReplyKey.transactionID] = transactionID }
    if let releaseID { reply[RecordingsUpdateReplyKey.releaseID] = releaseID }
    if let installedVersion { reply[RecordingsUpdateReplyKey.installedVersion] = installedVersion }
    return reply
}

public func updateFailureReply(_ code: RecordingsUpdateErrorCode, message: String) -> NSDictionary {
    let reply = NSMutableDictionary()
    reply[RecordingsUpdateReplyKey.success] = false
    reply[RecordingsUpdateReplyKey.code] = code.rawValue
    reply[RecordingsUpdateReplyKey.message] = message
    reply[RecordingsUpdateReplyKey.lifecycle] = RecordingsUpdateConstants.lifecycle
    reply[RecordingsUpdateReplyKey.rootMaintenanceSupported] =
        RecordingsUpdateConstants.rootMaintenanceSupported
    reply[RecordingsUpdateReplyKey.keyRotationSupported] =
        RecordingsUpdateConstants.keyRotationSupported
    return reply
}

@objc(RecordingsUpdateXPCProtocol)
public protocol RecordingsUpdateXPCProtocol {
    /// File descriptors, not paths, cross the trust boundary. The broker copies every
    /// descriptor into root-owned storage before parsing or executing any content.
    @objc(installWithArchive:manifest:envelope:reply:)
    func install(
        archive: FileHandle,
        manifest: FileHandle,
        envelope: FileHandle,
        withReply reply: @escaping (NSDictionary) -> Void
    )

    @objc(queryStatusWithReply:)
    func queryStatus(withReply reply: @escaping (NSDictionary) -> Void)
}

/// XPC decoding is intentionally limited to retained file handles on request and
/// scalar dictionaries on reply. No path-bearing or arbitrary option object is accepted.
public func makeRecordingsUpdateXPCInterface() -> NSXPCInterface {
    let interface = NSXPCInterface(with: RecordingsUpdateXPCProtocol.self)
    let installSelector = NSSelectorFromString("installWithArchive:manifest:envelope:reply:")
    let statusSelector = NSSelectorFromString("queryStatusWithReply:")
    let fileHandleClasses: Set<AnyHashable> = [FileHandle.self]
    for index in 0..<3 {
        interface.setClasses(fileHandleClasses, for: installSelector, argumentIndex: index, ofReply: false)
    }
    let replyClasses: Set<AnyHashable> = [NSDictionary.self, NSString.self, NSNumber.self]
    interface.setClasses(replyClasses, for: installSelector, argumentIndex: 0, ofReply: true)
    interface.setClasses(replyClasses, for: statusSelector, argumentIndex: 0, ofReply: true)
    return interface
}
