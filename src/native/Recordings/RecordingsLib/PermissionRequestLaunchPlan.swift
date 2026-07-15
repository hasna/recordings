import Foundation

public struct PermissionRequestLaunchPlan: Sendable, Equatable {
    public let isHelper: Bool
    public let opensPermissionSettings: Bool
    public let runtimeSmokeMode: String?
    public let runtimeSmokeOutputPath: String?

    public var isRuntimeSmoke: Bool { runtimeSmokeMode != nil }
    public var installsGlobalHandlers: Bool { !isHelper && !isRuntimeSmoke }
    public var declaresMainWindow: Bool { !isHelper && !isRuntimeSmoke }
    public var declaresMenuBar: Bool {
        if isRuntimeSmoke { return runtimeSmokeMode == "normal" }
        return !isHelper
    }
    public var terminatesAfterHandling: Bool { isHelper }
    public var requestsAccessibilityPrompt: Bool { isHelper && !isRuntimeSmoke }

    public init(arguments: [String]) {
        isHelper = arguments.contains("--request-permissions")
        opensPermissionSettings = isHelper && arguments.contains("--open-permission-settings")
        runtimeSmokeMode = Self.optionValue("--runtime-smoke", arguments: arguments)
        runtimeSmokeOutputPath = Self.optionValue("--runtime-smoke-output", arguments: arguments)
    }

    private static func optionValue(_ name: String, arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }
}

public struct PermissionRequestOutcome: Sendable, Equatable {
    public let microphoneGranted: Bool
    public let accessibilityTrusted: Bool

    public init(microphoneGranted: Bool, accessibilityTrusted: Bool) {
        self.microphoneGranted = microphoneGranted
        self.accessibilityTrusted = accessibilityTrusted
    }

    public var succeeded: Bool {
        microphoneGranted && accessibilityTrusted
    }
}
