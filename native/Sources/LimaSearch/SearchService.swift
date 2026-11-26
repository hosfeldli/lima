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
    public var learning: [String: Double]? = nil
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

    public func search(_ raw: String, mode: SearchIntent.Mode? = nil, limit: Int = 30, source: String? = nil) -> SearchResponse {
        let start = Date()
        let intent = SearchIntent.parse(raw, mode: mode)
        var results: [SearchResult] = []
        let now = Date().timeIntervalSince1970 * 1000
        let words = Self.learningQuery(intent.query)

        if intent.mode == .everything || intent.mode == .tools {
            let sources: Set<String>? = intent.mode == .tools ? ["tool"] : source.map { [$0] }
            for (document, relevance) in index.query(intent.query, sources: sources, limit: limit) where !excludedSources.contains(document.source) {
                let ageDays = document.timestamp > 0 ? max(0, (now - document.timestamp) / 86_400_000) : 30
                let recency = 1 / (1 + ageDays / 14)
                let learned = log1p(Double(selections["\(words)\u{1F}\(document.key)"] ?? 0)) * 6
                let score = relevance * (sourceWeights[document.source] ?? 1) + recency * 2 + learned
                let subtitle = document.source == "note" ? Self.excerpt(document.body, matching: intent.query) ?? document.subtitle : document.subtitle
                var result = SearchResult(key: document.key, source: document.source, title: document.title,
                                          subtitle: subtitle, score: score, action: document.action)
                if learned > 0 { result.learned = learned }
                results.append(result)
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
        let prefix = "\(words)\u{1F}local:"
        let localLearning = selections.compactMap { key, value -> (String, Double)? in
            guard key.hasPrefix(prefix) else { return nil }
            return (String(key.dropFirst(prefix.count)), log1p(Double(value)) * 6)
        }
        return SearchResponse(intent: intent, results: results, elapsedMs: Date().timeIntervalSince(start) * 1000,
                              learning: localLearning.isEmpty ? nil : Dictionary(uniqueKeysWithValues: localLearning))
    }

    /// Count selections for the same query words. Old, unqualified counts
    /// stay readable during migration but cannot influence unrelated queries.
    public func recordSelection(_ key: String, query: String) -> [String: Int] {
        let words = Self.learningQuery(SearchIntent.parse(query).query)
        guard !words.isEmpty, key.count <= 512 else { return selections }
        let bucket = "\(words)\u{1F}\(key)"
        if selections[bucket] == nil, selections.count >= 10_000 {
            if let first = selections.min(by: { $0.value < $1.value })?.key {
                selections.removeValue(forKey: first)
            }
        }
        selections[bucket] = min(selections[bucket, default: 0], 999) + 1
        return selections
    }

    private static func learningQuery(_ text: String) -> String {
        String(text.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).joined(separator: " ").prefix(256))
    }

    private static func excerpt(_ body: String, matching query: String) -> String? {
        let text = body.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let words = query.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        let match = text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive])
            ?? words.lazy.compactMap { text.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) }.first
        guard let match else { return nil }
        let start = text.index(match.lowerBound, offsetBy: -35, limitedBy: text.startIndex) ?? text.startIndex
        let end = text.index(start, offsetBy: 140, limitedBy: text.endIndex) ?? text.endIndex
        return (start == text.startIndex ? "" : "…") + String(text[start..<end]) + (end == text.endIndex ? "" : "…")
    }

    public func resetLearning() { selections = [:] }
}
