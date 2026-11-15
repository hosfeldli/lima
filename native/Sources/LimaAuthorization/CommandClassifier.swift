import Foundation

/// Derives an action class from the executable and arguments that will
/// actually run. It is deliberately conservative: it only recognizes
/// patterns that make an operation *stricter*. Unknown commands return nil
/// and fall back to the declared kind.
public enum CommandClassifier {
    public static func classify(executable: String?, arguments: [String]) -> ActionKind? {
        guard let executable else { return nil }
        let name = URL(fileURLWithPath: executable).lastPathComponent

        // Unwrap privilege escalation and re-classify the wrapped command.
        if name == "sudo" || name == "doas" {
            let inner = arguments.drop { $0.hasPrefix("-") }
            guard let wrapped = inner.first else { return .destructiveSystemOperation }
            let innerKind = classify(executable: wrapped, arguments: Array(inner.dropFirst()))
            return innerKind ?? .modifyProtectedOSSettings
        }

        switch name {
        case "csrutil", "spctl", "nvram", "bless", "systemsetup", "kextload", "kextunload":
            return .modifyProtectedOSSettings
        case "diskutil" where arguments.contains(where: { ["eraseDisk", "eraseVolume", "partitionDisk", "zeroDisk", "secureErase"].contains($0) }):
            return .destructiveSystemOperation
        case "dd" where arguments.contains(where: { $0.hasPrefix("of=/dev/") }):
            return .destructiveSystemOperation
        case "mkfs", "newfs_apfs", "newfs_hfs":
            return .destructiveSystemOperation
        case "rm":
            let recursive = arguments.contains { $0.hasPrefix("-") && !$0.hasPrefix("--") && ($0.contains("r") || $0.contains("R")) }
                || arguments.contains("--recursive")
            if arguments.contains(where: isSystemRoot) { return .destructiveSystemOperation }
            return recursive ? .deleteLargeOrOverwriteImportant : nil
        case "git":
            return classifyGit(arguments)
        case "gh":
            if arguments.starts(with: ["release", "create"]) || arguments.starts(with: ["release", "delete"])
                || arguments.starts(with: ["repo", "delete"]) || arguments.starts(with: ["pr", "merge"]) {
                return .remotePublish
            }
            return nil
        case "npm", "pnpm", "yarn", "cargo", "twine":
            return arguments.first == "publish" ? .remotePublish : nil
        case "security":
            return arguments.first.map { $0.hasPrefix("find-") || $0.hasPrefix("dump-") || $0 == "export" } == true
                ? .accessCredentials : nil
        case "mail", "sendmail":
            return .sendExternalMessage
        default:
            return nil
        }
    }

    private static func classifyGit(_ arguments: [String]) -> ActionKind? {
        guard let sub = arguments.first(where: { !$0.hasPrefix("-") }) else { return nil }
        switch sub {
        case "push":
            let forceOrDelete = arguments.contains { ["--force", "-f", "--force-with-lease", "--delete", "-d", "--mirror"].contains($0) || $0.hasPrefix("--force-with-lease=") }
                || arguments.contains { $0.hasPrefix("+") || $0.hasPrefix(":") }
            // Plain pushes follow the declared kind; rewriting or deleting
            // remote history always needs confirmation.
            return forceOrDelete ? .remotePublish : nil
        case "clean" where arguments.contains(where: { $0.hasPrefix("-") && $0.contains("f") }):
            return .deleteLargeOrOverwriteImportant
        case "reset" where arguments.contains("--hard"):
            return .deleteLargeOrOverwriteImportant
        case "commit", "branch", "checkout", "switch", "worktree":
            return .createBranchOrLocalCommit
        default:
            return nil
        }
    }

    private static func isSystemRoot(_ path: String) -> Bool {
        let roots = ["/", "/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/private", "~", "/Users"]
        let trimmed = path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
        return roots.contains(trimmed) || trimmed == NSHomeDirectory()
    }
}
