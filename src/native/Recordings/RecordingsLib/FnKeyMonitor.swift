import Cocoa

/// Monitors the fn/Globe key using CGEventTap.
/// Fn is exposed as a modifier flag, so we watch flagsChanged events and
/// check CGEventFlags.maskSecondaryFn rather than relying on a raw bit mask.
final class FnKeyMonitor: @unchecked Sendable {
    var onFnKeyDown: (() -> Void)?
    var onFnKeyUp: (() -> Void)?

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var healthCheckTimer: Timer?
    private var fnIsDown = false

    private static let fnKeyCode: UInt16 = 63

    /// Start monitoring. Returns true if successful.
    func start() -> Bool {
        guard eventTap == nil else {
            fputs("[FnKeyMonitor] Already running\n", stderr)
            return true
        }

        let eventMask: CGEventMask = 1 << CGEventType.flagsChanged.rawValue
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let candidates: [(CGEventTapLocation, CGEventTapPlacement, String)] = [
            (.cgAnnotatedSessionEventTap, .tailAppendEventTap, "annotated-session/tail"),
            (.cgSessionEventTap, .tailAppendEventTap, "session/tail"),
            (.cghidEventTap, .headInsertEventTap, "hid/head"),
        ]

        for (tapLocation, tapPlacement, label) in candidates {
            fputs("[FnKeyMonitor] Trying event tap: \(label)\n", stderr)

            guard let tap = CGEvent.tapCreate(
                tap: tapLocation,
                place: tapPlacement,
                options: .defaultTap,
                eventsOfInterest: eventMask,
                callback: { _, type, event, refcon -> Unmanaged<CGEvent>? in
                    guard let refcon else { return Unmanaged.passRetained(event) }
                    let monitor = Unmanaged<FnKeyMonitor>.fromOpaque(refcon).takeUnretainedValue()
                    return monitor.handleEvent(type: type, event: event)
                },
                userInfo: selfPtr
            ) else {
                continue
            }

            eventTap = tap
            runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            if let runLoopSource {
                CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
            }
            CGEvent.tapEnable(tap: tap, enable: true)
            fputs("[FnKeyMonitor] Event tap ready: \(label)\n", stderr)

            // Health check: macOS can silently disable taps — re-enable every 3 seconds.
            healthCheckTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
                guard let self, let tap = self.eventTap else { return }
                if !CGEvent.tapIsEnabled(tap: tap) {
                    fputs("[FnKeyMonitor] Tap was disabled, re-enabling\n", stderr)
                    CGEvent.tapEnable(tap: tap, enable: true)
                }
            }

            return true
        }

        fputs("[FnKeyMonitor] Failed to create any event tap\n", stderr)
        return false
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
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = eventTap {
                CGEvent.tapEnable(tap: tap, enable: true)
            }
            return Unmanaged.passRetained(event)
        }

        guard type == .flagsChanged else {
            return Unmanaged.passRetained(event)
        }

        let keyCode = UInt16(event.getIntegerValueField(.keyboardEventKeycode))
        let fnPressed = event.flags.contains(.maskSecondaryFn)
        let isFnTransition = keyCode == FnKeyMonitor.fnKeyCode || fnPressed || fnIsDown

        guard isFnTransition else {
            return Unmanaged.passRetained(event)
        }

        let flags = event.flags.rawValue
        fputs("[FnKeyMonitor] flagsChanged keyCode=\(keyCode) flags=0x\(String(flags, radix: 16)) fnPressed=\(fnPressed) fnIsDown=\(fnIsDown)\n", stderr)

        if fnPressed && !fnIsDown {
            fnIsDown = true
            fputs("[FnKeyMonitor] fn DOWN — starting recording\n", stderr)
            DispatchQueue.main.async { [weak self] in
                self?.onFnKeyDown?()
            }
            return nil
        }

        if !fnPressed && fnIsDown {
            fnIsDown = false
            DispatchQueue.main.async { [weak self] in
                self?.onFnKeyUp?()
            }
            return nil
        }

        return Unmanaged.passRetained(event)
    }
}
