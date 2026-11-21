import Foundation
import LimaAgentSupervisor
import LimaProtocol

extension Runtime {
    func registerChatResources() {
        register("chat.resources") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Chat resources are shown in the composer.") }
            let conversation = try await self.conversations.get(try params.string("id"))
            if let id = conversation.workspaceID, try await self.workspaces.get(id).browserTestURL != nil {
                return .object(["skills": .array([]), "files": .array([]), "mcp": .array([.string("lima (assigned browser tab)")]), "settings": .array([])])
            }
            let cwd = URL(fileURLWithPath: conversation.workingDirectory, isDirectory: true)
            return Self.chatResources(provider: conversation.provider, directory: cwd, workspace: conversation.workspaceID != nil)
        }
    }

    static func chatResources(provider: CLIProvider, directory: URL, workspace: Bool) -> JSONValue {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        let env = ProcessInfo.processInfo.environment
        let providerFolder = provider == .claude ? ".claude" : provider == .codex ? ".codex" : ".opencode"
        let homeProvider = provider == .opencode
            ? home.appendingPathComponent(".config/opencode")
            : provider == .codex && env["CODEX_HOME"] != nil
                ? URL(fileURLWithPath: env["CODEX_HOME"]!)
                : home.appendingPathComponent(providerFolder)
        let projectProvider = directory.appendingPathComponent(providerFolder)
        let locations = [projectProvider.appendingPathComponent("skills"), directory.appendingPathComponent(".agents/skills"),
                         homeProvider.appendingPathComponent("skills"), home.appendingPathComponent(".agents/skills")]
        var skills: Set<String> = []
        for location in locations {
            for entry in (try? fm.contentsOfDirectory(at: location, includingPropertiesForKeys: nil)) ?? []
            where fm.isReadableFile(atPath: entry.appendingPathComponent("SKILL.md").path) {
                skills.insert(entry.lastPathComponent)
            }
        }
        if provider == .claude {
            for location in [projectProvider, homeProvider] {
                for entry in (try? fm.contentsOfDirectory(at: location.appendingPathComponent("commands"), includingPropertiesForKeys: nil)) ?? []
                where entry.pathExtension == "md" {
                    skills.insert(entry.deletingPathExtension().lastPathComponent)
                }
            }
        }

        let configurations: [URL]
        switch provider {
        case .claude:
            configurations = [directory.appendingPathComponent(".mcp.json"), projectProvider.appendingPathComponent("settings.json"),
                              projectProvider.appendingPathComponent("settings.local.json"), home.appendingPathComponent(".claude.json"),
                              homeProvider.appendingPathComponent("settings.json")]
        case .codex:
            configurations = [projectProvider.appendingPathComponent("config.toml"), homeProvider.appendingPathComponent("config.toml")]
        case .opencode:
            configurations = [directory.appendingPathComponent("opencode.json"), directory.appendingPathComponent("opencode.jsonc"),
                              homeProvider.appendingPathComponent("opencode.json"), homeProvider.appendingPathComponent("opencode.jsonc")]
        }
        var servers: Set<String> = workspace ? ["lima"] : []
        var settings: [String] = ["Provider", "Model"]
        for url in configurations where fm.isReadableFile(atPath: url.path) {
            settings.append(url.path.replacingOccurrences(of: home.path + "/", with: "~/"))
            guard let file = try? FileHandle(forReadingFrom: url) else { continue }
            defer { try? file.close() }
            guard let data = try? file.read(upToCount: 512_000) else { continue }
            if url.pathExtension == "toml" {
                let pattern = #"(?m)^\s*\[mcp_servers\.["']?([a-zA-Z0-9_-]+)["']?\]"#
                let text = String(decoding: data, as: UTF8.self)
                let regex = try? NSRegularExpression(pattern: pattern)
                for match in regex?.matches(in: text, range: NSRange(text.startIndex..., in: text)) ?? [] {
                    if let range = Range(match.range(at: 1), in: text) { servers.insert(String(text[range])) }
                }
            } else if let json = try? JSONSerialization.jsonObject(with: data, options: [.json5Allowed]) as? [String: Any] {
                let opencode = json["mcp"] as? [String: Any] ?? [:]
                let map = (json["mcpServers"] as? [String: Any]) ?? (opencode["servers"] as? [String: Any]) ?? opencode
                servers.formUnion(map.keys)
                let project = (json["projects"] as? [String: Any])?[directory.path] as? [String: Any]
                if let configured = project?["mcpServers"] as? [String: Any] { servers.formUnion(configured.keys) }
            }
        }

        let files = ((try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? [])
            .map(\.lastPathComponent).sorted().prefix(100)
        return .object(["skills": .array(skills.sorted().map(JSONValue.string)),
                        "mcp": .array(servers.sorted().map(JSONValue.string)),
                        "settings": .array(settings.map(JSONValue.string)),
                        "files": .array(files.map(JSONValue.string))])
    }
}
