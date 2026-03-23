#!/usr/bin/env swift
// Test: NSEvent.addGlobalMonitorForEvents — does it see fn key?
import Cocoa

print("Testing NSEvent global monitor for 15 seconds...")
print("Press fn, Option, any key. Ctrl+C to quit.\n")

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Monitor flagsChanged (modifier keys including fn)
NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged, .keyDown, .keyUp]) { event in
    if event.type == .flagsChanged {
        let fn = event.modifierFlags.contains(.function) ? " [fn]" : ""
        let cmd = event.modifierFlags.contains(.command) ? " [cmd]" : ""
        let opt = event.modifierFlags.contains(.option) ? " [opt]" : ""
        let ctrl = event.modifierFlags.contains(.control) ? " [ctrl]" : ""
        print("flagsChanged  keyCode=\(event.keyCode)\(fn)\(cmd)\(opt)\(ctrl)")
    } else if event.type == .keyDown {
        print("keyDown       keyCode=\(event.keyCode)  chars=\(event.characters ?? "")")
    } else if event.type == .keyUp {
        print("keyUp         keyCode=\(event.keyCode)")
    }
}

print("✅ Global monitor registered\n")

DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
    print("\nDone.")
    exit(0)
}

app.run()
