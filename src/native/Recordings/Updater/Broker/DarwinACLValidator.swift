import Darwin
import Foundation
import RecordingsVerifierLauncher

enum DarwinACLValidator {
    static func descriptorHasNoExtendedACL(_ descriptor: Int32) -> Bool {
        recordings_descriptor_has_no_extended_acl(descriptor) == 1
    }

    static func pathHasNoExtendedACL(_ path: String, directory: Bool) -> Bool {
        let flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | (directory ? O_DIRECTORY : 0)
        let descriptor = Darwin.open(path, flags)
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }
        return descriptorHasNoExtendedACL(descriptor)
    }

    static func descriptorIsSafeRootOwnedDirectory(
        _ descriptor: Int32,
        exactPath: String
    ) -> Bool {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == 0,
              descriptorHasNoExtendedACL(descriptor)
        else {
            return false
        }
        let permissions = metadata.st_mode & 0o777
        if (permissions & 0o022) == 0 { return true }
        return exactPath == "/Applications" &&
            metadata.st_gid == 80 &&
            permissions == 0o775
    }

    static func rootOwnedDirectoryAncestryHasNoExtendedACL(to directoryPath: String) -> Bool {
        let standardized = URL(fileURLWithPath: directoryPath).standardized.path
        guard standardized.hasPrefix("/") else { return false }
        let flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
        var descriptor = Darwin.open("/", flags)
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }

        var currentPath = "/"
        guard descriptorIsSafeRootOwnedDirectory(descriptor, exactPath: currentPath) else {
            return false
        }
        let components = URL(fileURLWithPath: standardized).pathComponents.dropFirst()
        for component in components {
            let child = component.withCString { openat(descriptor, $0, flags) }
            currentPath = currentPath == "/"
                ? "/" + component
                : currentPath + "/" + component
            guard child >= 0,
                  descriptorIsSafeRootOwnedDirectory(child, exactPath: currentPath)
            else {
                if child >= 0 { Darwin.close(child) }
                return false
            }
            Darwin.close(descriptor)
            descriptor = child
        }
        return true
    }
}
