import Darwin
import Foundation

public enum NativeMachineIdentity {
    public static func current(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        hostName: String? = nil
    ) -> String {
        let configured = environment["HASNA_MACHINE_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !configured.isEmpty { return configured }
        return (hostName ?? posixHostName()).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func posixHostName() -> String {
        var buffer = [CChar](repeating: 0, count: 256)
        let result = buffer.withUnsafeMutableBufferPointer { pointer -> String? in
            guard let baseAddress = pointer.baseAddress,
                  gethostname(baseAddress, pointer.count) == 0 else { return nil }
            pointer[pointer.count - 1] = 0
            return String(cString: baseAddress)
        }
        return result ?? ProcessInfo.processInfo.hostName
    }
}
