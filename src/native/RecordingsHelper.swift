import Cocoa
import Carbon

// ── RecordingsHelper ────────────────────────────────────────────────────────
// Lightweight menu bar app that toggles speech recording with a global hotkey.
// Press the hotkey to start recording, press again to stop + transcribe + paste.
// Works like Wispr Flow — no UI chrome, just a menu bar icon and a hotkey.

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var isRecording = false
    var recordProcess: Process?
    var currentAudioPath: String?
    var hotkeyRef: EventHotKeyRef?
    var spaceDownTime: Date?
    var longPressTimer: Timer?
    let longPressDuration: TimeInterval = 1.0  // Hold space for 1 second to activate

    let recordingsDir: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let newDir = "\(home)/.hasna/recordings"
        let oldDir = "\(home)/.recordings"
        // Auto-migrate from old location
        if !FileManager.default.fileExists(atPath: newDir) && FileManager.default.fileExists(atPath: oldDir) {
            try? FileManager.default.createDirectory(atPath: "\(home)/.hasna", withIntermediateDirectories: true)
            try? FileManager.default.copyItem(atPath: oldDir, toPath: newDir)
        }
        return newDir
    }()

    let audioDir: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.hasna/recordings/audio"
    }()

    let recordingsBin: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.bun/bin/recordings"
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Create audio dir
        try? FileManager.default.createDirectory(atPath: audioDir, withIntermediateDirectories: true)

        // Menu bar icon
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateIcon()

        // Menu
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Hold Space (1s) to Record", action: #selector(toggleRecording), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        statusItem.menu = menu

        // Register global hotkey: F5
        registerHotkey()

        showNotification(title: "Recordings", body: "Ready — hold Space for 1s to record")
    }

    func updateIcon() {
        if let button = statusItem.button {
            button.title = isRecording ? "⏺" : "🎙"
        }
    }

    // ── Global Hotkey ───────────────────────────────────────────────────────

    /// Check if Accessibility permission is granted. If not, show a dialog and open System Settings.
    func checkAccessibilityPermission() -> Bool {
        // First check without prompting
        let trusted = AXIsProcessTrustedWithOptions(
            [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): false] as CFDictionary
        )
        if trusted { return true }

        // Not trusted — show dialog explaining why we need it
        let alert = NSAlert()
        alert.messageText = "Accessibility Permission Required"
        alert.informativeText = "RecordingsHelper needs Accessibility access to detect the global hotkey (hold Space to record).\n\nClick 'Open Settings' to grant permission, then restart the app."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Open Settings")
        alert.addButton(withTitle: "Quit")

        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            // Prompt the system dialog AND open System Settings > Accessibility
            AXIsProcessTrustedWithOptions(
                [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
            )
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                NSWorkspace.shared.open(url)
            }
        } else {
            NSApplication.shared.terminate(nil)
        }
        return false
    }

    func registerHotkey() {
        // Hold Space for 1+ second to start recording, release to stop.
        // Uses CGEventTap to monitor all keyboard events globally.
        // Normal space presses (< 1 second) pass through untouched.

        // Check Accessibility permission BEFORE attempting event tap
        if !checkAccessibilityPermission() {
            return
        }

        let eventMask: CGEventMask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue)

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: eventMask,
            callback: { (proxy, type, event, refcon) -> Unmanaged<CGEvent>? in
                let appDelegate = Unmanaged<AppDelegate>.fromOpaque(refcon!).takeUnretainedValue()
                let keyCode = event.getIntegerValueField(.keyboardEventKeycode)

                // Space bar = keycode 49
                guard keyCode == 49 else {
                    return Unmanaged.passRetained(event)
                }

                if type == .keyDown {
                    // Ignore key repeat events (auto-repeat while held)
                    let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat)
                    if isRepeat != 0 {
                        // Already tracking this press — suppress the repeat
                        if appDelegate.spaceDownTime != nil {
                            return nil  // Swallow repeat while we're tracking
                        }
                        return Unmanaged.passRetained(event)
                    }

                    if appDelegate.spaceDownTime == nil {
                        appDelegate.spaceDownTime = Date()
                        // Start a timer — if space is still held after 1s, begin recording
                        DispatchQueue.main.async {
                            appDelegate.longPressTimer?.invalidate()
                            appDelegate.longPressTimer = Timer.scheduledTimer(withTimeInterval: appDelegate.longPressDuration, repeats: false) { _ in
                                if appDelegate.spaceDownTime != nil && !appDelegate.isRecording {
                                    appDelegate.startRecording()
                                }
                            }
                        }
                    }
                    // Let the keyDown through for now (normal typing)
                    return Unmanaged.passRetained(event)

                } else if type == .keyUp {
                    let wasLongPress = appDelegate.isRecording

                    if appDelegate.isRecording {
                        // Space released after recording — stop and transcribe
                        DispatchQueue.main.async {
                            appDelegate.stopAndTranscribe()
                        }
                    }

                    // Cancel timer
                    DispatchQueue.main.async {
                        appDelegate.longPressTimer?.invalidate()
                        appDelegate.longPressTimer = nil
                    }
                    appDelegate.spaceDownTime = nil

                    if wasLongPress {
                        // Swallow the keyUp so it doesn't type a space
                        return nil
                    }
                    return Unmanaged.passRetained(event)
                }

                return Unmanaged.passRetained(event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            showNotification(title: "Error", body: "Could not create event tap. Grant Accessibility permission in System Settings > Privacy > Accessibility")
            return
        }

        let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    // ── Recording ────────────────────────────────────────────────────────────

    @objc func toggleRecording() {
        if isRecording { stopAndTranscribe() } else { startRecording() }
    }

    func startRecording() {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd'T'HHmmss"
        let filename = "recording-\(formatter.string(from: Date())).wav"
        let filepath = "\(audioDir)/\(filename)"
        currentAudioPath = filepath

        // Run ffmpeg via bash — pipe stdin so we can send 'q' to stop gracefully
        let process = Process()
        let stdinPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = ["-c", """
            export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
            if command -v ffmpeg &>/dev/null; then
                ffmpeg -f avfoundation -i ":0" -ar 16000 -ac 1 -t 300 "\(filepath)" -y 2>/dev/null
            elif command -v rec &>/dev/null; then
                rec -r 16000 -c 1 -b 16 "\(filepath)" trim 0 300
            else
                exit 1
            fi
        """]
        process.standardInput = stdinPipe
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            recordProcess = process
            stdinPipeRef = stdinPipe
            isRecording = true
            updateIcon()
            showNotification(title: "Recording...", body: "Press F5 to stop")
        } catch {
            showNotification(title: "Error", body: "Could not start recording: \(error.localizedDescription)")
        }
    }

    var stdinPipeRef: Pipe?

    func stopAndTranscribe() {
        guard let process = recordProcess else { return }

        // Send 'q' to ffmpeg stdin for graceful stop (flushes WAV header)
        if let pipe = stdinPipeRef {
            pipe.fileHandleForWriting.write("q".data(using: .utf8)!)
            try? pipe.fileHandleForWriting.close()
        }
        // Wait for graceful exit, then force if needed
        Thread.sleep(forTimeInterval: 1.0)
        if process.isRunning {
            process.terminate()
            Thread.sleep(forTimeInterval: 0.3)
        }
        if process.isRunning {
            process.interrupt()
        }
        recordProcess = nil
        stdinPipeRef = nil
        isRecording = false
        updateIcon()

        guard let audioPath = currentAudioPath else { return }
        currentAudioPath = nil

        // Check if audio file exists and has content
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: audioPath) else {
            showNotification(title: "Error", body: "Audio file not created — check mic permissions")
            return
        }

        let attrs = try? fileManager.attributesOfItem(atPath: audioPath)
        let size = attrs?[.size] as? Int ?? 0
        if size < 1000 {
            showNotification(title: "Error", body: "Audio too short (\(size) bytes) — try speaking longer")
            return
        }

        showNotification(title: "Transcribing...", body: "Processing your recording")

        // Transcribe in background
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let output = self.runCommand(self.recordingsBin, arguments: ["transcribe", audioPath, "--json"])

            // The CLI outputs "Transcribing...\n" then the text, then JSON on --json
            // Find the JSON object in the output
            var text = ""

            // Try to find JSON in the output
            if let jsonStart = output.range(of: "{"),
               let jsonEnd = output.range(of: "}", options: .backwards) {
                let jsonStr = String(output[jsonStart.lowerBound...jsonEnd.upperBound])
                if let data = jsonStr.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if let pt = json["processed_text"] as? String, !pt.isEmpty {
                        text = pt
                    } else if let rt = json["raw_text"] as? String, !rt.isEmpty {
                        text = rt
                    }
                }
            }

            // Fallback: grab everything after the last newline before JSON
            if text.isEmpty {
                let lines = output.components(separatedBy: "\n").filter { !$0.isEmpty && !$0.contains("Transcribing") && !$0.contains("{") }
                for line in lines {
                    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty && !trimmed.hasPrefix("Saved") {
                        text = trimmed
                        break
                    }
                }
            }

            guard !text.isEmpty else {
                DispatchQueue.main.async {
                    let dbg = output.prefix(200)
                    self.showNotification(title: "Error", body: "Empty transcription. Output: \(dbg)")
                }
                return
            }

            DispatchQueue.main.async {
                // Copy to clipboard
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                pasteboard.setString(text, forType: .string)

                // Auto-paste into the frontmost app (like Wispr Flow)
                self.simulatePaste()

                self.showNotification(title: "Done", body: String(text.prefix(80)))
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    func simulatePaste() {
        // Simulate Cmd+V
        let source = CGEventSource(stateID: .hidSystemState)

        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: true) // V key
        keyDown?.flags = .maskCommand
        keyDown?.post(tap: .cghidEventTap)

        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: false)
        keyUp?.flags = .maskCommand
        keyUp?.post(tap: .cghidEventTap)
    }

    func runCommand(_ command: String, arguments: [String]) -> String {
        let process = Process()
        let pipe = Pipe()
        let errPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let args = arguments.map { "\"\($0)\"" }.joined(separator: " ")
        process.arguments = ["-c", """
            export PATH="\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
            "\(command)" \(args)
        """]
        process.standardOutput = pipe
        process.standardError = errPipe

        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            return "ERROR: \(error.localizedDescription)"
        }
    }

    func showNotification(title: String, body: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", "display notification \"\(body)\" with title \"\(title)\""]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
    }

    @objc func quit() {
        if let process = recordProcess {
            process.interrupt()
        }
        NSApplication.shared.terminate(nil)
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // Menu bar only, no dock icon
let delegate = AppDelegate()
app.delegate = delegate
app.run()
