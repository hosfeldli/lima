import AppKit
import Foundation
import LimaProtocol
import SQLite3

/// Messages (iMessage and SMS) for agents: reading recent texts and sending
/// one. Off until the user turns it on in Lima → Integrations. Reading needs
/// macOS Full Disk Access for Lima (it reads ~/Library/Messages/chat.db,
/// read-only); sending goes through the Messages app, which macOS asks about
/// once. An agent asks before reading (once per task) and before every send.
enum MessagesStore {
    struct Message: Sendable {
        var chat: String
        var chatName: String
        var from: String
        var fromMe: Bool
        var text: String
        var date: Date
    }

    /// Tests point this at a stand-in database.
    nonisolated(unsafe) static var databaseOverride: URL?

    static var database: URL {
        databaseOverride ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Messages/chat.db")
    }

    enum Failure: Error { case noAccess, unreadable(String) }

    /// Recent messages, newest first, optionally only one conversation
    /// (`chat` matches the phone number, email or group name).
    static func recent(chat: String? = nil, limit: Int = 50) throws -> [Message] {
        var db: OpaquePointer?
        let path = "file:\(database.path)?mode=ro"
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK, let db else {
            sqlite3_close(db)
            throw FileManager.default.isReadableFile(atPath: database.path) ? Failure.unreadable("Messages couldn't be opened.") : Failure.noAccess
        }
        defer { sqlite3_close(db) }
        var sql = """
        SELECT c.chat_identifier, COALESCE(c.display_name, ''), COALESCE(h.id, ''), m.is_from_me, m.text, m.attributedBody, m.date
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.associated_message_type = 0
        """
        if chat != nil { sql += " AND (c.chat_identifier LIKE ?1 OR c.display_name LIKE ?1 OR h.id LIKE ?1)" }
        sql += " ORDER BY m.date DESC LIMIT \(max(1, min(limit, 200)))"
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            // An unreadable file reads as "no such table" without Full Disk Access.
            throw Failure.noAccess
        }
        defer { sqlite3_finalize(statement) }
        if let chat {
            let pattern = "%\(chat.filter { !"%_".contains($0) })%"
            sqlite3_bind_text(statement, 1, pattern, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        }
        var messages: [Message] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            let column = { (index: Int32) in sqlite3_column_text(statement, index).map { String(cString: $0) } ?? "" }
            var text = column(4)
            if text.isEmpty, let blob = sqlite3_column_blob(statement, 5) {
                text = decodeBody(Data(bytes: blob, count: Int(sqlite3_column_bytes(statement, 5)))) ?? ""
            }
            guard !text.isEmpty else { continue }
            // Nanoseconds since 2001 (seconds on very old databases).
            let raw = Double(sqlite3_column_int64(statement, 6))
            let date = Date(timeIntervalSinceReferenceDate: raw > 1e12 ? raw / 1e9 : raw)
            messages.append(Message(chat: column(0), chatName: column(1), from: column(2), fromMe: sqlite3_column_int(statement, 3) == 1,
                                    text: String(text.prefix(2000)), date: date))
        }
        return messages
    }

    /// Newer macOS keeps the text in `attributedBody` (a typedstream archive).
    static func decodeBody(_ data: Data) -> String? {
        if let string = (try? NSUnarchiver.unarchiveObject(with: data)) as? NSAttributedString { return string.string }
        if let string = NSUnarchiver.unarchiveObject(with: data) as? NSAttributedString { return string.string }
        return nil
    }

    /// Sends through the Messages app (iMessage, falling back to SMS).
    static func send(to recipient: String, text: String) throws {
        let script = """
        on run argv
          set targetId to item 1 of argv
          set body to item 2 of argv
          tell application "Messages"
            try
              set targetService to 1st account whose service type = iMessage
              send body to participant targetId of targetService
            on error
              set targetService to 1st account whose service type = SMS
              send body to participant targetId of targetService
            end try
          end tell
        end run
        """
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script, recipient, text]
        let errors = Pipe()
        process.standardError = errors
        process.standardOutput = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let detail = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            if detail.contains("-1743") || detail.lowercased().contains("not allowed") {
                throw BridgeError(.notAuthorized, "macOS didn't let Lima use Messages. Allow it in System Settings → Privacy & Security → Automation.")
            }
            throw BridgeError(.internalError, "Messages couldn't send it: \(detail.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))")
        }
    }

    /// A phone number or email address, nothing else.
    static func validRecipient(_ value: String) -> String? {
        let text = value.trimmingCharacters(in: .whitespaces)
        if text.range(of: #"^\+?[0-9 ()\-.]{5,20}$"#, options: .regularExpression) != nil { return text.filter { $0.isNumber || $0 == "+" } }
        if text.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) != nil { return text }
        return nil
    }
}

extension Runtime {
    func messagesEnabled() async -> Bool {
        (try? await store.get(Bool.self, collection: "settings", id: "integrations.messages")) ?? false
    }

    func registerMessages() {
        register("messages.settings") { [unowned self] params, context in
            if let enabled = params?["enabled"]?.boolValue {
                try Self.requireLocalSettings(context)
                try await self.store.put(enabled, collection: "settings", id: "integrations.messages")
            }
            let readable = FileManager.default.isReadableFile(atPath: MessagesStore.database.path)
                && ((try? MessagesStore.recent(limit: 1)) != nil)
            return .object(["enabled": .bool(await self.messagesEnabled()), "fullDiskAccess": .bool(readable)])
        }
        register("messages.recent") { [unowned self] params, context in
            guard await self.messagesEnabled() else {
                throw BridgeError(.notAuthorized, "Messages isn't turned on. The user can turn it on in Lima → Integrations → Messages.")
            }
            let chat = params.optionalString("chat").flatMap { $0.isEmpty ? nil : String($0.prefix(100)) }
            if context.origin != .browser {
                try await self.approveAction(context, question: chat.map { "Let the agent read your texts with \($0)?" } ?? "Let the agent read your recent texts?",
                    facts: [.init(label: "Reads", value: chat.map { "Recent messages with \($0)" } ?? "Your most recent messages")],
                    detail: "Lima reads them from Messages on this Mac and sends them to your AI provider for this task.",
                    risk: "access", allowTask: true)
            }
            do {
                let messages = try MessagesStore.recent(chat: chat, limit: params.limit("limit", default: 30, maximum: 200))
                let formatter = ISO8601DateFormatter()
                return .array(messages.map { message in
                    .object(["chat": .string(message.chatName.isEmpty ? message.chat : message.chatName), "from": .string(message.fromMe ? "me" : message.from),
                             "text": .string(message.text), "date": .string(formatter.string(from: message.date))])
                })
            } catch MessagesStore.Failure.noAccess {
                throw BridgeError(.notAuthorized, "Lima needs Full Disk Access to read Messages. The user can allow it in System Settings → Privacy & Security → Full Disk Access.")
            }
        }
        register("messages.send") { [unowned self] params, context in
            guard await self.messagesEnabled() else {
                throw BridgeError(.notAuthorized, "Messages isn't turned on. The user can turn it on in Lima → Integrations → Messages.")
            }
            guard let to = MessagesStore.validRecipient(try params.string("to")) else {
                throw BridgeError(.badRequest, "Send to a phone number or an email address.")
            }
            let text = try params.string("text").trimmingCharacters(in: .whitespacesAndNewlines)
            guard (1...2000).contains(text.count) else { throw BridgeError(.badRequest, "Write a message of 1–2,000 characters.") }
            // Every text asks first, showing exactly what goes to whom.
            if context.origin != .browser {
                try await self.approveAction(context, question: "Send this text?",
                    facts: [.init(label: "To", value: to), .init(label: "Message", value: text)],
                    detail: "Lima sends it from your Messages account.", risk: "account")
            }
            try MessagesStore.send(to: to, text: text)
            return .object(["sent": .bool(true), "to": .string(to)])
        }
    }
}
