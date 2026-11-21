import Foundation
import LimaProtocol
import LimaTerminal

struct WorkspaceArchive: Sendable {
    let zip: URL
    let source: URL
    let staged: URL?

    static var directory: URL {
        let root = WorkspaceService.root
        return root.deletingLastPathComponent().appendingPathComponent(root.lastPathComponent + " Archive", isDirectory: true)
    }

    static func stagingDirectory(for workspace: Workspace) -> URL {
        URL(fileURLWithPath: workspace.directory, isDirectory: true).deletingLastPathComponent()
            .appendingPathComponent(".lima-archive-" + workspace.id, isDirectory: true)
    }

    static func prepare(_ workspace: Workspace, moveSource: Bool) throws -> Self {
        let fm = FileManager.default
        let source = URL(fileURLWithPath: workspace.directory, isDirectory: true).resolvingSymlinksInPath()
        let archive = directory.resolvingSymlinksInPath()
        guard archive.path != source.path, !archive.path.hasPrefix(source.path + "/") else {
            throw BridgeError(.badRequest, "The archive folder is inside the workspace. Choose a separate workspace folder.")
        }
        try fm.createDirectory(at: archive, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let suffix = UUID().uuidString.lowercased()
        let label = String(source.lastPathComponent.prefix(64))
        let zip = archive.appendingPathComponent(label + "-" + suffix + ".zip")
        let pendingZip = archive.appendingPathComponent("." + suffix + ".partial")
        defer { try? fm.removeItem(at: pendingZip) }

        // Rename a managed folder on the same volume so the original stays
        // recoverable and ditto can preserve its directory name in the ZIP.
        let staging = stagingDirectory(for: workspace)
        let staged = moveSource ? staging.appendingPathComponent(source.lastPathComponent, isDirectory: true) : nil
        if let staged {
            try fm.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            do { try fm.moveItem(at: source, to: staged) }
            catch {
                try? fm.removeItem(at: staging)
                throw error
            }
        }

        do {
            try run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", (staged ?? source).path, pendingZip.path])
            try run("/usr/bin/unzip", ["-tq", pendingZip.path])
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: pendingZip.path)
            try fm.moveItem(at: pendingZip, to: zip)
            return Self(zip: zip, source: source, staged: staged)
        } catch {
            if let staged {
                do { try restore(staged, to: source) }
                catch { throw BridgeError(.internalError, "Lima could not restore the workspace. Its files are at \(staged.path).") }
            }
            throw error
        }
    }

    static func recover(_ workspace: Workspace) {
        let source = URL(fileURLWithPath: workspace.directory, isDirectory: true)
        let staged = stagingDirectory(for: workspace).appendingPathComponent(source.lastPathComponent, isDirectory: true)
        let fm = FileManager.default
        if fm.fileExists(atPath: staged.path), !fm.fileExists(atPath: source.path) {
            try? restore(staged, to: source)
        }
    }

    private static func restore(_ staged: URL, to source: URL) throws {
        try FileManager.default.moveItem(at: staged, to: source)
        try? FileManager.default.removeItem(at: staged.deletingLastPathComponent())
    }

    func rollback() throws {
        if let staged { try Self.restore(staged, to: source) }
        try? FileManager.default.removeItem(at: zip)
    }

    private static func run(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        let diagnostic = Pipe()
        process.standardError = diagnostic
        try process.run()
        let output = diagnostic.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let detail = String(decoding: output.prefix(500), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw BridgeError(.badRequest, detail.isEmpty ? "Lima could not create or verify the workspace archive." : "Archive failed. \(detail)")
        }
    }
}

extension Runtime {
    func archiveWorkspace(_ id: String) async throws -> JSONValue {
        let group = try await workspaces.beginRemoval(id)
        let ids = group.map(\.id)
        var terminalsClosed = false
        do {
            let workspace = group[0]
            let summaries = await conversations.list()
            let active = Set(summaries.filter { $0.running || $0.lastStatus == .streaming }.map(\.id))
            let members = Set(group.compactMap(\.conversationID))
            guard active.isDisjoint(with: members) else {
                throw BridgeError(.badRequest, "Stop the active workspace agents before archiving.")
            }
            let managed = workspace.parentID == nil ? await workspaces.ownsDirectory(workspace) : false
            do {
                try await terminals.closeForArchive(group.compactMap(\.terminalID), managedDirectory: managed ? workspace.directory : nil)
                terminalsClosed = true
            } catch TerminalServiceError.busy {
                throw BridgeError(.badRequest, "Finish active terminal commands, clear pending input, and close other terminals using this folder before archiving.")
            }
            let archive: WorkspaceArchive?
            if workspace.parentID == nil {
                archive = try await Task.detached(priority: .utility) {
                    try WorkspaceArchive.prepare(workspace, moveSource: managed)
                }.value
            } else { archive = nil }

            do { try await workspaces.commitRemoval(ids) }
            catch {
                if let archive {
                    do { try archive.rollback() }
                    catch {
                        throw BridgeError(.internalError, "Lima could not restore the original folder. The verified archive is at \(archive.zip.path).")
                    }
                }
                throw error
            }

            for item in group.reversed() {
                await workspacePrompts.clear(self, workspace: item.id)
                if let conversation = item.conversationID {
                    await conversations.cancel(conversation)
                    search.index.remove(source: "conversation", id: conversation)
                }
                broadcast("workspace.deleted", .object(["id": .string(item.id), "parentId": item.parentID.map(JSONValue.string) ?? .null]))
            }

            var recovery: String?
            if let staged = archive?.staged {
                do { try FileManager.default.removeItem(at: staged.deletingLastPathComponent()) }
                catch { recovery = staged.path }
            }
            return .object([
                "archivePath": archive.map { .string($0.zip.path) } ?? .null,
                "directoryKept": archive?.staged == nil ? .string(workspace.directory) : .null,
                "recoveryPath": recovery.map(JSONValue.string) ?? .null,
            ])
        } catch {
            await workspaces.cancelRemoval(ids)
            if terminalsClosed {
                for workspace in group where workspace.terminalID != nil && FileManager.default.fileExists(atPath: workspace.directory) {
                    _ = try? await ensureTerminal(workspace)
                }
            }
            throw error
        }
    }
}
