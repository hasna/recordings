import Foundation
import Testing

@testable import RecordingsUpdateProtocol

/// The XPC allowlist is the decoding trust boundary for the privileged updater, so these
/// assert the *exact* set installed for every argument rather than a subset. A set that
/// grew silently would widen what the broker is willing to decode; a set that shrank
/// would reject legitimate replies. Either direction should fail the build.
///
/// Membership is compared by class name because Objective-C class objects cannot be cast
/// to `AnyHashable` in Swift — `NSDictionary.self as! AnyHashable` traps at runtime.
struct UpdateXPCInterfaceTests {
    private static let installSelector =
        NSSelectorFromString("installWithArchive:manifest:envelope:reply:")
    private static let statusSelector = NSSelectorFromString("queryStatusWithReply:")

    private func allowedClassNames(
        _ interface: NSXPCInterface,
        selector: Selector,
        argumentIndex: Int,
        ofReply: Bool
    ) -> Set<String> {
        let classes = interface.classes(for: selector, argumentIndex: argumentIndex, ofReply: ofReply)
        return Set(classes.compactMap { ($0 as? AnyClass).map { NSStringFromClass($0) } })
    }

    @Test("every install request argument accepts only a file handle")
    func installRequestAcceptsOnlyFileHandles() {
        let interface = makeRecordingsUpdateXPCInterface()
        for index in 0..<3 {
            let allowed = allowedClassNames(
                interface,
                selector: Self.installSelector,
                argumentIndex: index,
                ofReply: false
            )
            #expect(allowed == ["NSFileHandle"], "install request argument \(index)")
        }
    }

    @Test("install and status replies accept only scalar dictionaries")
    func repliesAcceptOnlyScalarDictionaries() {
        let interface = makeRecordingsUpdateXPCInterface()
        let expected: Set<String> = ["NSDictionary", "NSString", "NSNumber"]
        for selector in [Self.installSelector, Self.statusSelector] {
            let allowed = allowedClassNames(
                interface,
                selector: selector,
                argumentIndex: 0,
                ofReply: true
            )
            #expect(allowed == expected, "reply allowlist for \(selector)")
        }
    }

    @Test("the reply allowlist admits no container beyond the dictionary itself")
    func replyAllowlistExcludesNestedContainers() {
        let interface = makeRecordingsUpdateXPCInterface()
        let allowed = allowedClassNames(
            interface,
            selector: Self.statusSelector,
            argumentIndex: 0,
            ofReply: true
        )
        for rejected in ["NSArray", "NSData", "NSURL", "NSValue", "NSSet"] {
            #expect(!allowed.contains(rejected), "\(rejected) must not be decodable in a reply")
        }
    }

    @Test("every value the reply builders emit is covered by the allowlist")
    func replyBuildersEmitOnlyAllowlistedClasses() {
        let interface = makeRecordingsUpdateXPCInterface()
        let allowed = allowedClassNames(
            interface,
            selector: Self.statusSelector,
            argumentIndex: 0,
            ofReply: true
        )
        let replies = [
            updateSuccessReply(
                transactionID: "t-1",
                releaseID: "r-1",
                installedVersion: "0.2.15"
            ),
            updateFailureReply(.invalidEnvelope, message: "rejected"),
        ]
        for reply in replies {
            #expect(allowed.contains(NSStringFromClass(type(of: reply))) || reply is NSDictionary)
            for (key, value) in reply as? [AnyHashable: Any] ?? [:] {
                // Keys and values both cross the boundary and both must be allowlisted.
                let keyClass = NSStringFromClass(type(of: key as AnyObject))
                let valueClass = NSStringFromClass(type(of: value as AnyObject))
                #expect(
                    allowed.contains(keyClass) || keyClass.hasSuffix("String"),
                    "reply key class \(keyClass) is not allowlisted"
                )
                #expect(
                    allowed.contains(valueClass)
                        || valueClass.hasSuffix("String")
                        || valueClass.hasSuffix("Number")
                        || valueClass.hasSuffix("Boolean"),
                    "reply value class \(valueClass) is not allowlisted"
                )
            }
        }
    }
}
