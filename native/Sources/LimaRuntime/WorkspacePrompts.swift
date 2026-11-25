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
        /// Who's waiting on the answer. Nil once the agent's tool call gave
        /// up (its turn ended or timed out): the card stays until the user
        /// answers, and the answer then reaches the agent as a chat message.
        var continuation: CheckedContinuation<JSONValue, Error>?
        /// A tool call is waiting on the answer (false: a card for an agent
        /// whose turn already ended, such as a blocked task's).
        var waiting = true
    }

    /// An answer to a card no tool call waits on any more.
    struct LateAnswer: Sendable {
        let workspace: String
        let question: String
        let approval: Bool
        let result: JSONValue
    }

    private var requests: [String: Request] = [:]
    /// An approved browser session. It belongs to a workspace family (a lead
    /// agent and its helpers), so what the user approved for one agent covers
    /// the agents working with it. `trusted` means the user chose "Allow for
    /// this task": sensitive controls inside it no longer ask each time.
    struct Session {
        var family: String
        var origin: String
        var paths: Set<String>
        var actions: Set<String>
        var expires: Date
        var trusted: Bool
        var limit: Date
    }
    private var sessions: [String: Session] = [:]
    /// Idle time a session survives; each permitted action renews it, up to its limit.
    static let sessionIdle: TimeInterval = 300
    static let onceLimit: TimeInterval = 1800
    static let taskLimit: TimeInterval = 4 * 3600
    static let browserActions: Set<String> = ["click", "type", "scroll"]

    enum BrowserReview {
        /// highRisk: real money or irreversible account changes. The user
        /// approves each exact plan in Lima, and the decision is never remembered.
        case routine, needsUser, highRisk
    }

    static func browserReview(goal: String, plan: String) -> BrowserReview {
        let intent = goal + " " + plan
        if intent.range(of: #"\b(?:place (?:a |the |any )?bets?|betting|wagers?|stake cash|submit payment|place order|transfer funds|delete account|send message|publish|change password)\b"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return .highRisk
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

    /// One labelled fact shown on an approval card (Site, Control, Paths…).
    struct Fact { let label: String; let value: String }

    func ask(_ runtime: Runtime, workspace: Workspace, question: String, detail: String?, approval: Bool, fields: [WorkspaceQuestionField] = [], actionLabel: String? = nil,
             facts: [Fact] = [], risk: String? = nil, allowTask: Bool = false, id: String = UUID().uuidString, expires: Bool = true) async throws -> JSONValue {
        try await ask(runtime, ownerID: workspace.id, ownerName: workspace.name, parentID: workspace.parentID, question: question, detail: detail,
                      approval: approval, fields: fields, actionLabel: actionLabel, facts: facts, risk: risk, allowTask: allowTask, id: id, expires: expires)
    }

    /// A request from something other than a workspace agent (an outside AI
    /// tool over MCP). It shows in the Companion like any other request.
    func ask(_ runtime: Runtime, ownerID: String, ownerName: String, parentID: String? = nil, question: String, detail: String?, approval: Bool,
             fields: [WorkspaceQuestionField] = [], actionLabel: String? = nil,
             facts: [Fact] = [], risk: String? = nil, allowTask: Bool = false,
             id: String = UUID().uuidString, expires: Bool = true) async throws -> JSONValue {
        guard question.count <= 1200, !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw BridgeError(.badRequest, "Provide a question of 1–1,200 characters.")
        }
        guard !requests.values.contains(where: { $0.workspace == ownerID && $0.waiting && $0.continuation != nil }) else {
            throw BridgeError(.badRequest, "This workspace already has a pending question. Wait for the user to answer it, then try again.")
        }
        // Asking the same thing again replaces the card left from an earlier turn.
        for (old, request) in requests where request.workspace == ownerID && request.continuation == nil
            && request.data["question"]?.stringValue == question {
            requests.removeValue(forKey: old)
            runtime.broadcast("prompt.closed", .object(["id": .string(old), "workspaceId": .string(ownerID)]))
        }
        let form = try JSONValue.from(fields)
        return try await withCheckedThrowingContinuation { continuation in
            let data: JSONValue = .object([
                "id": .string(id), "workspaceId": .string(ownerID),
                "workspaceName": .string(ownerName), "question": .string(question),
                // A helper's request also shows in its parent workspace, where the user is.
                "parentWorkspaceId": parentID.map(JSONValue.string) ?? .null,
                "detail": detail.map(JSONValue.string) ?? .null, "approval": .bool(approval),
                "fields": form, "actionLabel": actionLabel.map(JSONValue.string) ?? .null,
                "facts": .array(facts.map { .object(["label": .string($0.label), "value": .string(String($0.value.prefix(400)))]) }),
                "risk": risk.map(JSONValue.string) ?? .null,
                // "Allow for this task" alongside "Allow once".
                "allowTask": .bool(allowTask),
            ])
            requests[id] = Request(workspace: ownerID, fields: fields, data: data, continuation: continuation, waiting: expires)
            runtime.broadcast("prompt.opened", data)
            // A tool call waiting on the answer times out at 600 s; before
            // then it's released, and the card stays until the user answers.
            if expires {
                Task {
                    try? await Task.sleep(for: .seconds(540))
                    release(id)
                }
            }
        }
    }

    func list() -> JSONValue { .array(requests.values.map(\.data)) }

    func answer(_ runtime: Runtime, id: String, approved: Bool, text: String?, values: JSONValue? = nil, scope: String? = nil) throws {
        guard let pending = requests[id] else { throw BridgeError(.badRequest, "This request has already been answered.") }
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
        let task = approved && scope == "task" && pending.data["allowTask"]?.boolValue == true
        finish(runtime, id: id, result: .success(.object(["approved": .bool(approved), "answer": .string(String(answer.prefix(8000))),
                                                          "scope": .string(task ? "task" : "once")])))
    }

    func clear(_ runtime: Runtime, workspace: String) {
        for id in requests.keys.filter({ requests[$0]?.workspace == workspace }) { expire(runtime, id: id) }
        // A lead workspace closing ends its family's sessions; a helper's doesn't.
        sessions = sessions.filter { $0.value.family != workspace }
    }

    /// The workspace's agent finished its turn (or was stopped), so no tool
    /// call is waiting on its open cards any more. The cards stay; answering
    /// one later resumes the agent's chat.
    func replyEnded(_ runtime: Runtime, workspace: String) {
        for (id, request) in requests where request.workspace == workspace && request.waiting { release(id) }
    }

    /// Lets the waiting tool call go without closing the card.
    private func release(_ id: String) {
        guard var request = requests[id], let continuation = request.continuation else { return }
        request.continuation = nil
        request.waiting = false
        requests[id] = request
        continuation.resume(throwing: BridgeError(.deadlineExceeded,
            "The user hasn't answered yet. The request stays open in Lima; their answer will come to you as a new chat message. Don't ask again and don't work around it; end your turn with what you have."))
    }

    /// Open cards for a workspace (its own, not its helpers').
    func hasCard(workspace: String) -> Bool { requests.values.contains { $0.workspace == workspace } }

    /// Closes one request without an answer.
    func close(_ runtime: Runtime, id: String) { expire(runtime, id: id) }

    private func expire(_ runtime: Runtime, id: String) {
        finish(runtime, id: id, result: .failure(BridgeError(.deadlineExceeded, "The user request closed without a response.")))
    }

    private func finish(_ runtime: Runtime, id: String, result: Result<JSONValue, Error>) {
        guard let pending = requests.removeValue(forKey: id) else { return }
        runtime.broadcast("prompt.closed", .object(["id": .string(id), "workspaceId": .string(pending.workspace)]))
        if let continuation = pending.continuation { continuation.resume(with: result); return }
        // Nobody's waiting: an answer goes to the agent as a message.
        guard case .success(let value) = result else { return }
        let late = LateAnswer(workspace: pending.workspace, question: pending.data["question"]?.stringValue ?? "",
                              approval: pending.data["approval"]?.boolValue == true, result: value)
        Task { await runtime.resumeAfterAnswer(late) }
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

    static func origin(of url: String) -> String? {
        guard let parts = URLComponents(string: url), let scheme = parts.scheme, let host = parts.host else { return nil }
        return "\(scheme)://\(host)\(parts.port.map { ":\($0)" } ?? "")"
    }

    func authorize(family: String, url: String, paths: Set<String>, actions: Set<String>, trusted: Bool = false, now: Date = Date()) -> String {
        sessions = sessions.filter { $0.value.expires > now }
        let token = UUID().uuidString
        sessions[token] = Session(family: family, origin: Self.origin(of: url) ?? url, paths: paths, actions: actions,
                                  expires: now.addingTimeInterval(Self.sessionIdle), trusted: trusted,
                                  limit: now.addingTimeInterval(trusted ? Self.taskLimit : Self.onceLimit))
        return token
    }

    /// An active session in the same family that already covers this site,
    /// these paths and actions: approved for one agent, usable by the others.
    func covering(family: String, url: String, paths: Set<String>, actions: Set<String>, highRisk: Bool, now: Date = Date()) -> String? {
        let origin = Self.origin(of: url)
        return sessions.first { _, session in
            session.family == family && session.origin == origin && session.expires > now &&
                paths.isSubset(of: session.paths) && actions.isSubset(of: session.actions) && (!highRisk || session.trusted)
        }?.key
    }

    func permittedPaths(_ token: String?, family: String, url: String, action: String, now: Date = Date()) -> Set<String>? {
        guard let token, var session = sessions[token], session.family == family, session.origin == Self.origin(of: url),
              session.actions.contains(action), session.expires > now else { return nil }
        session.expires = min(session.limit, max(session.expires, now.addingTimeInterval(Self.sessionIdle)))
        sessions[token] = session
        return session.paths
    }

    func isTrusted(_ token: String?) -> Bool { token.flatMap { sessions[$0]?.trusted } ?? false }

    /// After the user approves a sensitive step: optionally trust the session
    /// for the rest of the task, and add a path they allowed it to visit.
    func grant(_ token: String?, trust: Bool, path: String? = nil, now: Date = Date()) -> Set<String>? {
        guard let token, var session = sessions[token] else { return nil }
        if trust && !session.trusted {
            session.trusted = true
            session.limit = now.addingTimeInterval(Self.taskLimit)
        }
        if let path { session.paths.insert(path) }
        session.expires = min(session.limit, max(session.expires, now.addingTimeInterval(Self.sessionIdle)))
        sessions[token] = session
        return session.paths
    }
}
