import Foundation
import LimaProtocol

/// How an agent lays out its workspace in the sidebar: which folder each tab
/// sits in, the tabs' order, icons and names, and each folder's icon and
/// whether it's open. One call (`workspace.arrange`) does any mix of these.
extension Workspace {
    /// Lima's own icon set (ui/icons.json), drawn in the sidebar's text colour.
    static let tabIconNames: Set<String> = [
        "activity",
        "agents",
        "app",
        "archive",
        "arrow",
        "audio",
        "bolt",
        "bookmark",
        "braces",
        "calc",
        "calendar",
        "canvas",
        "chat",
        "check",
        "checkbox",
        "chevron",
        "close",
        "context",
        "copy",
        "download",
        "external",
        "file",
        "folder",
        "folder-open",
        "github",
        "globe",
        "grammar",
        "hash",
        "history",
        "home",
        "image",
        "inbox",
        "integrations",
        "key",
        "lima",
        "link",
        "list",
        "mic",
        "moon",
        "more",
        "mute",
        "next",
        "note",
        "notebook",
        "paragraph",
        "pause",
        "play",
        "plus",
        "previous",
        "redo",
        "search",
        "send",
        "sliders",
        "smile",
        "spark",
        "star",
        "stop",
        "studio",
        "tab",
        "table",
        "terminal",
        "trash",
        "undo",
        "volume",
        "warning",
        "web",
        "workspace",
    ]

    /// A tidy icon value: a Lima icon name or an emoji (one or two characters).
    /// "" clears it (nil); anything else is refused with what to use instead.
    static func tabIcon(_ raw: String) throws -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        if tabIconNames.contains(text.lowercased()) { return text.lowercased() }
        let isEmoji = text.count <= 2 && text.unicodeScalars.contains { $0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0x238C) }
            && !text.unicodeScalars.contains { $0.isASCII }
        guard isEmoji else {
            throw BridgeError(.badRequest, "Use an emoji or one of Lima's icon names for \"\(text.prefix(30))\": \(tabIconNames.sorted().joined(separator: ", ")).")
        }
        return text
    }

    /// A tab's custom name, tidied; "" clears it.
    static func tabLabel(_ raw: String) -> String? {
        let text = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return text.isEmpty ? nil : String(text.prefix(80))
    }

    private static func within(_ folder: String?, _ path: String) -> Bool {
        guard let folder else { return false }
        return folder == path || folder.hasPrefix(path + "/")
    }

    /// Applies one `workspace.arrange` request; returns what it couldn't find.
    mutating func arrange(folders: [JSONValue], tabs moves: [JSONValue]) throws -> [String] {
        var styles = tabFolderStyles ?? []
        func style(_ path: String, _ change: (inout TabFolderStyle) -> Void) {
            if let index = styles.firstIndex(where: { $0.path == path }) { change(&styles[index]) }
            else { var new = TabFolderStyle(path: path); change(&new); styles.append(new) }
        }
        for item in folders {
            guard let path = Self.tabFolder(item["path"]?.stringValue) else { throw BridgeError(.badRequest, "Each folder needs its path, such as \"Research\".") }
            if item["remove"]?.boolValue == true {
                let parent = path.contains("/") ? String(path[..<path.lastIndex(of: "/")!]) : nil
                for index in tabs.indices where Self.within(tabs[index].folder, path) { tabs[index].folder = parent }
                styles.removeAll { Self.within($0.path, path) }
                continue
            }
            var current = path
            if let raw = item["renameTo"]?.stringValue {
                guard let renamed = Self.tabFolder(raw) else { throw BridgeError(.badRequest, "Give \"\(path)\" a new name.") }
                guard !Self.within(renamed, path) || renamed == path else { throw BridgeError(.badRequest, "A folder can't move inside itself.") }
                for index in tabs.indices where Self.within(tabs[index].folder, path) {
                    tabs[index].folder = renamed + tabs[index].folder!.dropFirst(path.count)
                }
                for index in styles.indices where Self.within(styles[index].path, path) {
                    styles[index].path = renamed + styles[index].path.dropFirst(path.count)
                }
                current = renamed
            }
            let icon = try item["icon"]?.stringValue.map(Self.tabIcon)
            style(current) { entry in
                if let icon { entry.icon = icon }
                if let collapsed = item["collapsed"]?.boolValue { entry.collapsed = collapsed }
            }
        }
        var missing: [String] = []
        var ordered: [String] = []
        for move in moves {
            guard let url = move["url"]?.stringValue else { throw BridgeError(.badRequest, "Each tab needs its url.") }
            var index = tabs.firstIndex { $0.url == url }
            if index == nil, let title = move["title"]?.stringValue, let scheme = URL(string: url)?.scheme,
               ["http", "https"].contains(scheme) || url.hasPrefix("about:lima?note=") {
                tabs.append(.init(url: url, title: title))
                index = tabs.count - 1
            }
            guard let index else { missing.append(url); continue }
            if let folder = move["folder"]?.stringValue { tabs[index].folder = Self.tabFolder(folder) }
            if let icon = move["icon"]?.stringValue { tabs[index].icon = try Self.tabIcon(icon) }
            if let label = move["label"]?.stringValue { tabs[index].label = Self.tabLabel(label) }
            ordered.append(url)
        }
        // Listed tabs take the listed order; the rest keep theirs after them.
        if ordered.count > 1 {
            let rank = Dictionary(ordered.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
            let listed = tabs.filter { rank[$0.url] != nil }.sorted { rank[$0.url]! < rank[$1.url]! }
            var slots = listed.makeIterator()
            tabs = tabs.map { rank[$0.url] != nil ? slots.next()! : $0 }
            tabOrder = (tabOrder ?? 0) + 1
        }
        // A folder the agent named stays (even empty) until it removes it.
        tabFolderStyles = styles.isEmpty ? nil : styles
        return missing
    }

    /// The layout as an agent reads it back.
    var layoutView: JSONValue {
        .object([
            "folders": .array((tabFolderStyles ?? []).map { style in
                .object(["path": .string(style.path), "icon": style.icon.map(JSONValue.string) ?? .null,
                         "collapsed": style.collapsed.map(JSONValue.bool) ?? .null,
                         "tabs": .number(Double(tabs.filter { Self.within($0.folder, style.path) }.count))])
            }),
            "tabs": .array(tabs.map { tab in
                .object(["url": .string(tab.url), "title": .string(tab.label ?? tab.title), "folder": .string(tab.folder ?? ""),
                         "icon": tab.icon.map(JSONValue.string) ?? .null])
            }),
        ])
    }
}
