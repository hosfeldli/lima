import Foundation

/// Parsed intent for one input (spec v2 §3.2). Prefixes are optional; the
/// router never sends a query to the web or a model unless the user picks
/// that row or uses an explicit prefix.
public struct SearchIntent: Codable, Equatable, Sendable {
    public enum Mode: String, Codable, Sendable { case everything, web, tools, quickAsk, agentAsk }
    public var mode: Mode
    public var query: String
    public var looksLikeQuestion: Bool
    public var looksLikeURL: Bool

    public static func parse(_ raw: String, mode explicit: Mode? = nil) -> SearchIntent {
        var text = raw.trimmingCharacters(in: .whitespaces)
        var mode = explicit ?? .everything
        let prefixes: [(String, Mode)] = [("web:", .web), ("?", .quickAsk), ("ask:", .quickAsk), ("agent:", .agentAsk), (">", .tools)]
        if explicit == nil {
            for (prefix, prefixMode) in prefixes where text.lowercased().hasPrefix(prefix) {
                mode = prefixMode
                text = String(text.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
                break
            }
        }
        let lower = text.lowercased()
        let questionWords = ["what", "who", "why", "how", "when", "where", "which", "is ", "are ", "can ", "does ", "should ", "explain", "define"]
        let question = text.hasSuffix("?") || questionWords.contains { lower.hasPrefix($0) }
        let url = !text.contains(" ") && (lower.hasPrefix("http://") || lower.hasPrefix("https://")
            || lower.range(of: #"^[a-z0-9-]+(\.[a-z0-9-]+)+(/\S*)?$"#, options: .regularExpression) != nil)
        return SearchIntent(mode: mode, query: text, looksLikeQuestion: question, looksLikeURL: url)
    }
}

public struct SearchResponse: Codable, Equatable, Sendable {
    public var intent: SearchIntent
    public var results: [SearchResult]
    public var elapsedMs: Double
}

/// Federated search over the in-memory index plus synthesized action rows.
/// Ranking combines text relevance, source weight, recency and learned
/// selection counts (spec v1 §3.3).
public actor SearchService {
    public nonisolated let index: SearchIndex
    private var selections: [String: Int]
    private let sourceWeights: [String: Double] = [
        "tool": 1.6, "app": 1.5, "note": 1.3, "conversation": 1.0, "terminal": 0.9, "report": 1.1, "context": 0.7, "tab": 1.4
    ]
    private var excludedSources: Set<String> = []

    public init(index: SearchIndex = SearchIndex(), selections: [String: Int] = [:]) {
        self.index = index
        self.selections = selections
    }

    public func setExcludedSources(_ sources: Set<String>) { excludedSources = sources }

    public func search(_ raw: String, mode: SearchIntent.Mode? = nil, limit: Int = 30) -> SearchResponse {
        let start = Date()
        let intent = SearchIntent.parse(raw, mode: mode)
        var results: [SearchResult] = []
        let now = Date().timeIntervalSince1970 * 1000

        if intent.mode == .everything || intent.mode == .tools {
            let sources: Set<String>? = intent.mode == .tools ? ["tool"] : nil
            for (document, relevance) in index.query(intent.query, sources: sources, limit: limit) where !excludedSources.contains(document.source) {
                let ageDays = document.timestamp > 0 ? max(0, (now - document.timestamp) / 86_400_000) : 30
                let recency = 1 / (1 + ageDays / 14)
                let learned = log(1 + Double(selections[document.key] ?? 0))
                let score = relevance * (sourceWeights[document.source] ?? 1) + recency * 2 + learned * 6
                results.append(SearchResult(key: document.key, source: document.source, title: document.title,
                                            subtitle: document.subtitle, score: score, action: document.action))
            }
            // Exact title prefix beats fuzzy body hits (e.g. typing an app name).
            let lower = intent.query.lowercased()
            for index in results.indices where results[index].title.lowercased().hasPrefix(lower) { results[index].score += 8 }
            results.sort { $0.score > $1.score }
            results = Array(results.prefix(limit))
        }

        guard !intent.query.isEmpty else { return SearchResponse(intent: intent, results: results, elapsedMs: 0) }

        // Synthesized rows. Their position reflects intent, but they never run
        // until chosen.
        if intent.looksLikeURL {
            let url = intent.query.contains("://") ? intent.query : "https://\(intent.query)"
            results.insert(SearchResult(key: "navigate:\(url)", source: "web", title: "Open \(intent.query)", subtitle: url, score: 100, action: SearchAction("navigate", ["url": url])), at: 0)
        }
        let ask = SearchResult(key: "quickask", source: "ai", title: "Ask: \(intent.query)", subtitle: "Quick Ask · no tools, no page access",
                               score: 0, action: SearchAction("quickAsk", ["prompt": intent.query]))
        let agent = SearchResult(key: "agentask", source: "ai", title: "Start agent task: \(intent.query)", subtitle: "Opens AI Chat in the workspace",
                                 score: 0, action: SearchAction("agentAsk", ["prompt": intent.query]))
        let web = SearchResult(key: "websearch", source: "web", title: "Search the web for “\(intent.query)”", subtitle: "Default search engine",
                               score: 0, action: SearchAction("webSearch", ["query": intent.query]))
        switch intent.mode {
        case .web: results.insert(web, at: 0)
        case .quickAsk: results.insert(ask, at: 0)
        case .agentAsk: results.insert(agent, at: 0)
        case .everything:
            if intent.looksLikeQuestion { results.insert(ask, at: min(results.count, 1)) } else { results.append(ask) }
            results.append(web)
        case .tools: break
        }
        return SearchResponse(intent: intent, results: results, elapsedMs: Date().timeIntervalSince(start) * 1000)
    }

    /// Learned ranking: count selections per result key.
    public func recordSelection(_ key: String) -> [String: Int] {
        selections[key, default: 0] += 1
        return selections
    }

    public func resetLearning() { selections = [:] }
}
