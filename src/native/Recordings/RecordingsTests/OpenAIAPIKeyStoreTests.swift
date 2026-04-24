import Foundation
import Testing
@testable import RecordingsLib

struct OpenAIAPIKeyStoreTests {
    @Test("Environment key has highest priority")
    func environmentKeyWins() {
        let key = OpenAIAPIKeyStore.load(
            homePath: "/tmp/recordings-missing-home",
            environment: ["OPENAI_API_KEY": "env-key"],
            userDefaultKey: "stored-key"
        )
        #expect(key == "env-key")
    }

    @Test("User default key is used before config file")
    func userDefaultKeyWins() throws {
        let home = try makeHome()
        try writeConfig(home: home, ["openai_api_key": "config-key"])

        let key = OpenAIAPIKeyStore.load(
            homePath: home.path,
            environment: [:],
            userDefaultKey: "stored-key"
        )
        #expect(key == "stored-key")
    }

    @Test("Config file key is loaded from installed app data")
    func configFileKey() throws {
        let home = try makeHome()
        try writeConfig(home: home, ["openai_api_key": "config-key"])

        let key = OpenAIAPIKeyStore.load(
            homePath: home.path,
            environment: [:],
            userDefaultKey: nil
        )
        #expect(key == "config-key")
    }

    @Test("Config file can reference environment variable")
    func configEnvReference() throws {
        let home = try makeHome()
        try writeConfig(home: home, ["openai_api_key": "$RECORDINGS_API_KEY"])

        let key = OpenAIAPIKeyStore.load(
            homePath: home.path,
            environment: ["RECORDINGS_API_KEY": "referenced-key"],
            userDefaultKey: nil
        )
        #expect(key == "referenced-key")
    }

    @Test("Secrets env files are searched recursively")
    func recursiveSecrets() throws {
        let home = try makeHome()
        let secretDir = home
            .appendingPathComponent(".secrets")
            .appendingPathComponent("hasnaxyz")
            .appendingPathComponent("openai")
        try FileManager.default.createDirectory(at: secretDir, withIntermediateDirectories: true)
        try "export OPENAI_API_KEY='secret-key'\n".write(
            to: secretDir.appendingPathComponent("live.env"),
            atomically: true,
            encoding: .utf8
        )

        let key = OpenAIAPIKeyStore.load(
            homePath: home.path,
            environment: [:],
            userDefaultKey: nil
        )
        #expect(key == "secret-key")
    }

    private func makeHome() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordings-key-store-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func writeConfig(home: URL, _ config: [String: String]) throws {
        let configDir = home
            .appendingPathComponent(".hasna")
            .appendingPathComponent("recordings")
        try FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted])
        try data.write(to: configDir.appendingPathComponent("config.json"))
    }
}
