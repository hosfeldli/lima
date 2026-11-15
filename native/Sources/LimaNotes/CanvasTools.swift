import Foundation

/// Structured canvas operations for AI and users (spec v1 §6.3). Each
/// returns edits for preview; nothing is applied until the caller commits
/// them through NotesService.apply, which makes them undoable.
public enum CanvasTools {
    public static let grid: Double = 8
    public static let gap: Double = 24

    public struct CleanupReport: Codable, Equatable, Sendable {
        public var overlaps: [[String]]
        public var duplicates: [[String]]
        public var disconnected: [String]
        public var misaligned: [String]
        public var edits: [NoteEdit]
    }

    /// Detects overlaps, duplicates, off-grid blocks and disconnected flow
    /// nodes, and proposes moves that snap to the grid and resolve overlaps
    /// by pushing blocks down in reading order.
    public static func cleanupLayout(_ note: Note) -> CleanupReport {
        var overlaps: [[String]] = []
        for (i, a) in note.blocks.enumerated() {
            for b in note.blocks[(i + 1)...] where a.overlaps(b) { overlaps.append([a.id, b.id]) }
        }

        var seen: [String: String] = [:]
        var duplicates: [[String]] = []
        for block in note.blocks {
            let key = "\(block.type.rawValue):\(block.content.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())"
            guard !block.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            if let first = seen[key] { duplicates.append([first, block.id]) } else { seen[key] = block.id }
        }

        let connected = Set(note.connections.flatMap { [$0.from, $0.to] })
        let hasFlow = !note.connections.isEmpty
        let disconnected = hasFlow ? note.blocks.filter { $0.type == .flow && !connected.contains($0.id) }.map(\.id) : []

        let misaligned = note.blocks.filter { snap($0.x) != $0.x || snap($0.y) != $0.y }.map(\.id)

        // Proposed layout: snap, then sweep in reading order pushing down.
        var placed: [CanvasBlock] = []
        var edits: [NoteEdit] = []
        for block in note.blocks.sorted(by: { ($0.y, $0.x) < ($1.y, $1.x) }) {
            var candidate = block
            candidate.x = snap(block.x)
            candidate.y = snap(block.y)
            while let blocker = placed.first(where: { $0.overlaps(candidate) }) {
                candidate.y = snap(blocker.y + blocker.height + gap)
            }
            placed.append(candidate)
            if candidate.x != block.x || candidate.y != block.y {
                edits.append(.moveBlock(id: block.id, x: candidate.x, y: candidate.y, width: block.width, height: block.height))
            }
        }
        return CleanupReport(overlaps: overlaps, duplicates: duplicates, disconnected: disconnected, misaligned: misaligned, edits: edits)
    }

    /// Builds a flow diagram from lines like `A -> B -> C` or `A -> B: label`.
    /// Nodes are laid out left-to-right by depth, starting below existing content.
    public static func generateDiagram(_ spec: String, below note: Note) -> [NoteEdit] {
        var order: [String] = []
        var edges: [(String, String, String?)] = []
        for rawLine in spec.split(whereSeparator: \.isNewline) {
            var line = String(rawLine)
            var label: String?
            if let colon = line.lastIndex(of: ":"), line[..<colon].contains("->") {
                label = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                line = String(line[..<colon])
            }
            let nodes = line.components(separatedBy: "->").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            for node in nodes where !order.contains(node) { order.append(node) }
            for (a, b) in zip(nodes, nodes.dropFirst()) { edges.append((a, b, label)) }
        }
        guard !order.isEmpty else { return [] }

        var depth: [String: Int] = Dictionary(uniqueKeysWithValues: order.map { ($0, 0) })
        for _ in order { for (a, b, _) in edges where depth[b]! <= depth[a]! && a != b { depth[b] = depth[a]! + 1 } }
        let maxDepth = depth.values.max() ?? 0
        if maxDepth >= order.count { depth = Dictionary(uniqueKeysWithValues: order.enumerated().map { ($1, $0) }) } // cycle fallback

        let top = snap((note.blocks.map { $0.y + $0.height }.max() ?? 0) + (note.blocks.isEmpty ? 0 : gap * 2))
        var rowsUsed: [Int: Int] = [:]
        var ids: [String: String] = [:]
        var edits: [NoteEdit] = []
        for node in order {
            let column = depth[node]!
            let row = rowsUsed[column, default: 0]
            rowsUsed[column] = row + 1
            let block = CanvasBlock(type: .flow, x: Double(column) * (200 + gap * 2), y: top + Double(row) * (72 + gap), width: 200, height: 72, content: node)
            ids[node] = block.id
            edits.append(.addBlock(block))
        }
        for (a, b, label) in edges { edits.append(.connect(CanvasConnection(from: ids[a]!, to: ids[b]!, label: label))) }
        return edits
    }

    static func snap(_ value: Double) -> Double { (value / grid).rounded() * grid }
}
