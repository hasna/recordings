import Foundation

enum OpenAIAPIKeyStore {
    static let defaultLanguage = "en"

    static func load(
        homePath: String,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        userDefaultKey: String? = UserDefaults.standard.string(forKey: "openAIAPIKey")
    ) -> String {
        if let key = firstNonEmpty(environment["OPENAI_API_KEY"], environment["RECORDINGS_API_KEY"]) {
            return key
        }
        if let key = firstNonEmpty(userDefaultKey) {
            return key
        }
        if let key = loadConfigKey(homePath: homePath, environment: environment) {
            return key
        }
        if let key = loadSecretKey(homePath: homePath) {
            return key
        }
        return ""
    }

    static func loadLanguage(
        homePath: String,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        userDefaultLanguage: String? = UserDefaults.standard.string(forKey: "recordingsLanguage")
    ) -> String {
        if let language = firstNonEmpty(environment["RECORDINGS_LANGUAGE"]) {
            return normalizedStoredLanguage(language)
        }
        if let language = firstNonEmpty(userDefaultLanguage) {
            return normalizedStoredLanguage(language)
        }
        if let language = loadConfigValue(homePath: homePath, key: "language", environment: environment) {
            return normalizedStoredLanguage(language)
        }
        return defaultLanguage
    }

    /// Persist the key into ~/.hasna/recordings/config.json so the CLI (which the app
    /// shells out to for final transcription) uses the same key as the app itself.
    static func save(key: String, homePath: String) throws {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let dir = URL(fileURLWithPath: homePath)
            .appendingPathComponent(".hasna")
            .appendingPathComponent("recordings")
        let url = dir.appendingPathComponent("config.json")

        var json: [String: Any] = [:]
        if let data = try? Data(contentsOf: url),
           let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            json = existing
        }

        if trimmed.isEmpty {
            json.removeValue(forKey: "openai_api_key")
        } else {
            json["openai_api_key"] = trimmed
        }

        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    }

    static func saveLanguage(language: String, homePath: String) throws {
        let normalized = normalizedStoredLanguage(language)
        var json = loadMutableConfig(homePath: homePath)

        if apiLanguageHint(for: normalized).isEmpty {
            json.removeValue(forKey: "language")
        } else {
            json["language"] = normalized
        }

        try writeConfig(json, homePath: homePath)
    }

    static func apiLanguageHint(for storedLanguage: String) -> String {
        let normalized = normalizedStoredLanguage(storedLanguage)
        return normalized == "auto" ? "" : normalized
    }

    private static func loadConfigKey(homePath: String, environment: [String: String]) -> String? {
        for key in ["openai_api_key", "api_key"] {
            if let resolved = loadConfigValue(homePath: homePath, key: key, environment: environment) {
                return resolved
            }
        }
        return nil
    }

    private static func loadConfigValue(homePath: String, key: String, environment: [String: String]) -> String? {
        let json = loadMutableConfig(homePath: homePath)
        guard let value = json[key] as? String else { return nil }
        return resolve(value: value, environment: environment)
    }

    private static func loadMutableConfig(homePath: String) -> [String: Any] {
        let url = configURL(homePath: homePath)
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return json
    }

    private static func writeConfig(_ json: [String: Any], homePath: String) throws {
        let url = configURL(homePath: homePath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    }

    private static func configURL(homePath: String) -> URL {
        URL(fileURLWithPath: homePath)
            .appendingPathComponent(".hasna")
            .appendingPathComponent("recordings")
            .appendingPathComponent("config.json")
    }

    private static func loadSecretKey(homePath: String) -> String? {
        let root = URL(fileURLWithPath: homePath).appendingPathComponent(".secrets")
        let fileManager = FileManager.default
        guard let enumerator = fileManager.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return nil }

        for case let url as URL in enumerator {
            guard url.pathExtension == "env",
                  let values = try? parseEnvFile(url: url)
            else { continue }

            if let key = firstNonEmpty(values["RECORDINGS_API_KEY"], values["OPENAI_API_KEY"]) {
                return key
            }
        }
        return nil
    }

    private static func parseEnvFile(url: URL) throws -> [String: String] {
        let content = try String(contentsOf: url, encoding: .utf8)
        var values: [String: String] = [:]

        for rawLine in content.split(whereSeparator: \.isNewline) {
            var line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            if line.hasPrefix("export ") {
                line.removeFirst("export ".count)
            }

            let parts = line.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { continue }

            let key = parts[0].trimmingCharacters(in: .whitespacesAndNewlines)
            let value = stripQuotes(String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines))
            values[key] = value
        }

        return values
    }

    private static func resolve(value: String, environment: [String: String]) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("$"), trimmed.count > 1 {
            return firstNonEmpty(environment[String(trimmed.dropFirst())])
        }
        return trimmed
    }

    private static func stripQuotes(_ value: String) -> String {
        guard value.count >= 2 else { return value }
        if (value.hasPrefix("\"") && value.hasSuffix("\"")) ||
            (value.hasPrefix("'") && value.hasSuffix("'")) {
            return String(value.dropFirst().dropLast())
        }
        return value
    }

    private static func normalizedStoredLanguage(_ language: String) -> String {
        let trimmed = language.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? defaultLanguage : trimmed
    }

    private static func firstNonEmpty(_ values: String?...) -> String? {
        for value in values {
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        return nil
    }
}
