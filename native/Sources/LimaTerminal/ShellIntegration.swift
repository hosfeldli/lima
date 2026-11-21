import Foundation

/// Terminal process states (spec §4.2). `uncertain` is a real state: it is
/// never collapsed into `idle` just because output went quiet.
public enum TerminalProcessState: String, Codable, Sendable {
    case idle, running, waitingForInput, disconnected, exited, uncertain
}

public enum ShellIntegrationEvent: Equatable, Sendable {
    /// precmd fired: the prompt is back. Carries the previous command's status.
    case promptReady(exitStatus: Int?)
    case workingDirectory(String)
    /// preexec fired: a command line was submitted. The command text comes
    /// from the shell's own hook (explicit history), never from keystrokes.
    case commandStarted(command: String?)
}

/// Shell integration adapted from Orca's shell-ready barrier: the shell
/// itself emits private OSC 777 markers from precmd/preexec hooks, so
/// prompt/command boundaries come from the shell rather than from guessing
/// at output patterns.
///
/// Marker grammar: ESC ] 777 ; lima ; <kind> [; <arg>] (BEL | ESC \)
public enum ShellIntegration {
    public static let oscPrefix = "\u{1B}]777;lima;"

    /// ZDOTDIR wrapper files. They source the user's real startup files
    /// with ZDOTDIR pointed at the user's directory, then install hooks.
    public static let zshFiles: [String: String] = [
        ".zshenv": #"""
        # Lima shell integration (generated). Do not edit.
        LIMA_INTEGRATION_DIR="$ZDOTDIR"
        ZDOTDIR="${LIMA_USER_ZDOTDIR:-$HOME}"
        [[ -r "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
        LIMA_USER_ZDOTDIR="$ZDOTDIR"
        ZDOTDIR="$LIMA_INTEGRATION_DIR"
        """#,
        ".zprofile": #"""
        ZDOTDIR="$LIMA_USER_ZDOTDIR"
        [[ -r "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
        ZDOTDIR="$LIMA_INTEGRATION_DIR"
        """#,
        ".zshrc": #"""
        ZDOTDIR="$LIMA_USER_ZDOTDIR"
        [[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
        __lima_precmd() {
          local result=$?
          printf '\033]777;lima;pwd;%s\007' "$(print -rn -- "$PWD" | /usr/bin/base64 | /usr/bin/tr -d '\n')"
          __lima_status=$result
          if [[ -z "$__lima_zle_hook" || ! -o zle ]]; then __lima_line_init; fi
        }
        __lima_line_init() { printf '\033]777;lima;prompt;%s\007' "${__lima_status:-0}"; }
        autoload -Uz add-zle-hook-widget
        add-zle-hook-widget line-init __lima_line_init && __lima_zle_hook=1
        __lima_preexec() { printf '\033]777;lima;preexec;%s\007' "$(print -rn -- "${1[1,2500]}" | /usr/bin/base64 | /usr/bin/tr -d '\n')"; }
        typeset -ag precmd_functions preexec_functions
        precmd_functions=(__lima_precmd "${precmd_functions[@]:#__lima_precmd}")
        preexec_functions=(__lima_preexec "${preexec_functions[@]:#__lima_preexec}")
        """#
    ]

    /// Writes the wrapper files into `directory` (idempotent).
    public static func install(in directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (name, contents) in zshFiles {
            try contents.write(to: directory.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
    }
}

/// Streaming scanner that strips Lima markers from PTY output and reports
/// the events they encode. Handles markers split across read boundaries.
public struct ShellMarkerScanner: Sendable {
    private var pending: [UInt8] = []
    private static let prefix = Array(ShellIntegration.oscPrefix.utf8)
    private static let maxMarkerLength = 16 * 1024

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
        case "pwd":
            guard parts.count > 1, let data = Data(base64Encoded: String(parts[1])),
                  let path = String(data: data, encoding: .utf8), path.hasPrefix("/") else { return nil }
            return .workingDirectory(path)
        case "preexec":
            let command = parts.count > 1 ? Data(base64Encoded: String(parts[1])).map { String(decoding: $0, as: UTF8.self) } : nil
            return .commandStarted(command: command)
        default: return nil
        }
    }
}
