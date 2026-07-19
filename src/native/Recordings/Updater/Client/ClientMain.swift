import Darwin
import Foundation
import RecordingsUpdateProtocol

@main
enum RecordingsUpdateClientMain {
    static func main() {
        do {
            let command = try ClientCommand.parse(CommandLine.arguments)
            let connection = NSXPCConnection(
                machServiceName: RecordingsUpdateConstants.machServiceName,
                options: .privileged
            )
            connection.remoteObjectInterface = makeRecordingsUpdateXPCInterface()
            connection.resume()
            defer { connection.invalidate() }
            let reply: NSDictionary
            switch command {
            case .status:
                reply = try invoke(connection: connection) { service, callback in
                    service.queryStatus(withReply: callback)
                }
            case let .install(artifactPath, manifestPath, envelopePath):
                let artifact = try retainedRegularFile(path: artifactPath)
                let manifest = try retainedRegularFile(path: manifestPath)
                let envelope = try retainedRegularFile(path: envelopePath)
                defer {
                    try? artifact.close()
                    try? manifest.close()
                    try? envelope.close()
                }
                reply = try invoke(connection: connection) { service, callback in
                    service.install(
                        archive: artifact,
                        manifest: manifest,
                        envelope: envelope,
                        withReply: callback
                    )
                }
            }
            let data = try JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys])
            FileHandle.standardOutput.write(data + Data([0x0a]))
            guard reply[RecordingsUpdateReplyKey.success] as? Bool == true else { Darwin.exit(1) }
        } catch {
            FileHandle.standardError.write(Data("recordings-update-client: request failed\n".utf8))
            Darwin.exit(1)
        }
    }

    private static func invoke(
        connection: NSXPCConnection,
        operation: (RecordingsUpdateXPCProtocol, @escaping (NSDictionary) -> Void) -> Void
    ) throws -> NSDictionary {
        let semaphore = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var result: NSDictionary?
        var failed = false
        let proxy = connection.remoteObjectProxyWithErrorHandler { _ in
            lock.lock(); failed = true; lock.unlock()
            semaphore.signal()
        }
        guard let service = proxy as? RecordingsUpdateXPCProtocol else {
            throw ClientError.brokerUnavailable
        }
        operation(service) { reply in
            lock.lock(); result = reply; lock.unlock()
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + 300) == .success else {
            throw ClientError.timeout
        }
        lock.lock(); defer { lock.unlock() }
        guard !failed, let result else { throw ClientError.brokerUnavailable }
        return result
    }

    private static func retainedRegularFile(path: String) throws -> FileHandle {
        guard path.hasPrefix("/") else { throw ClientError.invalidArguments }
        let descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw ClientError.invalidInput }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_size > 0
        else {
            Darwin.close(descriptor)
            throw ClientError.invalidInput
        }
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }
}

private enum ClientCommand {
    case status
    case install(artifact: String, manifest: String, envelope: String)

    static func parse(_ arguments: [String]) throws -> ClientCommand {
        if arguments.count == 2, arguments[1] == "status" { return .status }
        guard arguments.count == 8,
              arguments[1] == "install" || arguments[1] == "bootstrap",
              arguments[2] == "--artifact",
              arguments[4] == "--manifest",
              arguments[6] == "--envelope",
              arguments[3].hasPrefix("/"),
              arguments[5].hasPrefix("/"),
              arguments[7].hasPrefix("/")
        else {
            throw ClientError.invalidArguments
        }
        return .install(artifact: arguments[3], manifest: arguments[5], envelope: arguments[7])
    }
}

private enum ClientError: Error {
    case invalidArguments
    case invalidInput
    case brokerUnavailable
    case timeout
}
