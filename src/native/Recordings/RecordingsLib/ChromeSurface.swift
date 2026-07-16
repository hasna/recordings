import Foundation

/// Deterministic surface contract for glass-capable chrome (the record hero, glass panels).
/// When the user enables Reduce Transparency, chrome must render on an opaque, fully
/// readable surface — never a translucent material, which still composites content from
/// behind the window. Views resolve their surface through this single function so the
/// accessibility behavior is a testable state contract rather than per-view convention.
public enum ChromeSurface: Equatable, Sendable {
    /// Liquid Glass — only while transparency effects are allowed.
    case liquidGlass
    /// Opaque window-background surface with a hairline border, honoring Reduce Transparency.
    case opaque

    public static func forReducedTransparency(_ reduceTransparency: Bool) -> ChromeSurface {
        reduceTransparency ? .opaque : .liquidGlass
    }
}
