import Foundation

enum OpenAIAPIKeyStore {
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

    private static func loadConfigKey(homePath: String, environment: [String: String]) -> String? {
        let url = URL(fileURLWithPath: homePath)
            .appendingPathComponent(".hasna")
            .appendingPathComponent("recordings")
            .appendingPathComponent("config.json")

        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }

        for key in ["openai_api_key", "api_key"] {
            guard let value = json[key] as? String,
                  let resolved = resolve(value: value, environment: environment)
            else { continue }
            return resolved
        }
        return nil
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
