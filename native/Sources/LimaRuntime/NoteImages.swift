import Foundation
import ImageIO
import LimaContext
import LimaProtocol
import UniformTypeIdentifiers

/// Images for notes from a web address or a file on this Mac. Notes never
/// load remote content, so Lima fetches the image once (no cookies, HTTPS or
/// a local preview only), checks that it really is an image, re-encodes it
/// as PNG (dropping metadata such as location, and scaling anything larger
/// than 2400 px down) and keeps it as an encrypted note attachment.
enum NoteImages {
    static let maxSide = 2400
    static let maxBytes = 25_000_000

    /// PNG data for any image ImageIO can read, or nil.
    static func normalized(_ data: Data) -> Data? {
        guard data.count <= maxBytes, let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0 else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maxSide,
                                        kCGImageSourceCreateThumbnailWithTransform: true]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? output as Data : nil
    }

    /// A file path: absolute, `~/…`, or relative to `base` (a workspace's directory).
    static func fileURL(_ path: String, base: String?) -> URL? {
        let expanded = (path as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") { return URL(fileURLWithPath: expanded).standardizedFileURL }
        guard let base else { return nil }
        return URL(fileURLWithPath: base).appendingPathComponent(expanded).standardizedFileURL
    }

    static func load(_ source: String, base: String?) async throws -> Data {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) {
            guard LinkPreviews.allowed(url) else { throw BridgeError(.badRequest, "Use an HTTPS image address (or a local preview).") }
            return try await LinkPreviews.shared.image(url, limit: maxBytes)
        }
        if trimmed.hasPrefix("file://"), let url = URL(string: trimmed) { return try read(url) }
        guard let url = fileURL(trimmed, base: base) else {
            throw BridgeError(.badRequest, "Give an HTTPS address or a full file path for the image.")
        }
        return try read(url)
    }

    private static func read(_ url: URL) throws -> Data {
        let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values?.isRegularFile == true else { throw BridgeError(.badRequest, "There's no image file at \(url.path).") }
        guard (values?.fileSize ?? 0) <= maxBytes else { throw BridgeError(.badRequest, "That image is larger than 25 MB.") }
        return try Data(contentsOf: url)
    }
}

extension LinkPreviews {
    /// The bytes at an image address (the caller checks they decode).
    func image(_ url: URL, limit: Int) async throws -> Data {
        let (data, response) = try await fetchData(url, limit: limit + 1)
        guard data.count <= limit else { throw BridgeError(.badRequest, "That image is larger than 25 MB.") }
        if let type = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.lowercased(),
           type.hasPrefix("text/html") {
            throw BridgeError(.badRequest, "That address is a web page, not an image. Use the image's own address.")
        }
        return data
    }
}

extension Runtime {
    func registerNoteImages() {
        // Folders and the archive live in the browser's bookmark tree (notes
        // are bookmarks), so these ask the browser to do it.
        let organize: @Sendable (Runtime, String, [String: JSONValue], CallContext) async throws -> JSONValue = { runtime, kind, payload, context in
            try await runtime.browserCalls.call(runtime, kind: kind, workspaceID: context.workspaceID ?? "", payload: payload)
        }
        register("notes.folders") { [unowned self] _, context in
            try await organize(self, "notesOutline", [:], context)
        }
        register("notes.organize") { [unowned self] params, context in
            try await self.requireNotesWrite(context)
            let id = try params.string("id")
            let note = try await self.notes.get(id)
            let folder = try params.string("folder").trimmingCharacters(in: .whitespacesAndNewlines)
            guard (1...240).contains(folder.count) else { throw BridgeError(.badRequest, "Name a folder path such as Recipes or Work/Clients.") }
            let result = try await organize(self, "notesOrganize", ["noteId": .string(id), "folder": .string(folder)], context)
            // A note that's also a tab in a workspace moves into that workspace's
            // folder of the same name too, so the sidebar shows where it went.
            let url = "about:lima?note=\(id)"
            for workspace in await self.workspaces.list() where workspace.tabs.contains(where: { $0.url == url }) {
                if let updated = try? await self.workspaces.update(workspace.id, { workspace in
                    if let index = workspace.tabs.firstIndex(where: { $0.url == url }) { workspace.tabs[index].folder = Workspace.tabFolder(folder) }
                }) { self.broadcast("workspace.updated", updated.publicView) }
            }
            self.recordActivity(ActivityEvent(kind: .note, title: note.title, detail: "moved to \(result["folder"]?.stringValue ?? folder)", metadata: ["noteId": note.id]))
            return result
        }
        register("notes.archive") { [unowned self] params, context in
            try await self.requireNotesWrite(context)
            let id = try params.string("id")
            let note = try await self.notes.get(id)
            let result = try await organize(self, "notesArchive", ["noteId": .string(id)], context)
            self.recordActivity(ActivityEvent(kind: .note, title: note.title, detail: "archived", metadata: ["noteId": note.id]))
            return result
        }
        register("notes.unarchive") { [unowned self] params, context in
            try await self.requireNotesWrite(context)
            let id = try params.string("id")
            let note = try await self.notes.get(id)
            let result = try await organize(self, "notesUnarchive", ["noteId": .string(id)], context)
            self.recordActivity(ActivityEvent(kind: .note, title: note.title, detail: "restored from the archive", metadata: ["noteId": note.id]))
            return result
        }
        // `source`: an HTTPS address or a file path. Returns the attachment
        // and the Markdown that shows it (`width` such as 50% or 320).
        register("notes.image.add") { [unowned self] params, context in
            try await self.requireNotesWrite(context)
            var base: String?
            if let id = context.workspaceID { base = try? await self.workspaces.get(id).directory }
            let raw = try await NoteImages.load(try params.string("source"), base: base)
            guard let png = NoteImages.normalized(raw) else { throw BridgeError(.badRequest, "That file or address isn't an image Lima can read.") }
            let id = UUID().uuidString
            try await self.store.putAttachment(png, id: id)
            let alt = (params.optionalString("alt") ?? "").replacingOccurrences(of: "]", with: "").replacingOccurrences(of: "|", with: "").prefix(200)
            let width = params.optionalString("width").flatMap { $0.range(of: #"^(?:\d{1,4}|\d{1,3}%)$"#, options: .regularExpression) != nil ? $0 : nil }
            let markdown = "![\(alt)\(width.map { "|\($0)" } ?? "")](lima-attachment:\(id))"
            return .object(["id": .string(id), "markdown": .string(markdown), "bytes": .number(Double(png.count))])
        }
    }
}

/// Files by name for Lima Search's Files scope: Spotlight's index of the
/// user's home folder (`mdfind -name`), never Library or hidden folders.
/// Local only; the browser asks, and only the user's own UI may.
enum FileSearch {
    static func search(_ query: String, limit: Int) async -> [JSONValue] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (2...120).contains(text.count) else { return [] }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        process.arguments = ["-onlyin", home, "-name", text]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return [] }
        // Spotlight is fast; don't let a slow index hold up search.
        let deadline = Task { try? await Task.sleep(for: .seconds(2)); if process.isRunning { process.terminate() } }
        let data = await Task.detached { pipe.fileHandleForReading.readDataToEndOfFile() }.value
        deadline.cancel()
        let skipped = ["/Library/", "/.Trash/", "/node_modules/", "/.git/"]
        let paths = String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init).filter { path in
            !skipped.contains { path.contains($0) } && !path.dropFirst(home.count).split(separator: "/").contains { $0.hasPrefix(".") }
        }
        // Names that start with the query first, then shorter paths.
        let lower = text.lowercased()
        let ranked = paths.sorted { a, b in
            let (na, nb) = ((a as NSString).lastPathComponent.lowercased(), (b as NSString).lastPathComponent.lowercased())
            let (sa, sb) = (na.hasPrefix(lower), nb.hasPrefix(lower))
            return sa != sb ? sa : a.count < b.count
        }
        return ranked.prefix(limit).map { path in
            var directory: ObjCBool = false
            FileManager.default.fileExists(atPath: path, isDirectory: &directory)
            return .object(["path": .string(path), "name": .string((path as NSString).lastPathComponent), "directory": .bool(directory.boolValue)])
        }
    }
}

extension Runtime {
    func registerFileSearch() {
        register("files.search") { params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "File search is for Lima Search.") }
            return .array(await FileSearch.search(try params.string("query"), limit: params.limit("limit", default: 20, maximum: 50)))
        }
    }
}
