import Foundation

public struct PermissionRequestLaunchPlan: Sendable, Equatable {
    public let isHelper: Bool
    public let opensPermissionSettings: Bool

    public var installsGlobalHandlers: Bool { !isHelper }
    public var declaresMainWindow: Bool { !isHelper }
    public var terminatesAfterHandling: Bool { isHelper }

    public init(arguments: [String]) {
        isHelper = arguments.contains("--request-permissions")
        opensPermissionSettings = isHelper && arguments.contains("--open-permission-settings")
    }
}
