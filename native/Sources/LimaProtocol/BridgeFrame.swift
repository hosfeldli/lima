import Foundation

/// Wire format shared by the browser bridge and lima-host.
///
/// Each frame is a 4-byte little-endian length followed by that many bytes
/// of UTF-8 JSON — the same framing Firefox uses for native messaging, so the
/// chrome side can use Subprocess.sys.mjs pipes without a socket.
public enum BridgeFrame {
    public static let maximumPayloadBytes = 4 * 1024 * 1024

    public enum DecodeError: Error, Equatable {
        case payloadTooLarge(Int)
    }

    public static func encode(_ payload: Data) -> Data {
        var length = UInt32(payload.count).littleEndian
        var frame = Data(bytes: &length, count: 4)
        frame.append(payload)
        return frame
    }

    /// Incremental decoder: feed arbitrary chunks, get back complete payloads.
    public struct Decoder: Sendable {
        private var buffer = Data()

        public init() {}

        public mutating func append(_ chunk: Data) throws -> [Data] {
            buffer.append(chunk)
            var payloads: [Data] = []
            while buffer.count >= 4 {
                let start = buffer.startIndex
                let length = buffer[start..<start + 4].enumerated().reduce(UInt32(0)) { acc, pair in
                    acc | UInt32(pair.element) << (8 * UInt32(pair.offset))
                }
                let size = Int(length)
                guard size <= BridgeFrame.maximumPayloadBytes else {
                    buffer.removeAll()
                    throw DecodeError.payloadTooLarge(size)
                }
                guard buffer.count >= 4 + size else { break }
                payloads.append(Data(buffer[start + 4..<start + 4 + size]))
                buffer.removeFirst(4 + size)
            }
            return payloads
        }
    }
}
