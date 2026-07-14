import Foundation

public enum NativeMachineIdentity {
    public static func current(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        hostName: String = ProcessInfo.processInfo.hostName
    ) -> String {
        let configured = environment["HASNA_MACHINE_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !configured.isEmpty { return configured }
        return hostName.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
