import AppKit
import Foundation
import LimaProtocol

/// Which app was in front before Lima, so Mini Lima can hand focus back to
/// it when it closes and apply per-app link rules ("links from Slack open in
/// Mini Lima"); and which display the pointer is on, so Mini Lima opens
/// where you're working. Only bundle IDs and names are kept, in memory.
final class FrontApps: @unchecked Sendable {
    static let shared = FrontApps()
    private let lock = NSLock()
    private var previous: NSRunningApplication?
    private var observer: NSObjectProtocol?
    static let limaBundles: Set<String> = ["dev.lima.browser", "dev.lima.browser.dev", "app.zen-browser.zen"]

    func start() {
        guard observer == nil else { return }
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  let id = app.bundleIdentifier, !Self.limaBundles.contains(id), id != Bundle.main.bundleIdentifier else { return }
            self?.lock.lock(); self?.previous = app; self?.lock.unlock()
        }
        if let front = NSWorkspace.shared.frontmostApplication, let id = front.bundleIdentifier, !Self.limaBundles.contains(id) {
            lock.lock(); previous = front; lock.unlock()
        }
    }

    var last: NSRunningApplication? { lock.lock(); defer { lock.unlock() }; return previous }
}

extension Runtime {
    func registerFrontApps() {
        FrontApps.shared.start()
        // The app that was in front before Lima (for Mini Lima's rules).
        register("system.previousApp") { _, context in
            guard context.origin == .browser, let app = FrontApps.shared.last, !app.isTerminated else { return .null }
            return .object(["bundleId": .string(app.bundleIdentifier ?? ""), "name": .string(app.localizedName ?? "")])
        }
        // Gives focus back to that app (closing Mini Lima).
        register("system.activatePrevious") { _, context in
            guard context.origin == .browser, let app = FrontApps.shared.last, !app.isTerminated else { return .bool(false) }
            return .bool(await MainActor.run { app.activate() })
        }
        // The usable area of the display under the pointer, in top-left
        // desktop coordinates (as browser windows are placed).
        register("system.pointerScreen") { _, context in
            guard context.origin == .browser else { return .null }
            return await MainActor.run {
                let point = NSEvent.mouseLocation
                guard let screen = NSScreen.screens.first(where: { NSMouseInRect(point, $0.frame, false) }) ?? NSScreen.main,
                      let primary = NSScreen.screens.first else { return JSONValue.null }
                let visible = screen.visibleFrame
                let top = primary.frame.maxY - visible.maxY
                let layout = NSScreen.screens.map { "\(Int($0.frame.width))x\(Int($0.frame.height))@\(Int($0.frame.minX)),\(Int($0.frame.minY))" }.joined(separator: ";")
                return .object(["left": .number(visible.minX), "top": .number(top), "width": .number(visible.width), "height": .number(visible.height),
                                "layout": .string(layout)])
            }
        }
    }
}
