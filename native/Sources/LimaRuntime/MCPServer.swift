import Foundation
import LimaProtocol

/// `lima-host mcp`: a stdio MCP server exposing Lima-owned resources to
/// external agents such as Codex, Claude and OpenCode (spec v1 §5.3).
///
/// Every call goes to the runtime with origin `mcp`, so mutations hit the
/// same authorization policy and user grants as Lima's own agents. Tools
/// have stable names and versioned (`v1`) schemas.
public enum MCPServer {
    struct Tool: Sendable {
        var name: String
        var description: String
        var properties: [String: [String: String]]
        var required: [String]
        var call: @Sendable (JSONValue?, RuntimeClient) throws -> JSONValue
    }

    static let tools: [Tool] = [
        Tool(name: "lima_search", description: "Search Lima notes, conversations, reports, terminal history and tools.",
             properties: ["query": ["type": "string"]], required: ["query"]) { args, client in
            let response = try client.call("search.query", params: .object(["query": args?["query"] ?? .string("")]))
            let results = (response["results"]?.arrayValue ?? []).filter { ["note", "conversation", "report", "terminal", "context", "tool"].contains($0["source"]?.stringValue ?? "") }
            return .array(results)
        },
        Tool(name: "notes_list", description: "List notes (id, title, excerpt).", properties: [:], required: []) { _, client in
            try client.call("notes.list")
        },
        Tool(name: "notes_get", description: "Get a note's full content including canvas blocks.", properties: ["id": ["type": "string"]], required: ["id"]) { args, client in
            try client.call("notes.get", params: .object(["id": args?["id"] ?? .null]))
        },
        Tool(name: "notes_create", description: "Create a classic Markdown note. Requires the user's notes:write grant.",
             properties: ["title": ["type": "string"], "markdown": ["type": "string"]], required: ["title"]) { args, client in
            try client.call("notes.create", params: .object(["title": args?["title"] ?? .string(""), "markdown": args?["markdown"] ?? .string(""), "kind": .string("classic")]))
        },
        Tool(name: "notes_append", description: "Append Markdown to a note as an undoable agent edit. Requires notes:write.",
             properties: ["id": ["type": "string"], "markdown": ["type": "string"]], required: ["id", "markdown"]) { args, client in
            let id = args?["id"] ?? .null
            let note = try client.call("notes.get", params: .object(["id": id]))
            let existing = note["markdown"]?.stringValue ?? ""
            let addition = args?["markdown"]?.stringValue ?? ""
            let edits: JSONValue = .array([.object(["setMarkdown": .object(["_0": .string(existing.isEmpty ? addition : existing + "\n\n" + addition)])])])
            return try client.call("notes.apply", params: .object(["id": id, "edits": edits, "baseRevision": note["revision"] ?? .null, "author": .string("agent:mcp")]))
        },
        Tool(name: "context_recent", description: "Recent activity metadata (no keystrokes or screen content).",
             properties: ["limit": ["type": "number"]], required: []) { args, client in
            try client.call("context.recent", params: .object(["limit": args?["limit"] ?? .number(50)]))
        },
        Tool(name: "reports_list", description: "Weekly activity reports.", properties: [:], required: []) { _, client in
            try client.call("context.reports")
        },
        Tool(name: "terminal_list", description: "List Lima terminal sessions and their state and input owner.", properties: [:], required: []) { _, client in
            try client.call("terminal.list")
        },
        Tool(name: "terminal_read", description: "Read the recent output of a terminal session.",
             properties: ["id": ["type": "string"]], required: ["id"]) { args, client in
            let attached = try client.call("terminal.attach", params: .object(["id": args?["id"] ?? .null]))
            let data = Data(base64Encoded: attached["scrollback"]?.stringValue ?? "") ?? Data()
            return .string(ANSI.strip(String(decoding: data.suffix(16 * 1024), as: UTF8.self)))
        },
        Tool(name: "terminal_request_control", description: "Ask the user for keyboard control of a terminal. The user approves in Lima.",
             properties: ["id": ["type": "string"], "agentId": ["type": "string"]], required: ["id", "agentId"]) { args, client in
            try client.call("terminal.lease.request", params: .object(["id": args?["id"] ?? .null, "agentId": args?["agentId"] ?? .null]))
            return .string("Requested. Call terminal_run once the user grants control.")
        },
        Tool(name: "terminal_run", description: "Type a command into a terminal you control and wait for the prompt. Requires a granted lease and the terminal:control grant; risky commands need user approval.",
             properties: ["id": ["type": "string"], "agentId": ["type": "string"], "command": ["type": "string"], "timeout": ["type": "number"]],
             required: ["id", "agentId", "command"]) { args, client in
            let handle = try client.call("terminal.lease.handle", params: .object(["id": args?["id"] ?? .null, "agentId": args?["agentId"] ?? .null]))
            var result = try client.call("terminal.agentRun", params: .object([
                "id": args?["id"] ?? .null, "handle": handle, "command": args?["command"] ?? .null, "timeout": args?["timeout"] ?? .number(120)
            ]))
            if case .object(var object) = result, let output = object["output"]?.stringValue {
                object["output"] = .string(ANSI.strip(output))
                result = .object(object)
            }
            return result
        }
    ]

    public static func run() -> Never {
        let client: RuntimeClient
        do {
            client = try RuntimeClient.connect(origin: .mcp)
        } catch {
            FileHandle.standardError.write(Data("lima mcp: \(error)\n".utf8))
            exit(1)
        }
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8), let message = try? JSONDecoder().decode(JSONValue.self, from: data) else { continue }
            guard let method = message["method"]?.stringValue else { continue }
            let id = message["id"]
            guard id != nil else { continue } // notification
            let result: JSONValue
            var error: JSONValue?
            switch method {
            case "initialize":
                result = .object([
                    "protocolVersion": message["params"]?["protocolVersion"] ?? .string("2025-06-18"),
                    "capabilities": .object(["tools": .object([:])]),
                    "serverInfo": .object(["name": .string("lima"), "version": .string(limaRuntimeVersion)])
                ])
            case "ping":
                result = .object([:])
            case "tools/list":
                result = .object(["tools": .array(tools.map { tool in
                    .object([
                        "name": .string(tool.name),
                        "description": .string(tool.description),
                        "inputSchema": .object([
                            "type": .string("object"),
                            "properties": .object(tool.properties.mapValues { .object($0.mapValues(JSONValue.string)) }),
                            "required": .array(tool.required.map(JSONValue.string))
                        ])
                    ])
                })])
            case "tools/call":
                let name = message["params"]?["name"]?.stringValue ?? ""
                if let tool = tools.first(where: { $0.name == name }) {
                    do {
                        let output = try tool.call(message["params"]?["arguments"], client)
                        let text = output.stringValue ?? String(decoding: (try? JSONEncoder().encode(output)) ?? Data(), as: UTF8.self)
                        result = .object(["content": .array([.object(["type": .string("text"), "text": .string(text)])])])
                    } catch let failure as BridgeError {
                        result = .object(["isError": .bool(true), "content": .array([.object(["type": .string("text"), "text": .string("\(failure.code.rawValue): \(failure.message)")])])])
                    } catch {
                        result = .object(["isError": .bool(true), "content": .array([.object(["type": .string("text"), "text": .string(String(describing: error))])])])
                    }
                } else {
                    result = .null
                    error = .object(["code": .number(-32602), "message": .string("unknown tool \(name)")])
                }
            default:
                result = .null
                error = .object(["code": .number(-32601), "message": .string("method not found: \(method)")])
            }
            var response: [String: JSONValue] = ["jsonrpc": .string("2.0"), "id": id!]
            if let error { response["error"] = error } else { response["result"] = result }
            if let encoded = try? JSONEncoder().encode(JSONValue.object(response)) {
                FileHandle.standardOutput.write(encoded + Data("\n".utf8))
            }
        }
        exit(0)
    }
}

enum ANSI {
    static func strip(_ text: String) -> String {
        text.replacingOccurrences(of: #"\x{1B}\[[0-9;?]*[ -/]*[@-~]|\x{1B}\][^\x{07}\x{1B}]*(\x{07}|\x{1B}\\)|\x{1B}[@-Z\\-_]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "\r", with: "")
    }
}
