import CoreGraphics
import Foundation
import LimaProtocol

actor VectorStudio {
    private let store: StudioHistory

    init(root: URL) { store = StudioHistory(root: root) }

    func create(_ artwork: StudioVector, workspace: String) throws -> JSONValue {
        try artwork.validate()
        let document = try store.create(artwork, workspace: workspace)
        return try summary(document, artwork, revision: document.current)
    }

    func perform(_ method: String, workspace: Workspace, params: JSONValue?, browser: Bool) throws -> JSONValue {
        if method == "recent" { return store.recent(workspace: workspace.id).map(JSONValue.string) ?? .null }
        if method == "open" {
            let data = try ImageWorkspaceFiles.read(root: workspace.directory, path: params.string("path"))
            return try create(StudioVector.parse(data), workspace: workspace.id)
        }
        var document = try store.document(params.string("document_id"), workspace: workspace.id)
        let source = params.optionalString("source_revision") ?? document.current
        let settings = params?["parameters"]
        let readOnly = ["inspect", "get_path", "render", "validate", "export"]
        if !readOnly.contains(method) {
            let changed = try store.update(&document, request: params, method: method, as: StudioVector.self) {
                try Self.edit(&$0, method: method, target: params?["target_ids"], settings: settings)
            }
            return try summary(document, store.load(StudioVector.self, document: document, revision: changed), revision: changed)
        }
        let artwork = try store.load(StudioVector.self, document: document, revision: source)
        switch method {
        case "get_path":
            let id = try params.string("shape_id")
            guard let shape = artwork.shapes.first(where: { $0.id == id }) else { throw ImageRaster.invalid("This shape ID does not exist.") }
            return try JSONValue.from(shape)
        case "render":
            guard browser else { throw BridgeError(.notAuthorized, "Open the PNG preview in Image Studio.") }
            store.record(document.id, workspace: workspace.id)
            return try summary(document, artwork, revision: source, extras: [
                "preview": .string(ImageRaster.encoded(artwork.raster(), format: "png").base64EncodedString()),
            ])
        case "export":
            guard params.optionalString("source_revision") != nil else { throw ImageRaster.invalid("Choose the exact revision to export.") }
            let output = try params.string("output_name")
            guard URL(fileURLWithPath: output).pathExtension.lowercased() == "svg" else {
                throw ImageRaster.invalid("Choose a new workspace filename ending in .svg.")
            }
            let encoded = try artwork.svg()
            let restored = try StudioVector.parse(encoded)
            guard restored.shapes.map(\.id) == artwork.shapes.map(\.id) else { throw ImageRaster.invalid("SVG export verification failed.") }
            _ = try restored.raster()
            try ImageWorkspaceFiles.export(root: workspace.directory, path: output, data: encoded)
            return try summary(document, artwork, revision: source, extras: ["artifact_ids": .array([.string(output)])])
        case "validate":
            _ = try artwork.raster()
            return try summary(document, artwork, revision: source, extras: ["valid": .bool(true), "pure_vector": .bool(true)])
        default:
            return try summary(document, artwork, revision: source)
        }
    }

    func artwork(workspace: String, document: String, revision: String) throws -> StudioVector {
        try store.load(StudioVector.self, document: store.document(document, workspace: workspace), revision: revision)
    }

    private func summary(_ document: StudioHistory.Document, _ artwork: StudioVector, revision: String,
                         extras: [String: JSONValue] = [:]) throws -> JSONValue {
        var result = store.summary(document, revision: revision)
        result["studio_url"] = .string("about:lima?view=image&imageWorkspace=\(document.workspace)&vectorDocument=\(document.id)")
        result["dimensions"] = .object(["width": .number(Double(artwork.width)), "height": .number(Double(artwork.height))])
        result["view_box"] = try JSONValue.from(artwork.viewBox)
        result["shape_count"] = .number(Double(artwork.shapes.count))
        result["shapes"] = .array(artwork.shapes.map {
            .object(["id": .string($0.id), "fill": .string($0.fill), "stroke": .string($0.stroke),
                     "stroke_width": .number($0.strokeWidth), "group": $0.group.map(JSONValue.string) ?? .null,
                     "segments": .number(Double($0.segments.count))])
        })
        return .object(result.merging(extras) { _, new in new })
    }

    private static func edit(_ artwork: inout StudioVector, method: String, target: JSONValue?, settings: JSONValue?) throws {
        let ids = try target?.decode(as: [String].self) ?? []
        let unique = Set(ids)
        let indices = artwork.shapes.indices.filter { unique.contains(artwork.shapes[$0].id) }
        guard !ids.isEmpty, indices.count == unique.count else { throw ImageRaster.invalid("Use exact shape IDs from vector_inspect.") }
        switch method {
        case "delete":
            artwork.shapes.removeAll { unique.contains($0.id) }
        case "duplicate":
            for index in indices.reversed() {
                var shape = artwork.shapes[index]
                shape.id = "shape-" + UUID().uuidString
                artwork.shapes.insert(shape, at: index + 1)
            }
        case "reorder":
            let placement = try settings.string("position")
            guard ["front", "back"].contains(placement) else { throw ImageRaster.invalid("Choose front or back.") }
            let inOrder = indices.map { artwork.shapes[$0] }
            artwork.shapes.removeAll { unique.contains($0.id) }
            if placement == "front" { artwork.shapes.append(contentsOf: inOrder) }
            else { artwork.shapes.insert(contentsOf: inOrder, at: 0) }
        default:
            for index in indices { try update(&artwork.shapes[index], method: method, settings: settings) }
        }
        try artwork.validate()
    }

    private static func update(_ shape: inout StudioVector.Shape, method: String, settings: JSONValue?) throws {
        switch method {
        case "set_style":
            shape.fill = try StudioVector.paint(settings.string("fill"))
            shape.stroke = try StudioVector.paint(settings.string("stroke"))
            shape.strokeWidth = settings.double("width", default: shape.strokeWidth)
        case "set_fill": shape.fill = try StudioVector.paint(settings.string("color"))
        case "set_stroke":
            shape.stroke = try StudioVector.paint(settings.string("color"))
            shape.strokeWidth = settings.double("width", default: shape.strokeWidth)
        case "set_opacity": shape.opacity = settings.double("opacity", default: -1)
        case "group":
            let name = try settings.string("name")
            guard (1...120).contains(name.utf8.count), !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
                throw ImageRaster.invalid("Provide a short group name.")
            }
            shape.group = name
        case "ungroup": shape.group = nil
        case "set_path":
            if let path = settings.optionalString("path") { shape.segments = try StudioVector.parsePath(path) }
            else { shape.segments = try settings.decode("segments", as: [StudioVector.Segment].self) }
        case "edit_nodes":
            let edits = try settings.decode("nodes", as: [NodeEdit].self)
            for edit in edits {
                guard shape.segments.indices.contains(edit.index) else { throw ImageRaster.invalid("A path node index is out of bounds.") }
                shape.segments[edit.index].points = edit.points
            }
        case "move", "scale", "rotate", "transform":
            let delta: CGAffineTransform
            switch method {
            case "move":
                delta = .init(translationX: settings.double("x", default: 0), y: settings.double("y", default: 0))
            case "scale":
                let x = settings.double("x", default: 1), y = settings.double("y", default: x)
                delta = .init(scaleX: x, y: y)
            case "rotate":
                let x = settings.double("x", default: 0), y = settings.double("y", default: 0)
                let radians = settings.double("degrees", default: 0) * .pi / 180
                delta = CGAffineTransform(translationX: -x, y: -y).concatenating(.init(rotationAngle: radians))
                    .concatenating(.init(translationX: x, y: y))
            default:
                let matrix = try settings.decode("matrix", as: [Double].self)
                guard matrix.count == 6, matrix.allSatisfy(StudioVector.bounded) else { throw ImageRaster.invalid("Provide six bounded affine matrix values.") }
                delta = StudioVector.transform(matrix)
            }
            guard StudioVector.matrix(delta).allSatisfy(StudioVector.bounded), abs(delta.a * delta.d - delta.b * delta.c) > 1e-8 else {
                throw ImageRaster.invalid("The transform is singular or too large.")
            }
            shape.matrix = StudioVector.matrix(StudioVector.transform(shape.matrix).concatenating(delta))
        default:
            throw ImageRaster.invalid("Unsupported vector editing operation.")
        }
    }

    private struct NodeEdit: Codable {
        let index: Int
        let points: [Double]
    }
}
