import Foundation

/// Version of the browser ↔ native bridge contract. Bump on any breaking
/// change to method names, parameters, or result shapes.
public let limaBridgeProtocolVersion = 1

/// A loosely typed JSON value so envelopes can carry method-specific payloads
/// while the envelope itself stays strictly versioned.
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    /// Re-encode any Encodable as a JSONValue.
    public static func from<T: Encodable>(_ value: T) throws -> JSONValue {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    public func decode<T: Decodable>(as type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(self))
    }
}

/// Machine-readable failure codes (spec §13: explicit error codes).
public enum BridgeErrorCode: String, Codable, Sendable {
    case badRequest = "bad_request"
    case unsupportedProtocolVersion = "unsupported_protocol_version"
    case unknownMethod = "unknown_method"
    case notAuthorized = "not_authorized"
    case confirmationRequired = "confirmation_required"
    case deadlineExceeded = "deadline_exceeded"
    case internalError = "internal_error"
}

public struct BridgeError: Codable, Equatable, Sendable, Error {
    public var code: BridgeErrorCode
    public var message: String

    public init(_ code: BridgeErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }
}

public struct BridgeRequest: Codable, Equatable, Sendable {
    public var v: Int
    public var id: String
    public var method: String
    public var params: JSONValue?

    public init(id: String, method: String, params: JSONValue? = nil) {
        self.v = limaBridgeProtocolVersion
        self.id = id
        self.method = method
        self.params = params
    }
}

public struct BridgeResponse: Codable, Equatable, Sendable {
    public var v: Int
    public var id: String
    public var ok: Bool
    public var result: JSONValue?
    public var error: BridgeError?

    public static func success(id: String, _ result: JSONValue) -> BridgeResponse {
        BridgeResponse(v: limaBridgeProtocolVersion, id: id, ok: true, result: result, error: nil)
    }

    public static func failure(id: String, _ error: BridgeError) -> BridgeResponse {
        BridgeResponse(v: limaBridgeProtocolVersion, id: id, ok: false, result: nil, error: error)
    }
}

/// Unsolicited host → browser notification (terminal output, agent status…).
public struct BridgeEvent: Codable, Equatable, Sendable {
    public var v: Int
    public var event: String
    public var data: JSONValue

    public init(event: String, data: JSONValue) {
        self.v = limaBridgeProtocolVersion
        self.event = event
        self.data = data
    }
}
