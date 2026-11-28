import Foundation

/// The macOS sandbox a workspace agent's CLI runs in, along with every
/// command, server and helper it starts (they inherit it).
///
/// Workspace agents read web pages, and a page can carry instructions meant
/// for them. The sandbox bounds what such instructions could reach:
///
/// - Hidden (no reading or changing): credentials (SSH private keys, cloud and
///   registry logins, GPG), every browser's profile including Lima's own
///   (cookies, saved logins), Mail, Messages, Notes, Contacts, Calendars,
///   Photos and password managers.
/// - Writable: the workspace folder, temporary space, build and package
///   caches, and the agent CLIs' own state. Nothing else: no shell startup
///   files, LaunchAgents or apps, so nothing can be planted to run later.
///
/// Networking and reading the rest of the disk stay open, so builds, tests
/// and package installs inside the workspace work as before. Risky commands
/// (uploads, publishing, installs, piping downloads into a shell) also ask
/// you first, through `lima-host guard` (see ShellPolicy).
public struct AgentSandbox: Sendable, Equatable {
    /// Folders the agent may change (and everything below them).
    public var writable: [String]
    /// Single files the agent may change.
    public var writableFiles: [String]
    /// Folders the agent can't read or change.
    public var hidden: [String]
    /// Single files the agent can't read or change.
    public var hiddenFiles: [String]
    /// Places inside a hidden folder that stay reachable.
    public var visible: [String]
    /// Patterns (regular expressions over full paths) inside a hidden folder
    /// that stay reachable, such as public SSH keys.
    public var visiblePatterns: [String]

    public static let executable = "/usr/bin/sandbox-exec"

    /// The sandbox for a workspace agent working in `directory`.
    public static func workspace(directory: URL, runtimeData: URL, socket: String,
                                 home: URL = FileManager.default.homeDirectoryForCurrentUser,
                                 temporary: String = NSTemporaryDirectory(),
                                 systemTemporary: [String] = ["/private/tmp", "/private/var/folders"]) -> AgentSandbox {
        let h = real(home.path)
        let support = "\(h)/Library/Application Support"
        let socketFolder = real((socket as NSString).deletingLastPathComponent)
        return AgentSandbox(
            writable: unique([
                real(directory.path), real(temporary), socketFolder,
                // Caches and package stores for builds inside the workspace.
                "\(h)/Library/Caches", "\(h)/.cache", "\(h)/.npm", "\(h)/.pnpm-store", "\(h)/Library/pnpm", "\(h)/.yarn",
                "\(h)/.bun", "\(h)/.deno", "\(h)/.cargo/registry", "\(h)/.cargo/git", "\(h)/go/pkg", "\(h)/.gradle", "\(h)/.m2",
                "\(h)/Library/Developer", "\(h)/Library/org.swift.swiftpm", "\(h)/.swiftpm", "\(h)/.node-gyp",
                // The agent CLIs' own state, sessions and updates.
                "\(h)/.claude", "\(h)/.codex", "\(h)/.config/opencode", "\(h)/.local/share/opencode", "\(h)/.local/state/opencode",
                "\(h)/.local/share/claude", "\(h)/.local/state/claude", "\(h)/.config/claude",
            ] + systemTemporary),
            writableFiles: ["/dev/null", "/dev/zero", "/dev/tty", "/dev/stdout", "/dev/stderr", "/dev/dtracehelper",
                            "\(h)/.claude.json", "\(h)/.claude.json.backup", "\(h)/.claude.json.lock", "\(h)/.node_repl_history"],
            hidden: [
                "\(h)/.ssh", "\(h)/.gnupg", "\(h)/.aws", "\(h)/.azure", "\(h)/.kube", "\(h)/.docker", "\(h)/.config/gcloud",
                "\(h)/.password-store", "\(h)/.local/share/keyrings",
                // Browsers, Lima's own included (cookies, saved logins, history).
                "\(support)/Lima Browser", "\(support)/Lima", "\(support)/zen", "\(support)/Firefox", "\(support)/Google",
                "\(support)/BraveSoftware", "\(support)/Microsoft Edge", "\(support)/Arc", "\(support)/Vivaldi",
                "\(support)/com.operasoftware.Opera", "\(h)/Library/Safari", "\(h)/Library/Cookies",
                "\(h)/Library/Containers/com.apple.Safari", "\(h)/Library/HTTPStorages",
                // Personal data in Apple's apps.
                "\(h)/Library/Mail", "\(h)/Library/Containers/com.apple.mail", "\(h)/Library/Messages",
                "\(h)/Library/Group Containers/group.com.apple.notes", "\(h)/Library/Containers/com.apple.Notes",
                "\(support)/AddressBook", "\(h)/Library/Calendars", "\(h)/Library/Group Containers/group.com.apple.calendar",
                "\(h)/Pictures/Photos Library.photoslibrary", "\(support)/com.apple.TCC",
                // Password managers.
                "\(support)/1Password", "\(h)/Library/Group Containers/2BUA8C4S2C.com.1password", "\(support)/Bitwarden",
            ],
            hiddenFiles: ["\(h)/.netrc", "\(h)/.git-credentials", "\(h)/.pypirc", "\(h)/.gem/credentials",
                          "\(h)/.cargo/credentials", "\(h)/.cargo/credentials.toml", "\(h)/.config/hub"],
            // The runtime's socket (Lima's tools for the agent), and the parts
            // of ~/.ssh that hold no secrets, so git over SSH still works
            // through ssh-agent.
            visible: [socketFolder, "\(h)/.ssh/known_hosts", "\(h)/.ssh/config"],
            visiblePatterns: ["^" + NSRegularExpression.escapedPattern(for: "\(h)/.ssh/") + "[^/]+\\.pub$"])
    }

    /// The sandbox profile (SBPL) for `sandbox-exec -p`.
    public var profile: String {
        func string(_ path: String) -> String {
            "\"" + path.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
        }
        let hiddenRules = hidden.map { "(subpath \(string($0)))" } + hiddenFiles.map { "(literal \(string($0)))" }
        // Regular expressions keep their backslashes (#"…" takes them as is).
        let visibleRules = visible.map { "(subpath \(string($0)))" } + visiblePatterns.map { "(regex #\"\($0.replacingOccurrences(of: "\"", with: "\\\""))\")" }
        let writableRules = writable.map { "(subpath \(string($0)))" } + writableFiles.map { "(literal \(string($0)))" }
        return """
        (version 1)
        (allow default)
        (deny file-read* file-write*
          (require-all
            (require-any \(hiddenRules.joined(separator: " ")))
            (require-not (require-any \(visibleRules.joined(separator: " "))))))
        (deny file-write*
          (require-not (require-any \(writableRules.joined(separator: " ")))))
        """
    }

    /// `sandbox-exec` running `executable` with `arguments` inside this
    /// sandbox, or nil where macOS has no sandbox-exec.
    public func command(executable: String, arguments: [String]) -> (executable: String, arguments: [String])? {
        guard FileManager.default.isExecutableFile(atPath: Self.executable) else { return nil }
        return (Self.executable, ["-p", profile, executable] + arguments)
    }

    /// The path the kernel sees: symlinks resolved, /private kept (Foundation's
    /// resolvingSymlinksInPath drops it, and the sandbox wouldn't match). A
    /// path that doesn't exist yet resolves through its nearest existing parent.
    static func real(_ path: String) -> String {
        let trimmed = path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        if let resolved = realpath(trimmed, &buffer) { return String(cString: resolved) }
        let parent = (trimmed as NSString).deletingLastPathComponent
        guard !parent.isEmpty, parent != trimmed else { return trimmed }
        return (real(parent) as NSString).appendingPathComponent((trimmed as NSString).lastPathComponent)
    }

    static func unique(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        return paths.filter { seen.insert($0).inserted }
    }
}
