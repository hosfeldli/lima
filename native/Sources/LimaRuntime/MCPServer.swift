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
        var structuredProperties: [String: JSONValue] = [:]
        var call: @Sendable (JSONValue?, RuntimeClient) throws -> JSONValue
    }

    /// Content tools (read/append data). Actions come from the capability
    /// manifest below, so there is no second list of Lima functions here.
    static let contentTools: [Tool] = [
        Tool(name: "lima_search", description: "Search Lima notes, conversations, reports and tools.",
             properties: ["query": ["type": "string"]], required: ["query"]) { args, client in
            let response = try client.call("search.query", params: .object(["query": args?["query"] ?? .string("")]))
            let results = (response["results"]?.arrayValue ?? []).filter { ["note", "conversation", "report", "context", "tool"].contains($0["source"]?.stringValue ?? "") }
            return .array(results)
        },
        Tool(name: "notes_list", description: "List notes (id, title, excerpt).", properties: [:], required: []) { _, client in
            try client.call("notes.list")
        },
        Tool(name: "notes_get", description: "Get a note's full content including canvas blocks.", properties: ["id": ["type": "string"]], required: ["id"]) { args, client in
            try client.call("notes.get", params: .object(["id": args?["id"] ?? .null]))
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
        }
    ]

    public static func run() -> Never {
        let client: RuntimeClient
        do {
            let token = ProcessInfo.processInfo.environment["LIMA_WORKSPACE_TOKEN"]
            client = try RuntimeClient.connect(origin: .mcp, workspaceToken: token?.isEmpty == false ? token : nil)
        } catch {
            FileHandle.standardError.write(Data("lima mcp: \(error)\n".utf8))
            exit(1)
        }
        let bound = ProcessInfo.processInfo.environment["LIMA_WORKSPACE_TOKEN"].map { !$0.isEmpty } ?? false
        let browserOnly = ProcessInfo.processInfo.environment["LIMA_BROWSER_ONLY"] == "1"
        let tools: [Tool]
        if browserOnly {
            tools = browserTools
        } else {
            var catalog = contentTools
            if bound {
                catalog.append(contentsOf: workspaceTools)
                catalog.append(contentsOf: imageTools)
                catalog.append(contentsOf: browserTools)
                catalog.append(contentsOf: taskTools)
            }
            catalog.append(contentsOf: capabilityTools(client))
            tools = catalog
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
                            "properties": .object(tool.properties.mapValues { JSONValue.object($0.mapValues(JSONValue.string)) }.merging(tool.structuredProperties) { _, structured in structured }),
                            "required": .array(tool.required.map(JSONValue.string))
                        ])
                    ])
                })])
            case "tools/call":
                let name = message["params"]?["name"]?.stringValue ?? ""
                if let tool = tools.first(where: { $0.name == name }) {
                    do {
                        let output = try tool.call(message["params"]?["arguments"], client)
                        if name == "workspace_browser", let screenshot = output["jpeg"]?.stringValue {
                            result = .object(["content": .array([.object([
                                "type": .string("image"), "data": .string(screenshot), "mimeType": .string("image/jpeg")
                            ])])])
                        } else {
                            let text = output.stringValue ?? String(decoding: (try? JSONEncoder().encode(output)) ?? Data(), as: UTF8.self)
                            result = .object(["content": .array([.object(["type": .string("text"), "text": .string(text)])])])
                        }
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

extension MCPServer {
    static let browserTools: [Tool] = [
        Tool(name: "workspace_browser_plan", description: "Block for user approval before an interaction session. Describe the goal, exact same-site paths, and intended actions. The Lima orchestrator approves routine actions and asks the user only when a higher-risk action needs consent. The plan can open the requested tab. Use the session for click, type, or scroll.",
             properties: ["url": ["type": "string"], "goal": ["type": "string"], "plan": ["type": "string"], "paths": ["type": "string", "description": "Comma-separated exact URL paths on this site. The starting path is included."], "actions": ["type": "string", "description": "Comma-separated click, type or scroll"]], required: ["goal", "plan", "actions"]) { args, client in
            try client.call("workspace.browserPlan", params: args)
        },
        Tool(name: "workspace_browser", description: "Inspect or screenshot a workspace tab. Click, type and scroll require the session from workspace_browser_plan. Use the optional label from inspect to verify a live click target. A sensitive step (a bet, payment, password, form submit or unlisted page) waits for the user's approval in Lima and then runs; if declined, the result says so. Keep using the original tab URL after same-site navigation. Browser-only helpers use their assigned tab.",
        properties: ["url": ["type": "string"], "action": ["type": "string"], "x": ["type": "number"], "y": ["type": "number"],
                     "dy": ["type": "number"], "label": ["type": "string"], "text": ["type": "string"], "session": ["type": "string"]], required: ["action"]) { args, client in
        try client.call("workspace.browserAction", params: args)
    }]

    /// Tools for a workspace's own agent. The runtime enforces that they act
    /// only on that workspace.
    static let workspaceTools: [Tool] = [
        Tool(name: "workspace_ask_user", description: "Ask a question in Lima and wait for an answer. Include fields for structured information. For a reservation, use labeled date, time, and number fields with IDs such as date, time, and partySize. The reply contains values keyed by field ID.",
             properties: ["question": ["type": "string"]], required: ["question"], structuredProperties: ["fields": WorkspaceQuestionField.schema]) { args, client in
            try client.call("workspace.askUser", params: args)
        },
        Tool(name: "workspace_location", description: "Ask the user to share their approximate current location once for a stated purpose. Use for nearby results or a route starting near the user. A declined request returns no location.",
             properties: ["purpose": ["type": "string"]], required: ["purpose"]) { args, client in
            try client.call("workspace.location", params: args)
        },
        Tool(name: "workspace_info", description: "This workspace: name, directory, tabs, bookmarks and conversation.", properties: [:], required: []) { _, client in
            try client.call("workspace.get")
        },
        Tool(name: "workspace_schedule", description: """
            Schedule work for later in this workspace, once or on repeat, when the user asks for something at a future time or regularly \
            ("every day at 8:00 AM", "book it when reservations open 60 days ahead"). At each run Lima sends `instruction` to this workspace's \
            agent, so write it as a complete standalone instruction (site, what to do, what to report) without timing words. Work out the \
            date yourself (run `date` for today): a booking window that opens N days ahead is a one-time task on the opening day, a little \
            after it opens (9:00 AM if unknown, and say you assumed it). Times are the user's local time. The user approves it in Lima; \
            the result has the next run so you can confirm it in your reply.
            """,
             properties: ["title": ["type": "string", "description": "Short name, e.g. “Check Nopa reservations”"],
                          "instruction": ["type": "string"]],
             required: ["instruction", "when"],
             structuredProperties: ["when": TaskSchedule.schema]) { args, client in
            try client.call("schedule.create", params: args)
        },
        Tool(name: "workspace_schedules", description: "This workspace's scheduled tasks: when each runs next and how recent runs went.",
             properties: [:], required: []) { _, client in
            try client.call("schedule.list")
        },
        Tool(name: "workspace_unschedule", description: "Delete one of this workspace's scheduled tasks by id (the user approves it).",
             properties: ["id": ["type": "string"]], required: ["id"]) { args, client in
            try client.call("schedule.delete", params: args)
        },
        Tool(name: "workspace_name", description: "Give an unnamed workspace its short, descriptive title. An existing title is kept.",
             properties: ["name": ["type": "string"]], required: ["name"]) { args, client in
            try client.call("workspace.rename", params: .object(["name": args?["name"] ?? .null]))
        },
        Tool(name: "workspace_open_tab", description: "Open a web page as a tab inside this workspace's folder in Lima (the user sees it appear).",
             properties: ["url": ["type": "string"], "title": ["type": "string"]], required: ["url"]) { args, client in
            try client.call("workspace.openTab", params: .object(["url": args?["url"] ?? .null, "title": args?["title"] ?? .null]))
        },
        Tool(name: "workspace_close_tab", description: "Remove a tab you opened from this workspace.", properties: ["url": ["type": "string"]], required: ["url"]) { args, client in
            try client.call("workspace.closeTab", params: .object(["url": args?["url"] ?? .null]))
        },
        Tool(name: "workspace_bookmark", description: "File a bookmark in this workspace's bookmark folder. Use folder paths like \"Research/Docs\" to build structure.",
             properties: ["url": ["type": "string"], "title": ["type": "string"], "folder": ["type": "string"]], required: ["url", "title"]) { args, client in
            try client.call("workspace.bookmark", params: .object(["url": args?["url"] ?? .null, "title": args?["title"] ?? .null, "folder": args?["folder"] ?? .string("")]))
        },
        Tool(name: "workspace_files", description: "List files in this workspace's directory (or a sub-folder via path).", properties: ["path": ["type": "string"]], required: []) { args, client in
            try client.call("workspace.files", params: .object(["path": args?["path"] ?? .string("")]))
        },
        Tool(name: "workspace_list_tabs", description: "The web pages currently in this workspace's Tabs folder in Lima, including ones the user added.", properties: [:], required: []) { _, client in
            try client.call("workspace.listTabs")
        },
        Tool(name: "workspace_read_tab", description: "Read the text of a page in this workspace's Tabs folder (opens it there first if needed). The user sees which tab you are reading.",
             properties: ["url": ["type": "string"]], required: ["url"]) { args, client in
            try client.call("workspace.readTab", params: .object(["url": args?["url"] ?? .null]))
        },
        Tool(name: "workspace_note", description: "Write a note (Markdown) — summaries, findings, plans. It appears in this workspace's folder and the user's Notebook.",
             properties: ["title": ["type": "string"], "markdown": ["type": "string"]], required: ["title", "markdown"]) { args, client in
            try client.call("workspace.note", params: .object(["title": args?["title"] ?? .null, "markdown": args?["markdown"] ?? .null]))
        },
        Tool(name: "agent_spawn", description: "Start an independent helper and track it with agents_status. For browser-only work, open the HTTPS or loopback page in the workspace, then pass it as browser_url with provider=claude. Use workspace_browser_plan to negotiate site access. Tool-only helpers cannot access project files, shell or other tabs.",
             properties: ["name": ["type": "string"], "task": ["type": "string"], "browser_url": ["type": "string"], "provider": ["type": "string"]],
             required: ["name", "task"]) { args, client in
            try client.call("agent.spawn", params: .object(["name": args?["name"] ?? .null, "task": args?["task"] ?? .null,
                "browserUrl": args?["browser_url"] ?? .null, "provider": args?["provider"] ?? .null]))
        },
        Tool(name: "agents_status", description: "What each helper agent you spawned is doing: state, current surface, recent tools and its latest reply.", properties: [:], required: []) { _, client in
            try client.call("agents.status")
        },
        Tool(name: "agent_dismiss", description: "Close a finished helper's sidebar folder and tabs after reading its results from agents_status. Pass the helper workspace id.", properties: ["id": ["type": "string"]], required: ["id"]) { args, client in
            try client.call("agent.dismiss", params: args)
        },
        Tool(name: "workspace_new", description: "Create a new AI workspace (its own folder, agent and tab folder) when the user asks for one.",
             properties: ["name": ["type": "string"], "task": ["type": "string", "description": "first instruction for the new workspace's agent"]], required: ["name"]) { args, client in
            try client.call("workspace.create", params: .object(["name": args?["name"] ?? .null, "task": args?["task"] ?? .null]))
        },
    ]

    static let delegateProperties: [String: [String: String]] = [
        "name": ["type": "string", "description": "Short helper name, such as Research Agent"],
        "objective": ["type": "string"],
        "role": ["type": "string", "description": "research, implementation, testing, review, browser or general"],
        "depends_on": ["type": "string", "description": "Comma-separated names or task IDs of helpers whose results this one needs"],
        "success_criteria": ["type": "string", "description": "One criterion per line"],
        "provider": ["type": "string"],
        "browser_url": ["type": "string"],
    ]
    static let delegateArguments: [(String, String)] = [
        ("name", "name"), ("objective", "objective"), ("role", "role"), ("depends_on", "dependsOn"),
        ("success_criteria", "successCriteria"), ("provider", "provider"), ("browser_url", "browserUrl"),
    ]

    /// The orchestrator's task tools for workspace agents.
    static let taskTools: [Tool] = [
        Tool(name: "task_delegate", description: "Ask the Lima orchestrator for a helper agent with a distinct objective inside your current Lima task. Lima records the assignment, starts it when its dependencies succeed, limits concurrency, isolates concurrent code changes in a Git worktree, and returns the helper's structured result to you. Don't delegate work you can finish efficiently yourself.",
             properties: delegateProperties, required: ["name", "objective"]) { args, client in
            var params: [String: JSONValue] = [:]
            for (tool, bridge) in delegateArguments { params[bridge] = args?[tool] ?? .null }
            return try client.call("task.delegate", params: .object(params))
        },
        Tool(name: "task_status", description: "Your current Lima task and its helpers: state, dependencies, summaries and artifacts.", properties: [:], required: []) { _, client in
            try client.call("task.status")
        },
        Tool(name: "task_message", description: "Send a structured message through the orchestrator to the agents that depend on you and to your coordinator. kind is finding, question, blocked, dependency_ready, artifact, completed or failed.",
             properties: ["kind": ["type": "string"], "text": ["type": "string"]], required: ["kind", "text"]) { args, client in
            try client.call("task.message", params: args)
        },
        Tool(name: "task_inbox", description: "Messages other agents sent you through the orchestrator (findings, dependency updates, artifacts).", properties: [:], required: []) { _, client in
            try client.call("task.inbox")
        },
    ]

    /// One MCP tool per capability the user could grant to agents.
    static func capabilityTools(_ client: RuntimeClient) -> [Tool] {
        guard let manifest = try? client.call("capabilities.list").decode(as: [CapabilityDefinition].self) else { return [] }
        return manifest.map { capability in
            Tool(name: "lima_" + capability.id.replacingOccurrences(of: ".", with: "_"),
                 description: "\(capability.title): \(capability.summary) (available in Lima)",
                 properties: capability.input.map { ["input": ["type": "string", "description": $0.placeholder]] } ?? [:],
                 required: capability.input?.required == true ? ["input"] : []) { args, client in
                try client.call("capabilities.run", params: .object(["id": .string(capability.id), "input": args?["input"] ?? .string("")]))
            }
        }
    }
}

enum ANSI {
    static func strip(_ text: String) -> String {
        text.replacingOccurrences(of: #"\x{1B}\[[0-9;?]*[ -/]*[@-~]|\x{1B}\][^\x{07}\x{1B}]*(\x{07}|\x{1B}\\)|\x{1B}[@-Z\\-_]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "\r", with: "")
    }
}
