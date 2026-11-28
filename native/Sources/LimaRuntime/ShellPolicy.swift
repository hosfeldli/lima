import Darwin
import Foundation
import LimaProtocol

/// Which shell commands a workspace agent must ask you about first.
///
/// The agent's sandbox (AgentSandbox) already keeps it away from your
/// credentials and other apps' data, and from changing anything outside its
/// workspace. What's left that can still reach beyond your Mac, or can't be
/// undone, asks first: sending data out (uploads, posts, remote copies),
/// publishing (pushes, releases, deploys), piping a download straight into a
/// shell, controlling the Mac (AppleScript, launchd, defaults, the
/// keychain, removing quarantine), and wiping a whole folder.
///
/// It reads the command text, so it's a guard rail, not a wall: the
/// sandbox is what holds if a command slips past it.
public enum ShellPolicy {
    public struct Risk: Equatable, Sendable {
        public var kind: String
        public var reason: String
    }

    private static let rules: [(kind: String, reason: String, pattern: String)] = [
        ("download-run", "runs a script straight from the internet",
         #"\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k|fi)?sh\b|\b(curl|wget)\b[^|;&]*\|\s*(python3?|perl|ruby|node|osascript)\b|\b(ba|z)?sh\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)\b"#),
        ("upload", "sends data to another computer",
         #"\bcurl\b[^;&|]*(\s-[a-zA-Z]*[dFT]\b|\s--data\b|\s--data-[a-z]+\b|\s--form\b|\s--json\b|\s--upload-file\b|\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s--request\s+(POST|PUT|PATCH|DELETE)\b)|\bwget\b[^;&|]*--(post-data|post-file|method=(post|put|patch))|\b(scp|sftp|rsync)\b[^;&|]*\s\S+:\S*|\b(nc|ncat|netcat|socat|telnet)\b\s+\S|\bssh\s+(-\S+\s+)*[\w.@-]+"#),
        ("publish", "publishes or changes something online",
         #"\bgit\s+push\b|\bgh\s+(pr\s+(create|merge|close|edit)|release\s+(create|delete|upload|edit)|repo\s+(create|delete|edit|rename)|gist\s+create|issue\s+(create|close|comment)|api\b[^;&|]*(-X|--method)\s*(POST|PUT|PATCH|DELETE))|\b(npm|pnpm)\s+publish\b|\byarn\s+(npm\s+)?publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bdocker\s+push\b|\bpod\s+trunk\s+push\b|\b(vercel|netlify|fly|firebase|wrangler)\s+(deploy|publish)\b|\bvercel\s+--prod\b|\bterraform\s+(apply|destroy)\b|\bkubectl\s+(apply|delete|create|patch)\b"#),
        ("system", "controls your Mac or its settings",
         #"\bosascript\b|\blaunchctl\b|\bdefaults\s+(write|delete)\b|\bcrontab\b|\bsecurity\s+(find-|dump-|export|unlock|delete|add-|set-)|\bpmset\b|\bnetworksetup\b|\btccutil\b|\bxattr\s+(-\w*[dc]\w*\s+)*-?\w*\s*com\.apple\.quarantine|\bxattr\s+-\w*[cd]|\bspctl\b|\bcsrutil\b|\bsudo\b|\b(shutdown|reboot|halt)\b|\bkillall\b|\bopen\s+(-\w+\s+)*-a\b"#),
        ("delete", "deletes a whole folder or your uncommitted work",
         #"\brm\s+(-\w+\s+)*-\w*[rR]\w*\s+(-\w+\s+)*(/\*?|~/?\*?|\$HOME/?|"\$HOME"/?|\.\./?|\./?\*?|\*)(\s|$|;|&|\|)|\bgit\s+(reset\s+--hard|clean\s+-\w*[fdx])\b|\bgit\s+checkout\s+--\s+\.\s*$|\bfind\b[^;&|]*\s-delete\b"#),
    ]

    /// The risk a command carries, or nil for ordinary work.
    public static func assess(_ command: String) -> Risk? {
        let text = command.replacingOccurrences(of: "\\\n", with: " ")
        for rule in rules {
            guard text.range(of: rule.pattern, options: [.regularExpression, .caseInsensitive]) != nil else { continue }
            // Requests to a server on this Mac (a dev server under test) are
            // ordinary work, not uploads.
            if rule.kind == "upload", onlyLoopback(text) { continue }
            return Risk(kind: rule.kind, reason: rule.reason)
        }
        return nil
    }

    static func onlyLoopback(_ text: String) -> Bool {
        if text.range(of: #"\b(ssh|scp|sftp|rsync|nc|ncat|netcat|socat|telnet)\b"#, options: .regularExpression) != nil { return false }
        let hosts = matches(#"https?://([^/\s:'"]+)"#, in: text)
        return !hosts.isEmpty && hosts.allSatisfy { ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].contains($0.lowercased()) }
    }

    static func matches(_ pattern: String, in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {
            Range($0.range(at: 1), in: text).map { String(text[$0]) }
        }
    }

    /// The command in a PreToolUse hook's input (Claude Code's Bash tool,
    /// Codex's exec tools), or nil for tools that don't run a shell command.
    public static func command(inHookInput input: JSONValue) -> String? {
        let tool = input["tool_input"] ?? input["toolInput"] ?? .null
        for key in ["command", "cmd", "script"] {
            if let text = tool[key]?.stringValue { return text }
            if let parts = tool[key]?.arrayValue {
                let words = parts.compactMap(\.stringValue)
                // ["bash", "-lc", "<script>"]: the script is what runs.
                if words.count >= 3, ["-c", "-lc", "-ic"].contains(words[words.count - 2]) { return words.last }
                return words.joined(separator: " ")
            }
        }
        return nil
    }
}

/// `lima-host guard`: the PreToolUse hook Lima gives workspace agents
/// (Claude Code and Codex). Ordinary commands pass silently; a risky one
/// shows an approval card in Lima and waits for your answer. Anything that
/// goes wrong while asking refuses the command (it fails closed).
public enum ShellGuard {
    public static func run() -> Never {
        let input = (try? JSONDecoder().decode(JSONValue.self, from: FileHandle.standardInput.readDataToEndOfFile())) ?? .null
        guard let command = ShellPolicy.command(inHookInput: input), let risk = ShellPolicy.assess(command) else { exit(0) }
        let token = ProcessInfo.processInfo.environment["LIMA_WORKSPACE_TOKEN"].flatMap { $0.isEmpty ? nil : $0 }
        do {
            guard let token else { throw BridgeError(.notAuthorized, "this agent isn't connected to a Lima workspace") }
            let client = try RuntimeClient.connect(origin: .mcp, workspaceToken: token)
            let answer = try client.call("workspace.approveCommand", params: .object([
                "command": .string(String(command.prefix(4000))), "kind": .string(risk.kind), "reason": .string(risk.reason),
            ]))
            if answer["approved"]?.boolValue == true { exit(0) }
            deny("The user declined this command in Lima (it \(risk.reason)). Don't retry it or work around it; continue without it or report back.")
        } catch {
            let message = (error as? BridgeError)?.message ?? "\(error)"
            deny("Lima couldn't ask the user about this command (it \(risk.reason)): \(message). Ask with workspace_request_approval instead, then try again.")
        }
    }

    static func deny(_ reason: String) -> Never {
        let output: [String: Any] = ["hookSpecificOutput": [
            "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason,
        ]]
        if let data = try? JSONSerialization.data(withJSONObject: output) { FileHandle.standardOutput.write(data) }
        exit(0)
    }
}

/// Kinds of risky command you allowed "for this task", per workspace family
/// (the agent and its helpers), for four hours.
actor CommandGrants {
    static let shared = CommandGrants()
    private var grants: [String: Date] = [:]

    func allows(family: String, kind: String) -> Bool {
        guard let until = grants["\(family)/\(kind)"] else { return false }
        if until > Date() { return true }
        grants["\(family)/\(kind)"] = nil
        return false
    }

    func grant(family: String, kind: String) {
        grants["\(family)/\(kind)"] = Date().addingTimeInterval(4 * 3600)
    }
}

extension ShellPolicy {
    /// Command patterns OpenCode refuses outright (it has no hook to ask
    /// through mid-run). The same families ShellPolicy asks about.
    static let openCodeDenied = [
        "curl * | *sh*", "wget * | *sh*", "curl *-d *", "curl *--data*", "curl *-F *", "curl *--form*", "curl *-T *", "curl *--upload-file*",
        "curl *-X POST*", "curl *-X PUT*", "curl *--json*", "wget *--post-*", "scp *", "sftp *", "rsync *:*", "nc *", "ncat *", "netcat *", "socat *",
        "telnet *", "ssh *", "git push*", "gh pr create*", "gh pr merge*", "gh release *", "gh repo *", "gh api *-X*", "gh gist create*",
        "npm publish*", "pnpm publish*", "yarn publish*", "yarn npm publish*", "cargo publish*", "twine upload*", "gem push*", "docker push*",
        "osascript*", "launchctl *", "defaults write*", "defaults delete*", "crontab*", "security *", "sudo *", "xattr -d*", "xattr -c*", "tccutil*",
        "rm -rf /*", "rm -rf ~*", "rm -rf .", "rm -rf ./", "rm -rf ..*", "git reset --hard*", "git clean -*",
    ]
}
