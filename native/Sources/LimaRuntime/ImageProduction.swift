import CoreGraphics
import Foundation
import LimaProtocol

extension Runtime {
    func studioWorkspace(_ params: JSONValue?, _ context: CallContext) async throws -> Workspace {
        let id: String
        if let bound = context.workspaceID {
            guard params.optionalString("workspace_id").map({ $0 == bound }) ?? true else {
                throw BridgeError(.notAuthorized, "Studio tools are scoped to your workspace.")
            }
            id = bound
        } else {
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Open Studio from a workspace.") }
            id = try params.string("workspace_id")
        }
        let workspace = try await workspaces.get(id)
        try await workspaces.requireActive(id)
        return workspace
    }

    func showStudioResult(_ result: JSONValue, title: String, workspace: String) async throws {
        guard let url = result["studio_url"]?.stringValue else { return }
        let changed = try await workspaces.update(workspace) { record in
            if !record.tabs.contains(where: { $0.url == url }) { record.tabs.append(.init(url: url, title: title)) }
        }
        broadcast("workspace.updated", changed.publicView)
    }

    func registerImageProduction(images: ImageDocuments) {
        let generation = ImageGeneration(root: paths.data.appendingPathComponent("image-generation", isDirectory: true))
        let vectors = VectorStudio(root: paths.data.appendingPathComponent("vector-documents", isDirectory: true))
        let animation = AnimationStudio(root: paths.data.appendingPathComponent("animation-documents", isDirectory: true))

        register("image.generation_config") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only Lima Settings can configure generation.") }
            if params?["checkpoint"] != nil {
                let settings = try ImageGenerationSettings(params)
                try await self.store.put(settings, collection: "settings", id: ImageGenerationSettings.key)
                return settings.publicView
            }
            return try await self.generationSettings().publicView
        }
        register("image.generation_models") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Choose a checkpoint in Lima Settings.") }
            let saved = try await self.generationSettings()
            let port = try params?["port"].map { _ in try ImageRaster.integer(params, "port") } ?? saved.port
            guard (1024...65535).contains(port) else { throw ImageRaster.invalid("Choose a local port between 1,024 and 65,535.") }
            return .array(try await ComfyImageProvider(port: port).checkpoints().map(JSONValue.string))
        }
        register("image.generate") { [unowned self] params, context in
            Task { await self.usage.count("image.generated") }
            let workspace = try await self.studioWorkspace(params, context)
            let settings = try await self.generationSettings()
            guard context.origin == .browser || settings.allowAgents else {
                throw BridgeError(.notAuthorized, "Enable Allow Workspace Agents in Image Generation settings first.")
            }
            return try await generation.start(params: params, workspace: workspace, settings: settings,
                                              provider: ComfyImageProvider(port: settings.port),
                                              checkAccess: { [unowned self] in
                try await self.workspaces.requireActive(workspace.id)
                if context.origin != .browser, try await !self.generationSettings().allowAgents {
                    throw BridgeError(.notAuthorized, "Workspace generation was disabled before import.")
                }
            }) { [weak self] output, show in
                let document = try await images.open(workspace: workspace.id, directory: workspace.directory, source: output)
                if show { try await self?.showStudioResult(document, title: URL(fileURLWithPath: output).lastPathComponent, workspace: workspace.id) }
                return document
            }
        }
        register("image.generation_status") { [unowned self] params, context in
            let workspace = try await self.studioWorkspace(params, context)
            return try await generation.status(params.string("operation_id"), workspace: workspace.id)
        }
        register("image.generation_latest") { [unowned self] params, context in
            let workspace = try await self.studioWorkspace(params, context)
            return try await generation.latest(workspace: workspace.id)
        }
        register("image.generation_cancel") { [unowned self] params, context in
            let workspace = try await self.studioWorkspace(params, context)
            return try await generation.cancel(params.string("operation_id"), workspace: workspace.id)
        }

        register("vector.trace") { [unowned self] params, context in
            let workspace = try await self.studioWorkspace(params, context)
            let bytes = try await images.snapshot(workspace: workspace.id, id: params.string("document_id"), revision: params.string("source_revision"))
            let settings = params?["parameters"]
            let colors = try settings?["colors"].map { _ in try ImageRaster.integer(settings, "colors") } ?? 6
            let edge = try settings?["max_edge"].map { _ in try ImageRaster.integer(settings, "max_edge") } ?? 256
            let area = try settings?["minimum_area"].map { _ in try ImageRaster.integer(settings, "minimum_area") } ?? 2
            let document = try await vectors.trace(bytes, workspace: workspace.id, colors: colors, edge: edge, minimumArea: area,
                                                   mode: settings.optionalString("mode") ?? "flat_color")
            if params.bool("show_in_workspace", default: false) {
                try await self.showStudioResult(document, title: "Vector trace", workspace: workspace.id)
            }
            return document
        }
        for method in ["open", "recent", "inspect", "get_path", "render", "validate", "export", "set_style", "set_fill", "set_stroke", "set_opacity",
                       "set_path", "edit_nodes", "move", "scale", "rotate", "transform", "group", "ungroup", "reorder",
                       "duplicate", "delete", "undo", "redo"] {
            register("vector." + method) { [unowned self] params, context in
                let workspace = try await self.studioWorkspace(params, context)
                let result = try await vectors.perform(method, workspace: workspace, params: params, browser: context.origin == .browser)
                if method == "open" && params.bool("show_in_workspace", default: false) {
                    try await self.showStudioResult(result, title: URL(fileURLWithPath: params.string("path")).lastPathComponent, workspace: workspace.id)
                }
                return result
            }
        }

        for method in ["create", "recent", "inspect", "add_frame", "duplicate_frame", "set_duration", "remove_frame", "move_frame",
                       "set_loop", "tween", "undo", "redo", "render_preview", "export", "export_spritesheet"] {
            register("animation." + method) { [unowned self] params, context in
                let workspace = try await self.studioWorkspace(params, context)
                let frames: [Data]
                switch method {
                case "add_frame":
                    if let document = params.optionalString("vector_document_id") {
                        frames = [try await vectors.frame(workspace: workspace.id, document: document, revision: params.string("vector_revision"))]
                    } else if let document = params.optionalString("image_document_id") {
                        frames = [try await images.snapshot(workspace: workspace.id, id: document, revision: params.string("image_revision"))]
                    } else {
                        let path = try params.string("path")
                        let data = try ImageWorkspaceFiles.read(root: workspace.directory, path: path)
                        if path.lowercased().hasSuffix(".svg") {
                            frames = [try await vectors.frame(svg: data)]
                        } else { frames = [data] }
                    }
                case "tween":
                    frames = try await vectors.tween(workspace: workspace.id, document: params.string("vector_document_id"),
                                                     revision: params.string("vector_revision"), params: params)
                default: frames = []
                }
                let result = try await animation.perform(method, workspace: workspace, params: params, rendered: frames,
                                                         browser: context.origin == .browser)
                if method == "create", params.bool("show_in_workspace", default: false) {
                    try await self.showStudioResult(result, title: "Animation timeline", workspace: workspace.id)
                }
                return result
            }
        }
    }

    private func generationSettings() async throws -> ImageGenerationSettings {
        try await store.get(ImageGenerationSettings.self, collection: "settings", id: ImageGenerationSettings.key) ?? ImageGenerationSettings()
    }
}

extension VectorStudio {
    func trace(_ bytes: Data, workspace: String, colors: Int, edge: Int, minimumArea: Int, mode: String) throws -> JSONValue {
        let original = try ImageRaster.decode(bytes).image
        let artwork = try StudioVector.trace(original, colors: colors, edge: edge, minArea: minimumArea, mode: mode)
        let preview = try artwork.raster(maxEdge: 256)
        let reference = try ImageRaster.resized(original, width: preview.width, height: preview.height, mode: "stretch")
        let traced = try ImageRaster.pixels(preview)
        let source = try ImageRaster.pixels(reference)
        var difference = 0, coverage = 0
        for index in traced.indices {
            difference += abs(Int(traced[index]) - Int(source[index]))
            if index % 4 == 3 {
                coverage += (traced[index] >= 128 ? 1 : 0) - (source[index] >= 128 ? 1 : 0)
            }
        }
        let mean = Double(difference) / (255 * Double(traced.count))
        var result = try create(artwork, workspace: workspace).objectValue!
        result["comparison"] = .object(["mean_rgba_difference": .number(mean),
                                        "opaque_coverage_delta": .number(Double(coverage) / Double(preview.width * preview.height))])
        result["warnings"] = mean >= 0.12 ? .array([.string("This trace visibly simplifies the original. Inspect the preview before export.")]) : .array([])
        return .object(result)
    }

    func frame(svg: Data) throws -> Data {
        try ImageRaster.encoded(StudioVector.parse(svg).raster(maxEdge: 1024), format: "png")
    }

    func frame(workspace: String, document: String, revision: String) throws -> Data {
        let vector = try artwork(workspace: workspace, document: document, revision: revision)
        return try ImageRaster.encoded(vector.raster(maxEdge: 1024), format: "png")
    }

    func tween(workspace: String, document: String, revision: String, params: JSONValue?) throws -> [Data] {
        struct Pose: Decodable {
            let shape_id: String
            let from: [Double]
            let to: [Double]
        }
        let original = try artwork(workspace: workspace, document: document, revision: revision)
        let poses = try params.decode("poses", as: [Pose].self)
        let count = try ImageRaster.integer(params, "frame_count")
        guard (2...24).contains(count), !poses.isEmpty, poses.count <= 40,
              Set(poses.map(\.shape_id)).count == poses.count,
              poses.allSatisfy({ $0.from.count == 4 && $0.to.count == 4 && ($0.from + $0.to).allSatisfy(StudioVector.bounded)
                  && $0.from[3] > 0 && $0.to[3] > 0 }) else {
            throw ImageRaster.invalid("Use 2–24 frames and unique pose shapes with [x, y, degrees, positive scale] for from and to.")
        }
        let pixelScale = min(1, 1024.0 / Double(max(original.width, original.height)))
        guard Double(original.width * original.height * count) * pixelScale * pixelScale <= 16_000_000 else {
            throw ImageRaster.invalid("The tween exceeds the timeline pixel budget. Use fewer frames or smaller vector dimensions.")
        }
        let targets = try poses.map { pose in
            guard let index = original.shapes.firstIndex(where: { $0.id == pose.shape_id }) else {
                throw ImageRaster.invalid("The tween includes a shape ID that does not exist.")
            }
            return (index, pose)
        }
        return try (0..<count).map { frame in
            var vector = original
            let progress = Double(frame) / Double(count - 1)
            for (index, pose) in targets {
                let p = zip(pose.from, pose.to).map { $0 + ($1 - $0) * progress }
                let adjustment = CGAffineTransform(scaleX: p[3], y: p[3])
                    .concatenating(.init(rotationAngle: p[2] * .pi / 180)).concatenating(.init(translationX: p[0], y: p[1]))
                vector.shapes[index].matrix = StudioVector.matrix(StudioVector.transform(original.shapes[index].matrix).concatenating(adjustment))
            }
            return try ImageRaster.encoded(vector.raster(maxEdge: 1024), format: "png")
        }
    }
}
