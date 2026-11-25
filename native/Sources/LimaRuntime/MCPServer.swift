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
        Tool(name: "context_recent", description: "Recent activity metadata (no keystrokes or screen content). limit: 1–1000, default 50.",
             properties: [:], required: [],
             structuredProperties: ["limit": .object(["type": .string("integer"), "minimum": .number(1), "maximum": .number(1000)])]) { args, client in
            try client.call("context.recent", params: .object(["limit": args?["limit"] ?? .number(50)]))
        },
        Tool(name: "reports_list", description: "Weekly activity reports.", properties: [:], required: []) { _, client in
            try client.call("context.reports")
        }
    ]

    /// Protocol versions this server implements, newest first. A client
    /// asking for another gets the newest (MCP lifecycle: version negotiation).
    static let protocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"]

    static func negotiate(_ requested: String?) -> String {
        requested.flatMap { protocolVersions.contains($0) ? $0 : nil } ?? protocolVersions[0]
    }

    /// Checks arguments against the tool's schema before anything runs: a
    /// missing required argument or a wrong type is the caller's error, not
    /// an empty success.
    static func validate(_ arguments: JSONValue?, for tool: Tool) -> String? {
        if let arguments, arguments != .null, arguments.objectValue == nil { return "arguments must be an object" }
        let values = arguments?.objectValue ?? [:]
        for name in tool.required {
            guard let value = values[name], value != .null else { return "missing required argument '\(name)'" }
            if value.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true { return "argument '\(name)' is empty" }
        }
        for (name, value) in values where value != .null {
            let expected = tool.properties[name]?["type"] ?? tool.structuredProperties[name]?["type"]?.stringValue
            switch expected {
            case "string": if value.stringValue == nil { return "argument '\(name)' must be a string" }
            case "number": if value.doubleValue?.isFinite != true { return "argument '\(name)' must be a number" }
            case "integer":
                guard let number = value.doubleValue, number.isFinite, number == number.rounded() else { return "argument '\(name)' must be a whole number" }
                if let minimum = tool.structuredProperties[name]?["minimum"]?.doubleValue, number < minimum { return "argument '\(name)' must be at least \(Int(minimum))" }
                if let maximum = tool.structuredProperties[name]?["maximum"]?.doubleValue, number > maximum { return "argument '\(name)' must be at most \(Int(maximum))" }
            case "boolean": if value.boolValue == nil { return "argument '\(name)' must be true or false" }
            default: break
            }
        }
        return nil
    }

    public static func run() -> Never {
        let token = ProcessInfo.processInfo.environment["LIMA_WORKSPACE_TOKEN"].flatMap { $0.isEmpty ? nil : $0 }
        // One session for this process: approvals "for this task" cover it alone.
        let session = UUID().uuidString
        let connect: @Sendable () throws -> RuntimeClient = { try RuntimeClient.connect(origin: .mcp, workspaceToken: token, session: session) }
        let client: RuntimeClient
        do {
            client = try connect()
        } catch {
            FileHandle.standardError.write(Data("lima mcp: \(error)\n".utf8))
            exit(1)
        }
        let bound = token != nil
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
        // Tool calls run concurrently, each on its own runtime connection,
        // so one waiting on the user (an approval card) doesn't hold up
        // ping, other calls, or a cancellation.
        let output = NSLock()
        let inflight = Inflight()
        let calls = DispatchQueue(label: "lima.mcp.calls", attributes: .concurrent)
        @Sendable func respond(_ id: JSONValue, result: JSONValue? = nil, error: JSONValue? = nil) {
            var response: [String: JSONValue] = ["jsonrpc": .string("2.0"), "id": id]
            if let error { response["error"] = error } else { response["result"] = result ?? .object([:]) }
            guard let encoded = try? JSONEncoder().encode(JSONValue.object(response)) else { return }
            output.lock(); FileHandle.standardOutput.write(encoded + Data("\n".utf8)); output.unlock()
        }
        func failure(_ code: Int, _ message: String) -> JSONValue { .object(["code": .number(Double(code)), "message": .string(message)]) }

        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8), let message = try? JSONDecoder().decode(JSONValue.self, from: data) else { continue }
            guard let method = message["method"]?.stringValue else { continue }
            guard let id = message["id"], id != .null else {
                // Notifications. A cancelled call stops and gets no response.
                if method == "notifications/cancelled", let target = message["params"]?["requestId"] { inflight.cancel(target) }
                continue
            }
            switch method {
            case "initialize":
                respond(id, result: .object([
                    "protocolVersion": .string(negotiate(message["params"]?["protocolVersion"]?.stringValue)),
                    "capabilities": .object(["tools": .object([:])]),
                    "serverInfo": .object(["name": .string("lima"), "version": .string(limaRuntimeVersion)])
                ]))
            case "ping":
                respond(id, result: .object([:]))
            case "tools/list":
                respond(id, result: .object(["tools": .array(tools.map { tool in
                    .object([
                        "name": .string(tool.name),
                        "description": .string(tool.description),
                        "inputSchema": .object([
                            "type": .string("object"),
                            "properties": .object(tool.properties.mapValues { JSONValue.object($0.mapValues(JSONValue.string)) }.merging(tool.structuredProperties) { _, structured in structured }),
                            "required": .array(tool.required.map(JSONValue.string))
                        ])
                    ])
                })]))
            case "tools/call":
                let name = message["params"]?["name"]?.stringValue ?? ""
                let arguments = message["params"]?["arguments"]
                guard let tool = tools.first(where: { $0.name == name }) else {
                    respond(id, error: failure(-32602, "unknown tool \(name)")); continue
                }
                if let problem = validate(arguments, for: tool) {
                    respond(id, error: failure(-32602, "invalid arguments for \(name): \(problem)")); continue
                }
                calls.async {
                    let connection: RuntimeClient
                    do { connection = try connect() } catch {
                        respond(id, result: .object(["isError": .bool(true), "content": .array([.object(["type": .string("text"), "text": .string("Lima's runtime is unavailable: \(error)")])])]))
                        return
                    }
                    inflight.start(id, connection)
                    defer { connection.disconnect() }
                    let result: JSONValue
                    do {
                        let output = try tool.call(arguments, connection)
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
                    if inflight.finish(id) { respond(id, result: result) }
                }
            default:
                respond(id, error: failure(-32601, "method not found: \(method)"))
            }
        }
        // stdin closed: let calls in progress finish writing.
        calls.sync(flags: .barrier) {}
        exit(0)
    }

    /// Calls in progress, by JSON-RPC id, so a cancellation can stop one.
    final class Inflight: @unchecked Sendable {
        private let lock = NSLock()
        private var running: [String: RuntimeClient] = [:]
        private var cancelled: Set<String> = []
        private func key(_ id: JSONValue) -> String { String(decoding: (try? JSONEncoder().encode(id)) ?? Data(), as: UTF8.self) }
        func start(_ id: JSONValue, _ client: RuntimeClient) {
            lock.lock(); defer { lock.unlock() }
            if cancelled.contains(key(id)) { client.interrupt() } else { running[key(id)] = client }
        }
        func cancel(_ id: JSONValue) {
            lock.lock(); defer { lock.unlock() }
            cancelled.insert(key(id))
            running.removeValue(forKey: key(id))?.interrupt()
        }
        /// True if the call should be answered (it wasn't cancelled).
        func finish(_ id: JSONValue) -> Bool {
            lock.lock(); defer { lock.unlock() }
            running.removeValue(forKey: key(id))
            return cancelled.remove(key(id)) == nil
        }
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
        Tool(name: "workspace_request_permissions", description: """
            At the start of a task, before doing the work: ask once for everything you can foresee needing from the user \
            (approvals for destructive commands, spending or account actions; sign-ins; browser interaction on specific sites). \
            Lima shows one card listing them and waits. Once approved, pass an item's id as grant to workspace_request_approval \
            when you reach it (it returns approved without asking again), and browser plans within an approved site, paths and \
            actions are approved without a card. Payments and other irreversible steps still ask when they happen. Ask only for \
            what this task will really need; skip this tool when nothing does.
            """,
             properties: ["summary": ["type": "string", "description": "One or two sentences: the plan, and why these are needed."]],
             required: ["items"],
             structuredProperties: ["items": .object([
                "type": .string("array"), "minItems": .number(1), "maxItems": .number(8),
                "items": .object([
                    "type": .string("object"), "required": .array([.string("id"), .string("request")]),
                    "properties": .object([
                        "id": .object(["type": .string("string"), "description": .string("Short id, e.g. push-branch")]),
                        "request": .object(["type": .string("string"), "description": .string("What you'll do, in one sentence.")]),
                        "detail": .object(["type": .string("string")]),
                        "kind": .object(["enum": .array([.string("approval"), .string("login"), .string("browser")])]),
                        "risk": .object(["enum": .array([.string("money"), .string("account"), .string("system")])]),
                        "url": .object(["type": .string("string"), "description": .string("Sign-in page, or the page a browser item starts on")]),
                        "paths": .object(["type": .string("string"), "description": .string("browser: comma-separated exact paths on that site")]),
                        "actions": .object(["type": .string("string"), "description": .string("browser: comma-separated click, type or scroll")]),
                    ]),
                ]),
             ])]) { args, client in
            try client.call("workspace.requestPermissions", params: args)
        },
        Tool(name: "workspace_request_approval", description: """
            Ask the user to approve something before you do it (a destructive command, spending money, acting on their account), \
            or, with kind "login", to sign in somewhere you can't (include the sign-in url and site). Lima shows a card and waits. \
            The result says whether they approved. If the user approved it up front (workspace_request_permissions), pass that \
            item's id as grant and no card is shown. If it says the request stays open, end your turn: the answer arrives later \
            as a chat message, and you continue from there.
            """,
             properties: ["request": ["type": "string", "description": "What you need approved, in one sentence."],
                          "grant": ["type": "string", "description": "The id of an item the user approved up front, if this is it."],
                          "detail": ["type": "string", "description": "Why, and exactly what will happen."],
                          "kind": ["type": "string", "description": "approval (default) or login"],
                          "site": ["type": "string"], "url": ["type": "string"],
                          "risk": ["type": "string", "description": "money, account or system"]],
             required: ["request"]) { args, client in
            try client.call("workspace.requestApproval", params: args)
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
