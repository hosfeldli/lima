import CoreGraphics
import Foundation
import LimaProtocol

actor ImageDocuments {
    private struct Revision: Codable {
        let id: String
        let parent: String?
        let operation: String
        let parameters: JSONValue?
    }

    private struct Receipt: Codable {
        let request: JSONValue?
        let result: JSONValue
    }

    private struct Document: Codable {
        let id: String
        let workspace: String
        let source: String
        let sourceFormat: String
        var current: String
        var revisions: [Revision]
        var redo: [String] = []
        var receipts: [String: Receipt] = [:]
    }

    private let root: URL

    init(root: URL) { self.root = root }

    private func path(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }
    private func revisionFile(_ document: Document, _ revision: String) -> URL {
        path(document.id).appendingPathComponent(revision + ".png")
    }
    private func save(_ document: Document) throws {
        try JSONEncoder().encode(document).write(to: path(document.id).appendingPathComponent("document.json"), options: .atomic)
    }

    func open(workspace: String, directory: String, source: String) throws -> JSONValue {
        let data = try ImageWorkspaceFiles.read(root: directory, path: source)
        let input = try ImageRaster.decode(data)
        let id = UUID().uuidString
        let revision = Revision(id: UUID().uuidString, parent: nil, operation: "open", parameters: nil)
        let document = Document(id: id, workspace: workspace, source: source, sourceFormat: input.format, current: revision.id, revisions: [revision])
        try FileManager.default.createDirectory(at: path(id), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        do {
            try ImageRaster.encoded(input.image, format: "png").write(to: revisionFile(document, revision.id), options: .atomic)
            try save(document)
        } catch {
            try? FileManager.default.removeItem(at: path(id))
            throw error
        }
        return try metadata(document, image: input.image)
    }

    func perform(_ method: String, workspace: String, directory: String, params: JSONValue?, browser: Bool) throws -> JSONValue {
        let id = try params.string("document_id")
        guard UUID(uuidString: id)?.uuidString == id else { throw ImageRaster.invalid("Invalid image document ID.") }
        let manifest = path(id).appendingPathComponent("document.json")
        guard let data = try? Data(contentsOf: manifest),
              var document = try? JSONDecoder().decode(Document.self, from: data), document.workspace == workspace else {
            throw BridgeError(.notAuthorized, "The image document is unavailable in this workspace.")
        }
        let source = params.optionalString("source_revision") ?? document.current
        guard let revision = document.revisions.first(where: { $0.id == source }) else {
            throw ImageRaster.invalid("This image revision does not exist.")
        }
        if method == "history" {
            return .object(["document_id": .string(id), "revision_id": .string(document.current), "revisions": try JSONValue.from(document.revisions)])
        }

        let mutable = ["crop", "resize", "rotate", "trim", "color_key", "mask", "undo", "redo", "checkout", "export", "convert"].contains(method)
        let key = params.optionalString("idempotency_key")
        if mutable {
            guard let key, !key.isEmpty, key.utf8.count <= 128, params.optionalString("source_revision") != nil else {
                throw ImageRaster.invalid("Include the active source revision and an idempotency key.")
            }
            if let saved = document.receipts[key] {
                guard saved.request == params else { throw ImageRaster.invalid("That idempotency key belongs to a different request.") }
                return saved.result
            }
            guard source == document.current else { throw ImageRaster.invalid("This source revision is stale. Inspect the active revision and retry.") }
            guard document.receipts.count < 256 else { throw ImageRaster.invalid("This document has reached its operation limit.") }
        }

        let image = try load(document, revision.id)
        let settings = params?["parameters"]
        if method == "sample_color" {
            let x = try ImageRaster.integer(settings, "x"), y = try ImageRaster.integer(settings, "y")
            let channels = try ImageRaster.sample(image, x: x, y: y)
            return .object(["document_id": .string(id), "revision_id": .string(source), "rgba": try JSONValue.from(channels),
                            "hex": .string(String(format: "#%02x%02x%02x", channels[0], channels[1], channels[2]))])
        }
        if method == "inspect" || method == "preview" {
            var result = try metadata(document, image: image, revision: source).objectValue!
            if method == "preview" {
                guard browser else { throw BridgeError(.notAuthorized, "Image previews are rendered in Lima.") }
                result["preview"] = .string(try ImageRaster.preview(image).base64EncodedString())
            }
            return .object(result)
        }

        let result: JSONValue
        let operation = UUID().uuidString
        if method == "export" || method == "convert" {
            let format = settings.optionalString("format") ?? "png"
            let filename = try params.string("output_name")
            let suffix = URL(fileURLWithPath: filename).pathExtension.lowercased()
            let extensions = ["png": ["png"], "jpeg": ["jpg", "jpeg"], "tiff": ["tif", "tiff"]]
            guard extensions[format]?.contains(suffix) == true else { throw ImageRaster.invalid("The output filename must match the export format.") }
            let encoded = try ImageRaster.encoded(image, format: format, quality: settings.double("quality", default: 0.9))
            let verified = try ImageRaster.decode(encoded)
            guard verified.image.width == image.width, verified.image.height == image.height, verified.format == format else {
                throw ImageRaster.invalid("Export verification failed.")
            }
            let transparent = try ImageRaster.hasTransparency(image)
            if format != "jpeg", transparent != (try ImageRaster.hasTransparency(verified.image)) {
                throw ImageRaster.invalid("Export changed the image transparency.")
            }
            let warnings = format == "jpeg" && transparent ? ["JPEG uses a white background."] : []
            result = try response(document, image: verified.image, operation: operation,
                                  extras: ["artifact_ids": .array([.string(filename)]), "warnings": try JSONValue.from(warnings)])
            try ImageWorkspaceFiles.export(root: directory, path: filename, data: encoded)
        } else if ["undo", "redo", "checkout"].contains(method) {
            switch method {
            case "undo":
                guard let parent = revision.parent else { throw ImageRaster.invalid("This is the first revision.") }
                document.redo.append(document.current)
                document.current = parent
            case "redo":
                guard let next = document.redo.popLast() else { throw ImageRaster.invalid("There is no revision to redo.") }
                document.current = next
            default:
                let target = try settings.string("revision_id")
                guard document.revisions.contains(where: { $0.id == target }) else { throw ImageRaster.invalid("This revision does not exist.") }
                document.current = target
                document.redo.removeAll()
            }
            result = try response(document, image: load(document, document.current), operation: operation)
        } else {
            let output: CGImage
            switch method {
            case "crop":
                output = try ImageRaster.cropped(image, parameters: settings, coordinates: params.optionalString("coordinate_space") ?? "pixels")
            case "resize":
                output = try ImageRaster.resized(image, width: ImageRaster.integer(settings, "width"),
                                                height: ImageRaster.integer(settings, "height"), mode: settings.optionalString("mode") ?? "contain")
            case "rotate":
                output = try ImageRaster.rotated(image, degrees: settings.double("degrees", default: 0))
            case "trim":
                output = try ImageRaster.trimmed(image)
            case "color_key":
                output = try ImageRaster.colorKey(image, colors: settings.decode("target_colors", as: [String].self),
                                                  tolerance: settings.double("tolerance", default: 8), softness: settings.double("softness", default: 3),
                                                  connected: settings.bool("connected_only", default: true), invert: settings.bool("invert", default: false))
            case "mask":
                let mask = try ImageWorkspaceFiles.read(root: directory, path: settings.string("path"))
                output = try ImageRaster.masked(image, by: ImageRaster.decode(mask).image,
                                                channel: settings.optionalString("channel") ?? "luminance",
                                                invert: settings.bool("invert", default: false))
            default: throw ImageRaster.invalid("Unsupported image operation.")
            }
            if params.bool("preview_only", default: false) {
                guard browser else { throw BridgeError(.notAuthorized, "Open the operation preview in Lima.") }
                return try response(document, image: output, operation: operation,
                                    extras: ["preview": .string(try ImageRaster.preview(output).base64EncodedString())])
            }
            guard document.revisions.count < 24 else { throw ImageRaster.invalid("This document has reached its revision limit.") }
            let next = Revision(id: UUID().uuidString, parent: source, operation: method, parameters: settings)
            document.current = next.id
            document.revisions.append(next)
            document.redo.removeAll()
            result = try response(document, image: output, operation: operation)
            let file = revisionFile(document, next.id)
            try ImageRaster.encoded(output, format: "png").write(to: file, options: .atomic)
            do {
                if let key { document.receipts[key] = Receipt(request: params, result: result) }
                try save(document)
            } catch {
                try? FileManager.default.removeItem(at: file)
                throw error
            }
            return result
        }
        if let key { document.receipts[key] = Receipt(request: params, result: result) }
        try save(document)
        return result
    }

    private func load(_ document: Document, _ revision: String) throws -> CGImage {
        try ImageRaster.decode(Data(contentsOf: revisionFile(document, revision))).image
    }

    private func metadata(_ document: Document, image: CGImage, revision: String? = nil) throws -> JSONValue {
        .object(["document_id": .string(document.id), "revision_id": .string(revision ?? document.current),
                 "studio_url": .string("about:lima?view=image&imageWorkspace=\(document.workspace)&imageDocument=\(document.id)"),
                 "source_path": .string(document.source), "source_format": .string(document.sourceFormat),
                 "dimensions": .object(["width": .number(Double(image.width)), "height": .number(Double(image.height))]),
                 "transparent": .bool(try ImageRaster.hasTransparency(image)), "color_space": .string(image.colorSpace?.name as String? ?? "Unknown"),
                 "can_undo": .bool(document.current != document.revisions.first?.id), "can_redo": .bool(!document.redo.isEmpty)])
    }

    private func response(_ document: Document, image: CGImage, operation: String, extras: [String: JSONValue] = [:]) throws -> JSONValue {
        var value = try metadata(document, image: image).objectValue!
        value["operation_id"] = .string(operation)
        value["status"] = .string("completed")
        return .object(value.merging(extras) { _, new in new })
    }
}

extension Runtime {
    func registerImages() {
        let images = ImageDocuments(root: paths.data.appendingPathComponent("image-documents", isDirectory: true))
        for method in ["open", "inspect", "history", "preview", "sample_color", "crop", "resize", "rotate", "trim", "color_key", "mask",
                       "undo", "redo", "checkout", "export", "convert"] {
            register("image." + method) { [unowned self] params, context in
                let id: String
                if let bound = context.workspaceID {
                    guard params.optionalString("workspace_id").map({ $0 == bound }) ?? true else {
                        throw BridgeError(.notAuthorized, "Image tools are scoped to your workspace.")
                    }
                    id = bound
                } else {
                    guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Open Image Studio from a workspace.") }
                    id = try params.string("workspace_id")
                }
                let workspace = try await self.workspaces.get(id)
                try await self.workspaces.requireActive(id)
                if method == "open" {
                    let source = try params.string("path")
                    let document = try await images.open(workspace: id, directory: workspace.directory, source: source)
                    if params.bool("show_in_workspace", default: false), let url = document["studio_url"]?.stringValue {
                        let name = URL(fileURLWithPath: source).lastPathComponent
                        let changed = try await self.workspaces.update(id) { $0.tabs.append(.init(url: url, title: name)) }
                        self.broadcast("workspace.updated", changed.publicView)
                    }
                    return document
                }
                let result = try await images.perform(method, workspace: id, directory: workspace.directory, params: params,
                                                      browser: context.origin == .browser)
                if ["crop", "resize", "rotate", "trim", "color_key", "mask", "undo", "redo", "checkout"].contains(method),
                   !params.bool("preview_only", default: false) {
                    self.broadcast("image.changed", .object(["workspace_id": .string(id),
                        "document_id": result["document_id"] ?? .null, "revision_id": result["revision_id"] ?? .null]))
                }
                return result
            }
        }
    }
}

extension MCPServer {
    static let imageTools: [Tool] = {
        let source: [String: [String: String]] = ["document_id": ["type": "string"], "source_revision": ["type": "string"]]
        let edits = source.merging(["idempotency_key": ["type": "string"]]) { _, new in new }
        let spec: [(String, String, [String: [String: String]], [String: JSONValue])] = [
            ("crop", "Crop to x, y, width, height from the top left. Use pixels (default) or normalized coordinate_space.",
                ["coordinate_space": ["type": "string"]], ["x": .string("number"), "y": .string("number"), "width": .string("number"), "height": .string("number")]),
            ("resize", "Resize into exact dimensions using contain (default), cover, stretch, or pad.", [:],
                ["width": .string("integer"), "height": .string("integer"), "mode": .string("string")]),
            ("rotate", "Rotate clockwise by degrees and expand the canvas to fit.", [:], ["degrees": .string("number")]),
            ("trim", "Trim fully transparent outer margins.", [:], [:]),
            ("color_key", "Remove one to four #RRGGBB colors. CIELAB tolerance 0–100, softness 0–50. connected_only defaults true to protect enclosed details.",
                [:], ["target_colors": .object(["type": .string("array"), "items": .object(["type": .string("string")])]),
                     "tolerance": .string("number"), "softness": .string("number"), "connected_only": .string("boolean"), "invert": .string("boolean")]),
            ("mask", "Apply an image-sized mask from a workspace-relative image. The mask uses luminance by default. White reveals and black conceals.",
                [:], ["path": .string("string"), "channel": .string("string"), "invert": .string("boolean")]),
            ("undo", "Move the document back one revision.", [:], [:]),
            ("redo", "Restore the last undone revision.", [:], [:]),
            ("checkout", "Make an existing revision active without deleting any descendants.", [:], ["revision_id": .string("string")]),
            ("export", "Export and verify a PNG, JPEG, or TIFF in the workspace. Use an unused workspace-relative output_name.", ["output_name": ["type": "string"]],
                ["format": .string("string"), "quality": .string("number")]),
            ("convert", "Convert the active revision to PNG, JPEG, or TIFF. Use an unused workspace-relative output_name.", ["output_name": ["type": "string"]],
                ["format": .string("string"), "quality": .string("number")]),
        ]
        let tools = spec.map { name, description, fields, settings in
            var structured: [String: JSONValue] = [:]
            if !settings.isEmpty {
                structured["parameters"] = .object(["type": .string("object"), "properties": .object(settings.mapValues {
                    if case .string(let type) = $0 { return .object(["type": .string(type)]) }
                    return $0
                })])
            }
            let required = ["document_id", "source_revision", "idempotency_key"] + (fields["output_name"] == nil ? [] : ["output_name"])
            return Tool(name: "image_" + name, description: description, properties: edits.merging(fields) { _, new in new },
                        required: required, structuredProperties: structured) { args, client in
                try client.call("image." + name, params: args)
            }
        }
        return [
            Tool(name: "image_open", description: "Open a workspace-relative PNG, JPEG, or TIFF in a non-destructive image document. Set show_in_workspace to open a background Image Studio tab.",
                 properties: ["path": ["type": "string"], "show_in_workspace": ["type": "boolean"]], required: ["path"]) { args, client in
                try client.call("image.open", params: args)
            },
            Tool(name: "image_inspect", description: "Inspect an image's exact dimensions, original format, color space, active revision and transparency.",
                 properties: source, required: ["document_id"]) { args, client in try client.call("image.inspect", params: args) },
            Tool(name: "image_history", description: "Read the image's revision tree and editing operations.", properties: source,
                 required: ["document_id"]) { args, client in try client.call("image.history", params: args) },
            Tool(name: "image_sample_color", description: "Sample an exact pixel from the top left and return sRGB hex and RGBA.",
                 properties: source, required: ["document_id", "parameters"],
                 structuredProperties: ["parameters": .object(["type": .string("object"), "properties": .object([
                    "x": .object(["type": .string("integer")]), "y": .object(["type": .string("integer")]),
                 ]), "required": .array([.string("x"), .string("y")])])]) { args, client in
                try client.call("image.sample_color", params: args)
            },
        ] + tools
    }()
}
