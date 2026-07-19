import Darwin
import Foundation
import RecordingsUpdateProtocol

enum ApplicationProcessQuiescence {
    /// Reject activation while any executable loaded from the live bundle is still
    /// running. The one authenticated update client servicing this XPC request is
    /// exempt only when its kernel-reported executable path is the fixed client path.
    static func requireQuiescence(excludingAuthenticatedClientPID excludedPID: pid_t?) throws {
        let capacity = 16_384
        var processIdentifiers = [pid_t](repeating: 0, count: capacity)
        let count = processIdentifiers.withUnsafeMutableBytes { bytes in
            proc_listallpids(bytes.baseAddress, Int32(bytes.count))
        }
        guard count >= 0, Int(count) < capacity else {
            throw ApplicationProcessQuiescenceError.enumerationFailed
        }

        let liveContentsPrefix = RecordingsUpdateConstants.applicationPath + "/Contents/"
        let authenticatedClientPath = RecordingsUpdateConstants.applicationPath + "/"
            + RecordingsUpdateConstants.updateClientRelativePath
        for processIdentifier in processIdentifiers.prefix(Int(count)) where processIdentifier > 0 {
            var pathBytes = [CChar](repeating: 0, count: Int(PROC_PIDPATHINFO_MAXSIZE))
            let pathLength = pathBytes.withUnsafeMutableBufferPointer { buffer in
                proc_pidpath(
                    processIdentifier,
                    buffer.baseAddress,
                    UInt32(buffer.count)
                )
            }
            if pathLength <= 0 {
                // PIDs can disappear between enumeration and inspection. A live PID
                // that cannot be inspected remains observable with kill(0), so only
                // fail closed for that case.
                if kill(processIdentifier, 0) == 0 || errno == EPERM {
                    throw ApplicationProcessQuiescenceError.processInspectionFailed
                }
                continue
            }
            let executablePath = String(cString: pathBytes)
            guard executablePath.hasPrefix(liveContentsPrefix) else { continue }
            if processIdentifier == excludedPID,
               executablePath == authenticatedClientPath {
                continue
            }
            throw ApplicationProcessQuiescenceError.liveBundleProcessRunning
        }
    }
}

enum ApplicationProcessQuiescenceError: Error {
    case enumerationFailed
    case processInspectionFailed
    case liveBundleProcessRunning
}
