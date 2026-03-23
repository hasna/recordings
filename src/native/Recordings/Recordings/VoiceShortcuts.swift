import SwiftUI

// MARK: - Voice Shortcut

struct VoiceShortcut: Identifiable, Codable {
    let id: UUID
    var trigger: String   // e.g. "add disclaimer"
    var content: String   // text to insert when trigger is spoken

    init(trigger: String, content: String) {
        self.id = UUID()
        self.trigger = trigger
        self.content = content
    }
}

// MARK: - Voice Shortcuts Manager

@MainActor
final class VoiceShortcuts: ObservableObject {
    @Published var shortcuts: [VoiceShortcut] = []

    private let storageURL: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent(".hasna/recordings/voice-shortcuts.json")
    }()

    init() {
        load()
    }

    func add(trigger: String, content: String) {
        let shortcut = VoiceShortcut(trigger: trigger, content: content)
        shortcuts.append(shortcut)
        save()
    }

    func remove(at offsets: IndexSet) {
        shortcuts.remove(atOffsets: offsets)
        save()
    }

    func update(_ shortcut: VoiceShortcut) {
        if let index = shortcuts.firstIndex(where: { $0.id == shortcut.id }) {
            shortcuts[index] = shortcut
            save()
        }
    }

    /// Check if transcribed text matches a voice shortcut trigger.
    /// Returns the content to paste if matched, nil otherwise.
    func match(_ text: String) -> String? {
        let lower = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        for shortcut in shortcuts {
            if lower.contains(shortcut.trigger.lowercased()) {
                return shortcut.content
            }
        }
        return nil
    }

    // MARK: - Persistence

    private func save() {
        do {
            let data = try JSONEncoder().encode(shortcuts)
            try data.write(to: storageURL, options: .atomic)
        } catch {
            print("Failed to save voice shortcuts: \(error)")
        }
    }

    private func load() {
        guard FileManager.default.fileExists(atPath: storageURL.path) else { return }
        do {
            let data = try Data(contentsOf: storageURL)
            shortcuts = try JSONDecoder().decode([VoiceShortcut].self, from: data)
        } catch {
            print("Failed to load voice shortcuts: \(error)")
        }
    }
}
