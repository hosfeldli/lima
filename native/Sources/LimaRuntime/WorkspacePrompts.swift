import CryptoKit
import Foundation
import LimaStorage
import LimaProtocol

struct WorkspaceQuestionField: Codable, Sendable {
    enum Kind: String, Codable, CaseIterable { case text, date, time, number, select, checkbox }

    let id: String
    let label: String
    let type: Kind
    let required: Bool?
    let options: [String]?
    let min: Double?
    let max: Double?

    static func parse(_ value: JSONValue?) throws -> [Self] {
        guard let value, value != .null else { return [] }
        guard let list = value.arrayValue, (1...8).contains(list.count),
              let fields = try? JSONDecoder().decode([Self].self, from: JSONEncoder().encode(value)) else {
            throw BridgeError(.badRequest, "Use one to eight form fields with id, label, and type.")
        }
        var ids = Set<String>()
        for field in fields {
            guard field.id.range(of: #"^[a-zA-Z][a-zA-Z0-9_-]{0,39}$"#, options: .regularExpression) != nil,
                  ids.insert(field.id).inserted, (1...100).contains(field.label.count),
                  !field.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw BridgeError(.badRequest, "Each field needs a unique ID and a short label.")
            }
            if field.type == .select {
                guard let choices = field.options, (1...12).contains(choices.count), Set(choices).count == choices.count,
                      choices.allSatisfy({ (1...100).contains($0.count) }) else {
                    throw BridgeError(.badRequest, "Select fields need one to twelve distinct options.")
                }
            }
            if let min = field.min, let max = field.max, min > max {
                throw BridgeError(.badRequest, "Minimum must be at most maximum.")
            }
        }
        return fields
    }

    func validate(_ value: JSONValue?) throws -> JSONValue? {
        let problem = BridgeError(.badRequest, "Enter a valid value for “\(label)”.")
        guard let value, value != .null, value != .string("") else {
            if required == false { return nil }
            throw problem
        }
        switch type {
        case .number:
            guard let number = value.doubleValue, number.isFinite, number >= (min ?? -.infinity), number <= (max ?? .infinity) else { throw problem }
        case .checkbox:
            guard value.boolValue != nil else { throw problem }
        case .text:
            guard let text = value.stringValue, (1...2000).contains(text.trimmingCharacters(in: .whitespacesAndNewlines).count) else { throw problem }
        case .select:
            guard let option = value.stringValue, options?.contains(option) == true else { throw problem }
        case .time:
            guard let time = value.stringValue,
                  time.range(of: #"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$"#, options: .regularExpression) != nil else { throw problem }
        case .date:
            guard let date = value.stringValue, date.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"#, options: .regularExpression) != nil else { throw problem }
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "yyyy-MM-dd"
            guard let parsed = formatter.date(from: date), formatter.string(from: parsed) == date else { throw problem }
        }
        return value
    }

    static let schema: JSONValue = .object([
        "type": .string("array"), "minItems": .number(1), "maxItems": .number(8),
        "items": .object([
            "type": .string("object"), "required": .array(["id", "label", "type"].map(JSONValue.string)),
            "properties": .object([
                "id": .object(["type": .string("string")]),
                "label": .object(["type": .string("string")]),
                "type": .object(["enum": .array(Kind.allCases.map { .string($0.rawValue) })]),
                "required": .object(["type": .string("boolean")]),
                "options": .object(["type": .string("array"), "items": .object(["type": .string("string")])]),
                "min": .object(["type": .string("number")]),
                "max": .object(["type": .string("number")]),
            ]),
        ]),
    ])
}

actor WorkspacePrompts {
    private struct Request {
        let workspace: String
        let fields: [WorkspaceQuestionField]
        let data: JSONValue
        let continuation: CheckedContinuation<JSONValue, Error>
    }

    private var requests: [String: Request] = [:]
    private var sessions: [String: (workspace: String, url: String, paths: Set<String>, actions: Set<String>, expires: Date)] = [:]
    static let browserActions: Set<String> = ["click", "type", "scroll"]

    enum BrowserReview {
        case routine, needsUser, directUserOnly
    }

    static func browserReview(goal: String, plan: String) -> BrowserReview {
        let intent = goal + " " + plan
        if intent.range(of: #"\b(?:place (?:a |the |any )?bets?|betting|wagers?|stake cash|submit payment|place order|transfer funds|delete account|send message|publish|change password)\b"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return .directUserOnly
        }
        if intent.range(of: #"\b(?:payment|purchase|checkout|deposit|withdraw|credentials|password|private key|authorization|sign[ -]?in|unsubscribe|delete|remove|download|upload|submit|external sharing)\b"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return .needsUser
        }
        return .routine
    }

    static func permissionKey(scope: String, goal: String, plan: String) -> String {
        let fields = [scope, goal, plan].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let data = Data(fields.map { "\($0.utf8.count):\($0)" }.joined().utf8)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func browserPermission(_ key: String, store: EncryptedStore) async throws -> Bool? {
        try await store.get(Bool.self, collection: "browserPermissions", id: key)
    }

    func rememberBrowserPermission(_ value: Bool, key: String, store: EncryptedStore) async throws {
        try await store.put(value, collection: "browserPermissions", id: key)
    }

    func ask(_ runtime: Runtime, workspace: Workspace, question: String, detail: String?, approval: Bool, fields: [WorkspaceQuestionField] = [], actionLabel: String? = nil) async throws -> JSONValue {
        guard question.count <= 1200, !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw BridgeError(.badRequest, "Provide a question of 1–1,200 characters.")
        }
        guard !requests.values.contains(where: { $0.workspace == workspace.id }) else {
            throw BridgeError(.badRequest, "This workspace already has a pending question.")
        }
        let id = UUID().uuidString
        let form = try JSONValue.from(fields)
        return try await withCheckedThrowingContinuation { continuation in
            let data: JSONValue = .object([
                "id": .string(id), "workspaceId": .string(workspace.id),
                "workspaceName": .string(workspace.name), "question": .string(question),
                "detail": detail.map(JSONValue.string) ?? .null, "approval": .bool(approval),
                "fields": form, "actionLabel": actionLabel.map(JSONValue.string) ?? .null,
            ])
            requests[id] = Request(workspace: workspace.id, fields: fields, data: data, continuation: continuation)
            runtime.broadcast("prompt.opened", data)
            Task {
                try? await Task.sleep(for: .seconds(540))
                expire(runtime, id: id)
            }
        }
    }

    func list() -> JSONValue { .array(requests.values.map(\.data)) }

    func answer(_ runtime: Runtime, id: String, approved: Bool, text: String?, values: JSONValue? = nil) throws {
        guard let pending = requests[id] else { throw BridgeError(.badRequest, "This request has already closed.") }
        let answer = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if approved, !pending.fields.isEmpty {
            var answer: [String: JSONValue] = [:]
            for field in pending.fields { answer[field.id] = try field.validate(values?[field.id]) }
            finish(runtime, id: id, result: .success(.object(["approved": .bool(true), "values": .object(answer)])))
            return
        }
        if approved, pending.data["approval"]?.boolValue != true, answer.isEmpty {
            throw BridgeError(.badRequest, "Enter a response or dismiss the question.")
        }
        finish(runtime, id: id, result: .success(.object(["approved": .bool(approved), "answer": .string(String(answer.prefix(8000)))])))
    }

    func clear(_ runtime: Runtime, workspace: String) {
        for id in requests.keys.filter({ requests[$0]?.workspace == workspace }) { expire(runtime, id: id) }
        sessions = sessions.filter { $0.value.workspace != workspace }
    }

    private func expire(_ runtime: Runtime, id: String) {
        finish(runtime, id: id, result: .failure(BridgeError(.deadlineExceeded, "The user request closed without a response.")))
    }

    private func finish(_ runtime: Runtime, id: String, result: Result<JSONValue, Error>) {
        guard let pending = requests.removeValue(forKey: id) else { return }
        runtime.broadcast("prompt.closed", .object(["id": .string(id), "workspaceId": .string(pending.workspace)]))
        pending.continuation.resume(with: result)
    }

    static func paths(for url: String, proposed: String?) throws -> Set<String> {
        let initial = URLComponents(string: url)?.percentEncodedPath ?? ""
        let paths = (proposed ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let valid = paths.count <= 8 && paths.allSatisfy { path in
            path.hasPrefix("/") && !path.hasPrefix("//") && path.count <= 300 &&
                !path.contains(where: { $0.isWhitespace || "?#".contains($0) || $0.asciiValue == 92 }) &&
                !path.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) &&
                path.range(of: "%(?:2e|2f|5c)", options: [.regularExpression, .caseInsensitive]) == nil
        }
        guard valid else { throw BridgeError(.badRequest, "Use up to eight exact paths on the same website, separated by commas.") }
        return Set(paths + [initial.isEmpty ? "/" : initial])
    }

    func authorize(workspace: String, url: String, paths: Set<String>, actions: Set<String>) -> String {
        let now = Date()
        sessions = sessions.filter { $0.value.expires > now }
        let token = UUID().uuidString
        sessions[token] = (workspace, url, paths, actions, now.addingTimeInterval(300))
        return token
    }

    func permittedPaths(_ token: String?, workspace: String, url: String, action: String) -> Set<String>? {
        guard let token, let session = sessions[token], session.workspace == workspace, session.url == url,
              session.actions.contains(action), session.expires > Date() else { return nil }
        return session.paths
    }
}
