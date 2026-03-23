import Cocoa

/// Monitors the fn/Globe key using CGEventTap.
/// Based on the proven pattern from CustomWispr (open-source WisprFlow alternative).
/// User must set System Settings > Keyboard > "Press fn key to: Do Nothing" for this to work.
final class FnKeyMonitor: @unchecked Sendable {
    var onFnKeyDown: (() -> Void)?
    var onFnKeyUp: (() -> Void)?

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var healthCheckTimer: Timer?
    private var fnIsDown = false

    private static let fnKeyCode: UInt16 = 63
    private static let fnFlagMask: UInt64 = 0x800000

    /// Start monitoring. Returns true if successful.
    func start() -> Bool {
        guard eventTap == nil else {
            fputs("[FnKeyMonitor] Already running\n", stderr)
            return true
        }

        fputs("[FnKeyMonitor] Creating event tap...\n", stderr)
        let eventMask: CGEventMask = (1 << CGEventType.flagsChanged.rawValue)

        // passRetained so the callback reference stays alive
        let selfPtr = Unmanaged.passRetained(self).toOpaque()

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: eventMask,
            callback: { (proxy, type, event, refcon) -> Unmanaged<CGEvent>? in
                guard let refcon = refcon else { return Unmanaged.passRetained(event) }
                let monitor = Unmanaged<FnKeyMonitor>.fromOpaque(refcon).takeUnretainedValue()
                return monitor.handleEvent(type: type, event: event)
            },
            userInfo: selfPtr
        ) else {
            Unmanaged<FnKeyMonitor>.fromOpaque(selfPtr).release()
            return false
        }

        self.eventTap = tap

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        self.runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        fputs("[FnKeyMonitor] Event tap created and enabled OK\n", stderr)

        // Health check: macOS silently disables taps — re-enable every 3 seconds
        healthCheckTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            guard let self = self, let tap = self.eventTap else { return }
            if !CGEvent.tapIsEnabled(tap: tap) {
                fputs("[FnKeyMonitor] Tap was disabled, re-enabling\n", stderr)
                CGEvent.tapEnable(tap: tap, enable: true)
            }
        }

        return true
    }

    func stop() {
        healthCheckTimer?.invalidate()
        healthCheckTimer = nil

        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
        }
        eventTap = nil
        runLoopSource = nil
        fnIsDown = false
    }

    private func handleEvent(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        // Re-enable if macOS disabled the tap
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = eventTap {
                CGEvent.tapEnable(tap: tap, enable: true)
            }
            return Unmanaged.passRetained(event)
        }

        let keyCode = UInt16(event.getIntegerValueField(.keyboardEventKeycode))

        // Only handle fn key (keyCode 63)
        guard keyCode == FnKeyMonitor.fnKeyCode else {
            return Unmanaged.passRetained(event)
        }

        let flags = event.flags.rawValue
        let fnPressed = (flags & FnKeyMonitor.fnFlagMask) != 0

        fputs("[FnKeyMonitor] flagsChanged keyCode=\(keyCode) flags=0x\(String(flags, radix: 16)) fnPressed=\(fnPressed) fnIsDown=\(fnIsDown)\n", stderr)

        if fnPressed && !fnIsDown {
            // fn just pressed
            fnIsDown = true
            fputs("[FnKeyMonitor] fn DOWN — starting recording\n", stderr)
            DispatchQueue.main.async { [weak self] in
                self?.onFnKeyDown?()
            }
            return nil // Swallow — prevents emoji picker / language switch
        } else if !fnPressed && fnIsDown {
            // fn released
            fnIsDown = false
            DispatchQueue.main.async { [weak self] in
                self?.onFnKeyUp?()
            }
            return nil // Swallow release too
        }

        return Unmanaged.passRetained(event)
    }
}
