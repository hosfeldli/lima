import CoreGraphics
import Foundation
import ImageIO
import LimaProtocol
@testable import LimaRuntime
import Testing

private let artworkSVG = """
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12" viewBox="0 0 16 12">
  <g id="character" transform="translate(1 1)">
    <path id="face" d="M1 1 H12 V9 H1 Z M4 3 L4 7 L9 7 L9 3 Z" fill="#202020" fill-rule="evenodd"/>
    <circle id="eye" cx="6" cy="5" r="1.3" fill="#0077aa"/>
  </g>
</svg>
"""

@Test func vectorTracePreservesInteriorHolesAndExportsEditedPaths() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let fixture = try #require(await call(runtime, "workspace.create", ["name": .string("Vector production")]).result)
    let workspace = try #require(fixture["id"]?.stringValue)
    let folder = URL(fileURLWithPath: try #require(fixture["directory"]?.stringValue))
    let image = try StudioVector.parse(Data(artworkSVG.utf8)).raster()
    try ImageRaster.encoded(image, format: "png").write(to: folder.appendingPathComponent("source.png"))
    let raster = try #require(await call(runtime, "image.open", ["path": .string("source.png")], origin: .mcp, workspace: workspace).result)
    let rasterID = try #require(raster["document_id"])
    let rasterRevision = try #require(raster["revision_id"])
    let trace = try #require(await call(runtime, "vector.trace", [
        "document_id": rasterID, "source_revision": rasterRevision,
        "parameters": .object(["colors": .number(2), "minimum_area": .number(2)]), "show_in_workspace": .bool(true),
    ], origin: .mcp, workspace: workspace).result)
    let shapes = try #require(trace["shapes"]?.arrayValue)
    #expect(shapes.count >= 2)
    let shape = try #require(shapes.first?["id"])
    let shapeRevision = try #require(trace["revision_id"])
    let id = try #require(trace["document_id"])
    let path = try #require(await call(runtime, "vector.get_path", ["document_id": id, "shape_id": shape], origin: .mcp, workspace: workspace).result)
    let segments = try #require(path["segments"]?.arrayValue)
    #expect(segments.count > 4)
    let edit: [String: JSONValue] = [
        "document_id": id, "source_revision": shapeRevision, "idempotency_key": .string("new-color"),
        "target_ids": .array([shape]), "parameters": .object(["color": .string("#b02029")]),
    ]
    let edited = try #require(await call(runtime, "vector.set_fill", edit, origin: .mcp, workspace: workspace).result)
    #expect(edited["shapes"]?.arrayValue?.first?["fill"] == .string("#b02029"))
    #expect(await call(runtime, "vector.set_fill", edit, origin: .mcp, workspace: workspace).result == edited)
    let invalid = edit.merging(["idempotency_key": .string("stale")]) { _, new in new }
    #expect(await call(runtime, "vector.set_fill", invalid, origin: .mcp, workspace: workspace).error?.code == .badRequest)
    let saved = await call(runtime, "vector.export", [
        "document_id": id, "source_revision": try #require(edited["revision_id"]), "output_name": .string("result.svg"),
    ], origin: .mcp, workspace: workspace)
    #expect(saved.ok)
    let bytes = try Data(contentsOf: folder.appendingPathComponent("result.svg"))
    #expect(!String(decoding: bytes, as: UTF8.self).contains("<image"))
    let reopened = try StudioVector.parse(bytes)
    #expect(reopened.shapes.first?.fill == "#b02029")
    #expect(try ImageRaster.sample(reopened.raster(), x: 5, y: 4)[3] < 255)
    await runtime.terminals.closeAll()
}

@Test func studioRejectsActiveOrExternalSVGContent() throws {
    for unsafe in [
        "<script>alert(1)</script>", "<image href=\"https://example.com/photo.png\"/>",
        "<path d=\"M 0 0 L 1 1\" onclick=\"alert(1)\"/>", "<foreignObject/>",
        "<path fill=\"url(https://example.com/fill)\" d=\"M 0 0 L 1 1\"/>",
    ] {
        #expect(throws: BridgeError.self) {
            try StudioVector.parse(Data("<svg width=\"10\" height=\"10\">\(unsafe)</svg>".utf8))
        }
    }
    let safe = try StudioVector.parse(Data(artworkSVG.utf8))
    #expect(safe.shapes.map(\.id) == ["face", "eye"])
    #expect(safe.shapes[1].segments.contains { $0.command == "C" })
}

@Test func animationAuthorsVectorTweensAndExportsVerifiedFiles() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let fixture = try #require(await call(runtime, "workspace.create", ["name": .string("Motion")]).result)
    let workspace = try #require(fixture["id"]?.stringValue)
    let folder = URL(fileURLWithPath: try #require(fixture["directory"]?.stringValue))
    try Data(artworkSVG.utf8).write(to: folder.appendingPathComponent("source.svg"))
    let model = try #require(await call(runtime, "vector.open", ["path": .string("source.svg")], origin: .mcp, workspace: workspace).result)
    let start = try #require(await call(runtime, "animation.create", ["loop": .bool(false)], origin: .mcp, workspace: workspace).result)
    let id = try #require(start["document_id"])
    let initial = try #require(start["revision_id"])
    let vectorID = try #require(model["document_id"])
    let vectorRevision = try #require(model["revision_id"])
    let tween = try #require(await call(runtime, "animation.tween", [
        "document_id": id, "source_revision": initial, "idempotency_key": .string("tween"),
        "vector_document_id": vectorID, "vector_revision": vectorRevision,
        "duration_ms": .number(130), "frame_count": .number(3),
        "poses": .array([.object(["shape_id": .string("eye"), "from": .array([.number(0), .number(0), .number(0), .number(1)]),
                                  "to": .array([.number(4), .number(1), .number(0), .number(1)])])]),
    ], origin: .mcp, workspace: workspace).result)
    let base: [String: JSONValue] = ["document_id": id, "source_revision": try #require(tween["revision_id"])]
    #expect(tween["frames"]?.arrayValue?.count == 3)
    for (format, filename) in [("apng", "result.apng"), ("gif", "result.gif")] {
        let response = await call(runtime, "animation.export", base.merging(["format": .string(format), "output_name": .string(filename)]) { _, new in new },
                                  origin: .mcp, workspace: workspace)
        #expect(response.ok, "\(String(describing: response.error))")
        let data = try Data(contentsOf: folder.appendingPathComponent(filename))
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        #expect(CGImageSourceGetCount(source) == 3)
        let first = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let last = try #require(CGImageSourceCreateImageAtIndex(source, 2, nil))
        #expect(try ImageRaster.pixels(first) != ImageRaster.pixels(last))
    }
    let sheet = await call(runtime, "animation.export_spritesheet", base.merging(["output_name": .string("sprites.png"), "columns": .number(2)]) { _, new in new },
                           origin: .mcp, workspace: workspace)
    #expect(sheet.ok)
    let manifest = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: folder.appendingPathComponent("sprites.json")))
    #expect(manifest["frames"]?.arrayValue?.last?["y"] == .number(12))
    #expect(manifest["frames"]?.arrayValue?.last?["duration_ms"] == .number(130))
    await runtime.terminals.closeAll()
}

private actor TestImageProvider: ImageGenerationProvider {
    let png: Data
    private(set) var submits = 0
    init(_ png: Data) { self.png = png }
    func checkpoints() async throws -> [String] { ["fixture.safetensors"] }
    func submit(_ request: ImageGenerationRequest, settings: ImageGenerationSettings) async throws -> String {
        submits += 1
        return UUID().uuidString
    }
    func result(_ id: String) async throws -> [Data]? { [png] }
}

@Test func generationKeepsProvenanceAndIdempotencyAndProtectsOriginals() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let created = try #require(await call(runtime, "workspace.create", ["name": .string("Generation")]).result?["id"]?.stringValue)
    let workspace = try await runtime.workspaces.get(created)
    let bitmap = try StudioVector.parse(Data(artworkSVG.utf8)).raster()
    let png = try ImageRaster.encoded(ImageRaster.resized(bitmap, width: 256, height: 256, mode: "contain"), format: "png")
    let provider = TestImageProvider(png)
    let jobs = ImageGeneration(root: dir.appendingPathComponent("test-jobs"))
    let images = ImageDocuments(root: dir.appendingPathComponent("test-images"))
    var config = ImageGenerationSettings()
    config.checkpoint = "fixture.safetensors"
    let payload = JSONValue.object(["prompt": .string("An original folded-cap mascot"), "width": .number(256), "height": .number(256),
                                    "output_name": .string("generated.png"), "idempotency_key": .string("job-a")])
    let prepare: @Sendable (String, Bool) async throws -> JSONValue = { filename, _ in
        try await images.open(workspace: workspace.id, directory: workspace.directory, source: filename)
    }
    let job = try await jobs.start(params: payload, workspace: workspace, settings: config, provider: provider, prepare: prepare)
    let id = try #require(job["operation_id"]?.stringValue)
    _ = try await jobs.start(params: payload, workspace: workspace, settings: config, provider: provider, prepare: prepare)
    var state = job
    for _ in 0..<50 where ["queued", "running"].contains(state["status"]?.stringValue ?? "") {
        try await Task.sleep(for: .milliseconds(50))
        state = try await jobs.status(id, workspace: workspace.id)
    }
    #expect(state["status"] == .string("completed"))
    #expect(state["prompt"] == .string("An original folded-cap mascot"))
    #expect(state["model"] == .string("fixture.safetensors"))
    #expect(state["documents"]?.arrayValue?.count == 1)
    #expect(await provider.submits == 1)
    #expect(await call(runtime, "image.generate", ["prompt": .string("test"), "output_name": .string("blocked.png"), "idempotency_key": .string("not-allowed")],
                       origin: .mcp, workspace: workspace.id).error?.code == .notAuthorized)
    await runtime.terminals.closeAll()
}
