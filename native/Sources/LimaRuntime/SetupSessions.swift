import Foundation
import LimaAgentSupervisor
import LimaProtocol

actor SetupSessions {
    private var states: [String: JSONValue] = [:]
    private var active = Set<String>()

    func status(_ id: String) -> JSONValue { states[id] ?? .null }

    func start(_ runtime: Runtime, id: String, executable: String, args: [String], allowedHosts: Set<String>) -> JSONValue {
        guard active.insert(id).inserted else { return status(id) }
        publish(runtime, id, phase: "running")
        let paths = runtime.discovery.searchPaths
        Task {
            do {
                _ = try await ProcessProbe.run(executable, arguments: args, timeout: 300, path: paths) { line in
                    guard !allowedHosts.isEmpty, let oauth = Self.signInURL(line, allowedHosts: allowedHosts) else { return }
                    Task { await self.offer(runtime, id: id, url: oauth) }
                }
                if id == "google" {
                    _ = try await runtime.googleWorkspace.configure(true, store: runtime.store)
                    let updated = try await runtime.googleWorkspace.refresh(store: runtime.store, force: true)
                    runtime.broadcast("integrations.google.updated", try JSONValue.from(updated))
                    if updated.mail != "connected" || updated.calendar != "connected" {
                        let unverified = [updated.mail == "connected" ? nil : "Gmail", updated.calendar == "connected" ? nil : "Google Calendar"]
                            .compactMap { $0 }.joined(separator: " and ")
                        publish(runtime, id, phase: "error", message: "Google sign-in finished, but \(unverified) access could not be verified. Check the service status above.")
                        active.remove(id)
                        return
                    }
                }
                publish(runtime, id, phase: "done")
            } catch {
                let detail = String(describing: error).lowercased()
                let requiresClient = id == "google" && ["client_secret", "client id", "client_id", "oauth client"].contains(where: detail.contains)
                let help = requiresClient ? "GWS needs an OAuth client for this account. Use the Google setup guide or connect credentials already configured on this Mac."
                    : detail.contains("timed out") ? "Setup timed out. Try again when you’re ready."
                    : id.hasPrefix("install.") ? "Installation failed. Check the package manager and follow the install guide."
                    : "Sign-in did not complete. Try again or open the setup guide."
                publish(runtime, id, phase: "error", message: help)
            }
            active.remove(id)
        }
        return status(id)
    }

    private func offer(_ runtime: Runtime, id: String, url: String) {
        guard active.contains(id) else { return }
        publish(runtime, id, phase: "consent", url: url)
    }

    private func publish(_ runtime: Runtime, _ id: String, phase: String, url: String? = nil, message: String? = nil) {
        let value = JSONValue.object(["id": .string(id), "phase": .string(phase),
                                      "url": url.map(JSONValue.string) ?? .null,
                                      "message": message.map(JSONValue.string) ?? .null])
        states[id] = value
        runtime.broadcast("integrations.setup.updated", value)
    }

    static func signInURL(_ line: String, allowedHosts: Set<String>) -> String? {
        for word in line.split(whereSeparator: \.isWhitespace) {
            let value = String(word).trimmingCharacters(in: CharacterSet(charactersIn: "<>\"'"))
            if let url = URL(string: value), url.scheme == "https", let host = url.host,
               allowedHosts.contains(host), url.user == nil, url.password == nil {
                return url.absoluteString
            }
        }
        return nil
    }
}

extension Runtime {
    func registerSetup() {
        register("integrations.setup.status") { [unowned self] params, context in
            try Self.requireLocalSettings(context)
            return await self.setup.status(try params.string("id"))
        }
        register("integrations.setup.start") { [unowned self] params, context in
            try Self.requireLocalSettings(context)
            let id = try params.string("id")
            let command: String
            let args: [String]
            let hosts: Set<String>
            switch id {
            case "google":
                command = "gws"; args = ["auth", "login", "--scopes", GoogleWorkspace.scopes]; hosts = ["accounts.google.com"]
            case "claude":
                command = "claude"; args = ["auth", "login"]; hosts = ["claude.ai", "console.anthropic.com", "platform.claude.com"]
            case "codex":
                command = "codex"; args = ["login"]; hosts = ["auth.openai.com", "chatgpt.com"]
            case "install.google":
                command = "npm"; args = ["install", "-g", "@googleworkspace/cli"]; hosts = []
            case "install.claude":
                command = "brew"; args = ["install", "--cask", "claude-code"]; hosts = []
            case "install.codex":
                command = "npm"; args = ["install", "-g", "@openai/codex"]; hosts = []
            case "install.opencode":
                command = "brew"; args = ["install", "anomalyco/tap/opencode-v2"]; hosts = []
            default: throw BridgeError(.badRequest, "This setup is unavailable.")
            }
            guard let executable = self.discovery.installations(named: command).first?.path else {
                throw BridgeError(.badRequest, "Install \(command) first, then retry.")
            }
            return await self.setup.start(self, id: id, executable: executable, args: args, allowedHosts: hosts)
        }
    }
}
