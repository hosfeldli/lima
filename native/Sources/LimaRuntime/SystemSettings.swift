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
        "fullDisk": "Privacy_AllFiles",
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
        // macOS appearance. The browser chrome is pinned to a light color
        // scheme, so it can't tell; the runtime reads the system setting.
        register("system.appearance") { _, _ in .object(["dark": .bool(Self.systemIsDark())]) }
        // What Lima can check without prompting. Files & Folders has no public
        // query, so it is reported as unknown.
        register("system.permissions") { _, context in
            try Self.requireLocalSettings(context)
            return .object(["accessibility": .bool(AXIsProcessTrusted())])
        }
    }

    static func systemIsDark() -> Bool {
        CFPreferencesAppSynchronize(kCFPreferencesAnyApplication)
        return (CFPreferencesCopyAppValue("AppleInterfaceStyle" as CFString, kCFPreferencesAnyApplication) as? String) == "Dark"
    }

    /// Broadcasts `system.appearance` whenever macOS switches light/dark
    /// (including Auto at sunset), checked on the system notification and
    /// every minute as a fallback.
    func watchAppearance() -> AnyObject {
        let state = AppearanceState(dark: Self.systemIsDark())
        let check: @Sendable () -> Void = { [weak self] in
            let dark = Runtime.systemIsDark()
            guard state.update(dark) else { return }
            self?.broadcast("system.appearance", .object(["dark": .bool(dark)]))
        }
        let observer = DistributedNotificationCenter.default().addObserver(forName: Notification.Name("AppleInterfaceThemeChangedNotification"),
                                                                          object: nil, queue: .main) { _ in
            // The new value lands a moment after the notification.
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.3, execute: check)
        }
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 60, repeating: 60)
        timer.setEventHandler(handler: check)
        timer.resume()
        return [observer as AnyObject, timer] as AnyObject
    }
}

final class AppearanceState: @unchecked Sendable {
    private let lock = NSLock()
    private var dark: Bool
    init(dark: Bool) { self.dark = dark }
    /// Records the value; true when it changed.
    func update(_ value: Bool) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard value != dark else { return false }
        dark = value
        return true
    }
}
