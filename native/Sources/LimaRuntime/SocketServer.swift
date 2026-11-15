import Darwin
import Foundation
import LimaProtocol

/// Local-only Unix-domain socket transport for the runtime daemon.
///
/// Authentication: the socket lives in a 0700 directory owned by the user,
/// and every connection's peer UID is checked with getpeereid, so only the
/// same user's processes can connect. Nothing listens on the network.
public final class SocketServer: @unchecked Sendable {
    public typealias Handler = @Sendable (_ client: ClientConnection, _ payload: Data) -> Void

    private let path: String
    private var listenFD: Int32 = -1
    private let onConnect: @Sendable (ClientConnection) -> Void
    private let onDisconnect: @Sendable (ClientConnection) -> Void
    private let handler: Handler

    public init(path: String, onConnect: @escaping @Sendable (ClientConnection) -> Void,
                onDisconnect: @escaping @Sendable (ClientConnection) -> Void, handler: @escaping Handler) {
        self.path = path
        self.onConnect = onConnect
        self.onDisconnect = onDisconnect
        self.handler = handler
    }

    public func start() throws {
        let directory = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        chmod(directory, 0o700)
        // The caller holds the runtime lock, so any existing socket file is stale.
        unlink(path)

        listenFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listenFD >= 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
        var address = SocketServer.address(path)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listenFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
        chmod(path, 0o600)
        guard listen(listenFD, 16) == 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }

        Thread.detachNewThread { [self] in acceptLoop() }
    }

    private func acceptLoop() {
        while true {
            let fd = accept(listenFD, nil, nil)
            if fd < 0 {
                if errno == EINTR { continue }
                return
            }
            var uid: uid_t = 0, gid: gid_t = 0
            guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else {
                close(fd)
                continue
            }
            var noSigPipe: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
            let client = ClientConnection(fd: fd)
            onConnect(client)
            Thread.detachNewThread { [self] in readLoop(client) }
        }
    }

    private func readLoop(_ client: ClientConnection) {
        var decoder = BridgeFrame.Decoder()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = read(client.fd, &buffer, buffer.count)
            if count <= 0 {
                if count < 0 && errno == EINTR { continue }
                break
            }
            guard let payloads = try? decoder.append(Data(buffer[0..<count])) else { break }
            for payload in payloads { handler(client, payload) }
        }
        client.close()
        onDisconnect(client)
    }

    static func address(_ path: String) -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8.prefix(103))
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        return address
    }

    /// Connects as a client; returns the fd or nil when nothing is listening.
    public static func connect(path: String) -> Int32? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var address = address(path)
        let status = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard status == 0 else { close(fd); return nil }
        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        return fd
    }
}

public final class ClientConnection: @unchecked Sendable, Hashable {
    public let id = UUID()
    let fd: Int32
    private let writeLock = NSLock()
    private var closed = false

    init(fd: Int32) { self.fd = fd }

    public func send(_ payload: Data) {
        let frame = BridgeFrame.encode(payload)
        writeLock.lock(); defer { writeLock.unlock() }
        guard !closed else { return }
        frame.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if written < 0 {
                    if errno == EINTR || errno == EAGAIN { continue }
                    closed = true
                    return
                }
                offset += written
            }
        }
    }

    func close() {
        writeLock.lock(); defer { writeLock.unlock() }
        guard !closed else { return }
        closed = true
        Darwin.close(fd)
    }

    public static func == (lhs: ClientConnection, rhs: ClientConnection) -> Bool { lhs.id == rhs.id }
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// Single-instance guard: an exclusive flock held for the daemon's life.
public enum RuntimeLock {
    public static func acquire(at path: String) -> Int32? {
        let fd = open(path, O_RDWR | O_CREAT, 0o600)
        guard fd >= 0 else { return nil }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); return nil }
        return fd
    }
}
