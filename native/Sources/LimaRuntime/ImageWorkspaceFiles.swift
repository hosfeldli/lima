import Darwin
import Foundation
import LimaProtocol

/// All project access is relative to an already-open workspace directory.
enum ImageWorkspaceFiles {
    static func read(root: String, path: String) throws -> Data {
        try withParent(root, path) { parent, name in
            let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard fd >= 0 else { throw ImageRaster.invalid("Could not open the project image.") }
            let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            var info = stat()
            guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= ImageRaster.maxFileBytes else {
                throw ImageRaster.invalid("Choose a regular image file no larger than 32 MB.")
            }
            var data = Data()
            while data.count <= ImageRaster.maxFileBytes {
                guard let chunk = try file.read(upToCount: min(64 * 1024, ImageRaster.maxFileBytes + 1 - data.count)), !chunk.isEmpty else { return data }
                data.append(chunk)
            }
            throw ImageRaster.invalid("The image exceeds the file-size limit.")
        }
    }

    static func export(root: String, path: String, data: Data) throws {
        try withParent(root, path) { parent, name in
            let temporary = ".lima-image-" + UUID().uuidString
            let fd = openat(parent, temporary, O_NOFOLLOW | O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o644)
            guard fd >= 0 else { throw ImageRaster.invalid("Could not prepare an export in that directory.") }
            let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            defer { _ = unlinkat(parent, temporary, 0) }
            try file.write(contentsOf: data)
            try file.synchronize()
            guard linkat(parent, temporary, parent, name, 0) == 0 else {
                if errno == EEXIST { throw ImageRaster.invalid("That file already exists. Choose a new export name.") }
                throw ImageRaster.invalid("The export could not be written.")
            }
        }
    }

    static func verifyNewOutput(root: String, path: String) throws {
        try withParent(root, path) { parent, name in
            var info = stat()
            guard fstatat(parent, name, &info, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else {
                throw ImageRaster.invalid("The export filename is unavailable. Choose a new name.")
            }
        }
    }

    private static func withParent<T>(_ root: String, _ path: String, _ body: (Int32, String) throws -> T) throws -> T {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard (1...24).contains(parts.count), parts.allSatisfy({ !$0.isEmpty && !$0.hasPrefix(".") && !$0.contains("\0") && $0.utf8.count <= 255 }),
              let name = parts.last else {
            throw BridgeError(.notAuthorized, "Choose a visible workspace-relative path.")
        }
        let rootFD = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard rootFD >= 0 else { throw BridgeError(.notAuthorized, "The workspace directory is unavailable.") }
        var parent = rootFD
        defer { close(parent) }
        for part in parts.dropLast() {
            let next = openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard next >= 0 else { throw BridgeError(.notAuthorized, "Choose an existing directory inside this workspace.") }
            close(parent)
            parent = next
        }
        return try body(parent, name)
    }
}
