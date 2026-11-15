import Foundation

/// Terminal process states (spec §4.2). `uncertain` is a real state: it is
/// never collapsed into `idle` just because output went quiet.
public enum TerminalProcessState: String, Codable, Sendable {
    case idle, running, waitingForInput, disconnected, exited, uncertain
}

public enum ShellIntegrationEvent: Equatable, Sendable {
    /// precmd fired: the prompt is back. Carries the previous command's status.
    case promptReady(exitStatus: Int?)
    /// preexec fired: a command line was submitted.
    case commandStarted
}

/// Shell integration adapted from Orca's shell-ready barrier: the shell
/// itself emits private OSC 777 markers from precmd/preexec hooks, so
/// prompt/command boundaries come from the shell rather than from guessing
/// at output patterns.
///
/// Marker grammar: ESC ] 777 ; lima ; <kind> [; <arg>] (BEL | ESC \)
public enum ShellIntegration {
    public static let oscPrefix = "\u{1B}]777;lima;"

    /// Contents of a `.zshrc` placed in a Lima-owned ZDOTDIR. It restores the
    /// user's real ZDOTDIR, sources their config, then installs the hooks.
    public static let zshRC = #"""
    # Lima shell integration (generated). Do not edit.
    if [[ -n "$LIMA_USER_ZDOTDIR" ]]; then ZDOTDIR="$LIMA_USER_ZDOTDIR"; else ZDOTDIR="$HOME"; fi
    [[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
    __lima_precmd() { printf '\033]777;lima;prompt;%s\007' "$?"; }
    __lima_preexec() { printf '\033]777;lima;preexec\007'; }
    autoload -Uz add-zsh-hook
    add-zsh-hook precmd __lima_precmd
    add-zsh-hook preexec __lima_preexec
    """#
}

/// Streaming scanner that strips Lima markers from PTY output and reports
/// the events they encode. Handles markers split across read boundaries.
public struct ShellMarkerScanner: Sendable {
    private var pending: [UInt8] = []
    private static let prefix = Array(ShellIntegration.oscPrefix.utf8)
    private static let maxMarkerLength = 64

    public init() {}

    public mutating func feed(_ chunk: [UInt8]) -> (output: [UInt8], events: [ShellIntegrationEvent]) {
        let bytes = pending + chunk
        pending.removeAll(keepingCapacity: true)
        var output: [UInt8] = []
        var events: [ShellIntegrationEvent] = []
        output.reserveCapacity(bytes.count)

        var index = 0
        while index < bytes.count {
            guard bytes[index] == 0x1B else {
                output.append(bytes[index]); index += 1; continue
            }
            let remaining = bytes.count - index
            let comparable = min(remaining, Self.prefix.count)
            guard Array(bytes[index..<index + comparable]) == Array(Self.prefix[0..<comparable]) else {
                output.append(bytes[index]); index += 1; continue
            }
            if remaining < Self.prefix.count { pending = Array(bytes[index...]); break }

            // Find the terminator (BEL or ESC \).
            var end = index + Self.prefix.count
            var terminatorLength = 0
            while end < bytes.count, end - index <= Self.maxMarkerLength {
                if bytes[end] == 0x07 { terminatorLength = 1; break }
                if bytes[end] == 0x1B, end + 1 < bytes.count, bytes[end + 1] == 0x5C { terminatorLength = 2; break }
                end += 1
            }
            if terminatorLength == 0 {
                if end - index > Self.maxMarkerLength {
                    // Not a real marker; pass it through untouched.
                    output.append(bytes[index]); index += 1; continue
                }
                pending = Array(bytes[index...]); break
            }

            let body = String(decoding: bytes[(index + Self.prefix.count)..<end], as: UTF8.self)
            if let event = Self.parse(body) { events.append(event) }
            index = end + terminatorLength
        }
        return (output, events)
    }

    private static func parse(_ body: String) -> ShellIntegrationEvent? {
        let parts = body.split(separator: ";", omittingEmptySubsequences: false)
        switch parts.first {
        case "prompt": return .promptReady(exitStatus: parts.count > 1 ? Int(parts[1]) : nil)
        case "preexec": return .commandStarted
        default: return nil
        }
    }
}
