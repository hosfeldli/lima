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

public extension JSONValue {
    var doubleValue: Double? { if case .number(let v) = self { return v }; return nil }
    /// A whole number in Int's range; nil for fractions out of range, NaN or ±∞
    /// (a bare Int(_:) conversion traps on those).
    var intValue: Int? { doubleValue.flatMap { $0.isFinite ? Int(exactly: $0.rounded(.towardZero)) : nil } }
    var boolValue: Bool? { if case .bool(let v) = self { return v }; return nil }
    var objectValue: [String: JSONValue]? { if case .object(let v) = self { return v }; return nil }
}

public extension Optional where Wrapped == JSONValue {
    /// Required string parameter or a bad_request error.
    func string(_ key: String) throws -> String {
        guard let value = self?[key]?.stringValue else { throw BridgeError(.badRequest, "missing string parameter '\(key)'") }
        return value
    }
    func optionalString(_ key: String) -> String? { self?[key]?.stringValue }
    func int(_ key: String, default value: Int) -> Int { self?[key]?.intValue ?? value }
    /// A count or limit from a caller, kept within 0...maximum.
    func limit(_ key: String, default value: Int, maximum: Int) -> Int { Swift.min(Swift.max(int(key, default: value), 0), maximum) }
    func double(_ key: String, default value: Double) -> Double { self?[key]?.doubleValue ?? value }
    func bool(_ key: String, default value: Bool) -> Bool { self?[key]?.boolValue ?? value }
    func decode<T: Decodable>(_ key: String, as type: T.Type) throws -> T {
        guard let value = self?[key] else { throw BridgeError(.badRequest, "missing parameter '\(key)'") }
        do { return try value.decode(as: T.self) } catch { throw BridgeError(.badRequest, "invalid parameter '\(key)'") }
    }
}
