#!/usr/bin/env swift
// Quick test: can we see fn key events via CGEventTap?
import Cocoa

print("Listening for ALL key events for 15 seconds...")
print("Press fn, F5, Option, or any key. Ctrl+C to quit.\n")

let mask: CGEventMask =
    (1 << CGEventType.flagsChanged.rawValue) |
    (1 << CGEventType.keyDown.rawValue) |
    (1 << CGEventType.keyUp.rawValue)

let callback: CGEventTapCallBack = { proxy, type, event, refcon in
    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    let flags = event.flags

    if type == .flagsChanged {
        let fn = flags.contains(.maskSecondaryFn) ? " [fn]" : ""
        let cmd = flags.contains(.maskCommand) ? " [cmd]" : ""
        let opt = flags.contains(.maskAlternate) ? " [opt]" : ""
        let ctrl = flags.contains(.maskControl) ? " [ctrl]" : ""
        let shift = flags.contains(.maskShift) ? " [shift]" : ""
        print("flagsChanged  keyCode=\(keyCode)\(fn)\(cmd)\(opt)\(ctrl)\(shift)")
    } else if type == .keyDown {
        print("keyDown       keyCode=\(keyCode)")
    } else if type == .keyUp {
        print("keyUp         keyCode=\(keyCode)")
    } else if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        print("TAP DISABLED — re-enabling")
        if let refcon {
            let tap = Unmanaged<AnyObject>.fromOpaque(refcon).takeUnretainedValue() as! CFMachPort
            CGEvent.tapEnable(tap: tap, enable: true)
        }
    }

    return Unmanaged.passRetained(event)
}

// Try HID-level tap first
var tap = CGEvent.tapCreate(
    tap: .cghidEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: mask,
    callback: callback,
    userInfo: nil
)

if tap == nil {
    print("⚠ cghidEventTap failed, trying cgSessionEventTap...")
    tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .defaultTap,
        eventsOfInterest: mask,
        callback: callback,
        userInfo: nil
    )
}

guard let tap else {
    print("❌ FAILED to create event tap. Grant Accessibility permission:")
    print("   System Settings > Privacy & Security > Accessibility")
    exit(1)
}

print("✅ Event tap created successfully\n")

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

// Run for 15 seconds
DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
    print("\nDone.")
    exit(0)
}

CFRunLoopRun()
