import AppKit
import ApplicationServices
import LimaProtocol

/// Opens one macOS privacy pane directly from the runtime. The browser's
/// external-protocol path asked "Open this link with System Settings?" every
/// time; NSWorkspace goes straight there. Only these panes can be opened.
extension Runtime {
    static let settingsPanes: [String: String] = [
        "accessibility": "Privacy_Accessibility",
        "files": "Privacy_FilesAndFolders",
        "location": "Privacy_LocationServices",
        "automation": "Privacy_Automation",
        "microphone": "Privacy_Microphone",
        "screen": "Privacy_ScreenCapture",
    ]

    func registerSystemSettings() {
        register("system.openSettings") { params, context in
            try Self.requireLocalSettings(context)
            let pane = try params.string("pane")
            guard let anchor = Self.settingsPanes[pane],
                  let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else {
                throw BridgeError(.badRequest, "Unknown settings pane.")
            }
            let opened = await MainActor.run { NSWorkspace.shared.open(url) }
            guard opened else { throw BridgeError(.internalError, "macOS didn't open System Settings.") }
            return .null
        }
        // Provider failover on usage limits (on unless the user turns it off).
        register("agents.failover") { [unowned self] params, context in
            if let enabled = params?["enabled"]?.boolValue {
                try Self.requireLocalSettings(context)
                try await self.store.put(enabled, collection: "settings", id: "agents.failover")
            }
            return .bool((try? await self.store.get(Bool.self, collection: "settings", id: "agents.failover")) ?? true)
        }
        // What Lima can check without prompting. Files & Folders has no public
        // query, so it is reported as unknown.
        register("system.permissions") { _, context in
            try Self.requireLocalSettings(context)
            return .object(["accessibility": .bool(AXIsProcessTrusted())])
        }
    }
}
