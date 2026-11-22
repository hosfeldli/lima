import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import LimaProtocol
import UniformTypeIdentifiers

actor AnimationStudio {
    private struct Timeline: Codable {
        var width = 0
        var height = 0
        var loop: Bool
        var frames: [Frame] = []
    }

    private struct Frame: Codable {
        let id: String
        let asset: String
        var duration_ms: Int
    }

    private let store: StudioHistory

    init(root: URL) { store = StudioHistory(root: root) }

    func perform(_ method: String, workspace: Workspace, params: JSONValue?, rendered: [Data] = [], browser: Bool) throws -> JSONValue {
        if method == "recent" { return store.recent(workspace: workspace.id).map(JSONValue.string) ?? .null }
        if method == "create" {
            let timeline = Timeline(loop: params.bool("loop", default: true))
            let document = try store.create(timeline, workspace: workspace.id)
            return try summary(document, timeline, revision: document.current)
        }
        var document = try store.document(params.string("document_id"), workspace: workspace.id)
        let version = params.optionalString("source_revision") ?? document.current
        if ["inspect", "render_preview", "export", "export_spritesheet"].contains(method) {
            let timeline = try store.load(Timeline.self, document: document, revision: version)
            if method == "inspect" {
                if browser { store.record(document.id, workspace: workspace.id) }
                return try summary(document, timeline, revision: version)
            }
            guard !timeline.frames.isEmpty else { throw ImageRaster.invalid("Add a frame before rendering the timeline.") }
            let images = try timeline.frames.map { try ImageRaster.decode(Data(contentsOf: frame(document, $0.asset))).image }
            if method == "render_preview" {
                guard browser else { throw BridgeError(.notAuthorized, "Open the timeline preview in Image Studio.") }
                let preview = try Self.animated(timeline, images: images, format: "apng", preview: true)
                return try summary(document, timeline, revision: version, extras: ["preview": .string(preview.base64EncodedString())])
            }
            guard params.optionalString("source_revision") != nil else { throw ImageRaster.invalid("Choose an exact animation revision.") }
            let output = try params.string("output_name")
            let format = params.optionalString("format") ?? "gif"
            let suffix = URL(fileURLWithPath: output).pathExtension.lowercased()
            let artifacts: [JSONValue]
            if method == "export_spritesheet" {
                guard suffix == "png" else { throw ImageRaster.invalid("Spritesheets use the .png extension.") }
                let columns = try params?["columns"].map { _ in try ImageRaster.integer(params, "columns") } ?? min(6, images.count)
                let sheet = try Self.spritesheet(timeline, images: images, columns: columns)
                let metadata = String(output.dropLast(4)) + ".json"
                let information = try JSONEncoder().encode(sheet.metadata)
                try ImageWorkspaceFiles.verifyNewOutput(root: workspace.directory, path: metadata)
                try ImageWorkspaceFiles.export(root: workspace.directory, path: output, data: sheet.png)
                do { try ImageWorkspaceFiles.export(root: workspace.directory, path: metadata, data: information) }
                catch { throw ImageRaster.invalid("The spritesheet PNG was written, but the frame metadata could not be saved. Choose a new output name.") }
                artifacts = [.string(output), .string(metadata)]
            } else {
                guard (format == "gif" && suffix == "gif") || (format == "apng" && ["apng", "png"].contains(suffix)) else {
                    throw ImageRaster.invalid("Export GIF as .gif, or APNG as .apng or .png.")
                }
                guard images.count > 1 else { throw ImageRaster.invalid("An animated export needs at least two frames.") }
                let encoded = try Self.animated(timeline, images: images, format: format)
                try ImageWorkspaceFiles.export(root: workspace.directory, path: output, data: encoded)
                artifacts = [.string(output)]
            }
            return try summary(document, timeline, revision: version, extras: ["artifact_ids": .array(artifacts)])
        }

        let folder = store.folder(document.id)
        let changed = try store.update(&document, request: params, method: method, as: Timeline.self) { timeline in
            switch method {
            case "add_frame", "tween":
                let duration = try Self.duration(params)
                guard !rendered.isEmpty, timeline.frames.count + rendered.count <= 60 else {
                    throw ImageRaster.invalid("Provide frames within the 60-frame timeline limit.")
                }
                for data in rendered {
                    let image = try ImageRaster.decode(data).image
                    guard image.width <= 1024, image.height <= 1024 else { throw ImageRaster.invalid("Animation frames must fit within 1,024 pixels per edge.") }
                    if timeline.frames.isEmpty { timeline.width = image.width; timeline.height = image.height }
                    guard timeline.width == image.width, timeline.height == image.height,
                          (timeline.frames.count + 1) * image.width * image.height <= 16_000_000 else {
                        throw ImageRaster.invalid("Use matching frame dimensions within the timeline pixel limit.")
                    }
                    let asset = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                    let location = folder.appendingPathComponent(asset + ".png")
                    if !FileManager.default.fileExists(atPath: location.path) {
                        try ImageRaster.encoded(image, format: "png").write(to: location, options: .atomic)
                    }
                    timeline.frames.append(Frame(id: UUID().uuidString, asset: asset, duration_ms: duration))
                }
            case "duplicate_frame", "set_duration", "remove_frame", "move_frame":
                let id = try params.string("frame_id")
                guard let index = timeline.frames.firstIndex(where: { $0.id == id }) else { throw ImageRaster.invalid("This frame ID does not exist.") }
                switch method {
                case "duplicate_frame":
                    guard timeline.frames.count < 60,
                          (timeline.frames.count + 1) * timeline.width * timeline.height <= 16_000_000 else {
                        throw ImageRaster.invalid("The timeline has reached its frame limit.")
                    }
                    let source = timeline.frames[index]
                    timeline.frames.insert(Frame(id: UUID().uuidString, asset: source.asset, duration_ms: source.duration_ms), at: index + 1)
                case "remove_frame": timeline.frames.remove(at: index)
                case "move_frame":
                    let position = try ImageRaster.integer(params, "index")
                    guard timeline.frames.indices.contains(position) else { throw ImageRaster.invalid("The frame position is out of bounds.") }
                    let moved = timeline.frames.remove(at: index)
                    timeline.frames.insert(moved, at: position)
                default: timeline.frames[index].duration_ms = try Self.duration(params)
                }
            case "set_loop": timeline.loop = params.bool("loop", default: true)
            default: throw ImageRaster.invalid("Unsupported timeline operation.")
            }
        }
        return try summary(document, store.load(Timeline.self, document: document, revision: changed), revision: changed)
    }

    static func duration(_ params: JSONValue?) throws -> Int {
        let ms = try params?["duration_ms"].map { _ in try ImageRaster.integer(params, "duration_ms") } ?? 150
        guard (20...10_000).contains(ms) else { throw ImageRaster.invalid("Use a frame duration between 20 and 10,000 ms.") }
        return ms
    }

    private func frame(_ document: StudioHistory.Document, _ asset: String) -> URL {
        store.folder(document.id).appendingPathComponent(asset + ".png")
    }

    private func summary(_ document: StudioHistory.Document, _ timeline: Timeline, revision: String,
                         extras: [String: JSONValue] = [:]) throws -> JSONValue {
        var result = store.summary(document, revision: revision)
        result["studio_url"] = .string("about:lima?view=image&imageWorkspace=\(document.workspace)&animationDocument=\(document.id)")
        result["dimensions"] = .object(["width": .number(Double(timeline.width)), "height": .number(Double(timeline.height))])
        result["frames"] = .array(timeline.frames.map { .object(["id": .string($0.id), "duration_ms": .number(Double($0.duration_ms))]) })
        result["loop"] = .bool(timeline.loop)
        return .object(result.merging(extras) { _, new in new })
    }

    private static func animated(_ timeline: Timeline, images: [CGImage], format: String, preview: Bool = false) throws -> Data {
        let isGIF = format == "gif"
        let type = isGIF ? UTType.gif : UTType.png
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, type.identifier as CFString, images.count, nil) else {
            throw ImageRaster.invalid("The animated encoder is unavailable.")
        }
        let dictionary = isGIF ? kCGImagePropertyGIFDictionary : kCGImagePropertyPNGDictionary
        let loopKey = isGIF ? kCGImagePropertyGIFLoopCount : kCGImagePropertyAPNGLoopCount
        let delayKey = isGIF ? kCGImagePropertyGIFDelayTime : kCGImagePropertyAPNGDelayTime
        let unclamped = isGIF ? kCGImagePropertyGIFUnclampedDelayTime : kCGImagePropertyAPNGUnclampedDelayTime
        // GIF omits the Netscape repeat entry to play once. APNG num_plays=1.
        if timeline.loop || !isGIF {
            CGImageDestinationSetProperties(destination, [dictionary: [loopKey: timeline.loop ? 0 : 1]] as CFDictionary)
        }
        var expected = (w: timeline.width, h: timeline.height)
        for (index, original) in images.enumerated() {
            let scale = preview ? min(1, 96.0 / Double(max(original.width, original.height))) : 1
            let image: CGImage
            if scale < 1 {
                expected = (max(1, Int(Double(original.width) * scale)), max(1, Int(Double(original.height) * scale)))
                image = try ImageRaster.resized(original, width: expected.w, height: expected.h, mode: "stretch")
            } else { image = original }
            let delay = Double(timeline.frames[index].duration_ms) / 1000
            CGImageDestinationAddImage(destination, image, [dictionary: [delayKey: delay, unclamped: delay]] as CFDictionary)
        }
        guard CGImageDestinationFinalize(destination), output.length <= ImageRaster.maxFileBytes,
              let source = CGImageSourceCreateWithData(output as CFData, nil), CGImageSourceGetCount(source) == images.count,
              CGImageSourceGetType(source) as String? == type.identifier else {
            throw ImageRaster.invalid("The animated file could not be encoded or reopened.")
        }
        for index in images.indices {
            guard let verified = CGImageSourceCreateImageAtIndex(source, index, nil),
                  verified.width == expected.w, verified.height == expected.h else {
                throw ImageRaster.invalid("Animation export verification failed for a frame.")
            }
        }
        return output as Data
    }

    private struct SheetFrame: Codable {
        let id: String
        let x: Int
        let y: Int
        let width: Int
        let height: Int
        let duration_ms: Int
    }

    private struct SheetMetadata: Codable {
        let loop: Bool
        let frames: [SheetFrame]
    }

    private static func spritesheet(_ timeline: Timeline, images: [CGImage], columns: Int) throws -> (png: Data, metadata: SheetMetadata) {
        guard (1...images.count).contains(columns) else { throw ImageRaster.invalid("Choose between one column and the number of frames.") }
        let rows = (images.count + columns - 1) / columns
        let w = timeline.width * columns, h = timeline.height * rows
        try ImageRaster.validate(w, h)
        guard let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw ImageRaster.invalid("Could not allocate the spritesheet.")
        }
        let frames = images.enumerated().map { (index, image) -> SheetFrame in
            let x = (index % columns) * timeline.width, y = (index / columns) * timeline.height
            context.draw(image, in: CGRect(x: x, y: h - y - timeline.height, width: timeline.width, height: timeline.height))
            let frame = timeline.frames[index]
            return SheetFrame(id: frame.id, x: x, y: y, width: timeline.width, height: timeline.height, duration_ms: frame.duration_ms)
        }
        guard let surface = context.makeImage() else { throw ImageRaster.invalid("Could not render the spritesheet.") }
        let png = try ImageRaster.encoded(surface, format: "png")
        let check = try ImageRaster.decode(png).image
        guard check.width == w, check.height == h else { throw ImageRaster.invalid("Spritesheet export verification failed.") }
        return (png, SheetMetadata(loop: timeline.loop, frames: frames))
    }
}
