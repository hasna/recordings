public enum HostOSVersionPolicyError: Error, Equatable, Sendable {
    case hostProductVersionUnavailable
    case malformedCandidateMinimumOSVersion
    case malformedHostProductVersion
    case candidateRequiresNewerOS
}

/// Pure compatibility policy for signed minimum-OS evidence and live host evidence.
///
/// macOS ProductVersion and LSMinimumSystemVersion commonly omit a zero patch
/// component. Parse two- and three-component numeric versions, normalize the
/// missing patch to zero, and never fall back to lexical comparison.
public enum HostOSVersionPolicy {
    public static func validate(
        candidateMinimumOSVersion: String,
        hostProductVersion: String?
    ) throws {
        guard let candidate = components(candidateMinimumOSVersion) else {
            throw HostOSVersionPolicyError.malformedCandidateMinimumOSVersion
        }
        guard let hostProductVersion else {
            throw HostOSVersionPolicyError.hostProductVersionUnavailable
        }
        guard let host = components(hostProductVersion) else {
            throw HostOSVersionPolicyError.malformedHostProductVersion
        }
        guard !host.lexicographicallyPrecedes(candidate) else {
            throw HostOSVersionPolicyError.candidateRequiresNewerOS
        }
    }

    public static func isValidNumericVersion(_ value: String) -> Bool {
        components(value) != nil
    }

    private static func components(_ value: String) -> [UInt64]? {
        guard !value.isEmpty, value.utf8.count <= 64 else { return nil }
        let fields = value.split(separator: ".", omittingEmptySubsequences: false)
        guard fields.count == 2 || fields.count == 3 else { return nil }
        var result: [UInt64] = []
        result.reserveCapacity(3)
        for field in fields {
            guard !field.isEmpty,
                  field.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }),
                  (field.count == 1 || field.first != "0"),
                  let component = UInt64(field)
            else {
                return nil
            }
            result.append(component)
        }
        if result.count == 2 { result.append(0) }
        return result
    }
}
