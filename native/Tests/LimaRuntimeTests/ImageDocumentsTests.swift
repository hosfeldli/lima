import CoreGraphics
import Foundation
import LimaProtocol
@testable import LimaRuntime
import Testing

private func imageFixture() throws -> Data {
    var pixels = [UInt8](repeating: 255, count: 5 * 5 * 4)
    for y in 1...3 {
        for x in 1...3 where x != 2 || y != 2 {
            let start = (y * 5 + x) * 4
            pixels.replaceSubrange(start..<(start + 3), with: [0, 0, 0])
        }
    }
    let provider = try #require(CGDataProvider(data: Data(pixels) as CFData))
    let image = try #require(CGImage(width: 5, height: 5, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 20,
                                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
    return try ImageRaster.encoded(image, format: "png")
}

@Test func workspaceAgentKeysCropsAndExportsAnImageWithoutChangingTheOriginal() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let workspace = try #require(await call(runtime, "workspace.create", ["name": .string("Image test")]).result)
    let id = try #require(workspace["id"]?.stringValue)
    let folder = URL(fileURLWithPath: try #require(workspace["directory"]?.stringValue))
    let source = folder.appendingPathComponent("source.png")
    let bytes = try imageFixture()
    try bytes.write(to: source)
    let opened = try #require(await call(runtime, "image.open", ["path": .string("source.png")], origin: .mcp, workspace: id).result)
    let document = try #require(opened["document_id"])
    let initial = try #require(opened["revision_id"])
    #expect(opened["transparent"] == .bool(false))

    let keying: [String: JSONValue] = [
        "document_id": document, "source_revision": initial, "idempotency_key": .string("key"),
        "parameters": .object(["target_colors": .array([.string("#ffffff")]), "tolerance": .number(0), "softness": .number(0)]),
    ]
    let keyed = try #require(await call(runtime, "image.color_key", keying, origin: .mcp, workspace: id).result)
    #expect(keyed["transparent"] == .bool(true))
    #expect(await call(runtime, "image.color_key", keying, origin: .mcp, workspace: id).result == keyed)
    for (x, y, alpha) in [(0, 0, 0), (2, 2, 255)] {
        let sample = await call(runtime, "image.sample_color", [
            "document_id": document, "parameters": .object(["x": .number(Double(x)), "y": .number(Double(y))]),
        ], origin: .mcp, workspace: id)
        #expect(sample.result?["rgba"]?.arrayValue?.last == .number(Double(alpha)))
    }

    let crop: [String: JSONValue] = [
        "document_id": document, "source_revision": try #require(keyed["revision_id"]), "idempotency_key": .string("crop"),
        "parameters": .object(["x": .number(0), "y": .number(0), "width": .number(4), "height": .number(4)]),
    ]
    let cropped = try #require(await call(runtime, "image.crop", crop, origin: .mcp, workspace: id).result)
    #expect(cropped["dimensions"]?["width"] == .number(4))
    let stale = crop.merging(["idempotency_key": .string("stale")]) { _, new in new }
    #expect(await call(runtime, "image.crop", stale, origin: .mcp, workspace: id).error?.code == .badRequest)

    let revision = try #require(cropped["revision_id"])
    let export: [String: JSONValue] = ["document_id": document, "source_revision": revision, "idempotency_key": .string("export"),
                                       "output_name": .string("ready.png")]
    let saved = try #require(await call(runtime, "image.export", export, origin: .mcp, workspace: id).result)
    #expect(saved["artifact_ids"] == .array([.string("ready.png")]))
    #expect(await call(runtime, "image.export", export, origin: .mcp, workspace: id).result == saved)
    let artifact = try ImageRaster.decode(Data(contentsOf: folder.appendingPathComponent("ready.png"))).image
    #expect(artifact.width == 4 && artifact.height == 4)
    #expect(try ImageRaster.hasTransparency(artifact))
    let overwrite = export.merging(["output_name": .string("source.png"), "idempotency_key": .string("overwrite")]) { _, new in new }
    #expect(await call(runtime, "image.export", overwrite, origin: .mcp, workspace: id).error?.code == .badRequest)
    #expect(try Data(contentsOf: source) == bytes)

    let undo = try #require(await call(runtime, "image.undo", ["document_id": document, "source_revision": revision,
                                                              "idempotency_key": .string("undo")], origin: .mcp, workspace: id).result)
    #expect(undo["revision_id"] == keyed["revision_id"])
    let other = try #require(await call(runtime, "workspace.create", ["name": .string("Other")]).result?["id"]?.stringValue)
    #expect(await call(runtime, "image.inspect", ["document_id": document], origin: .mcp, workspace: other).error?.code == .notAuthorized)
    try FileManager.default.createSymbolicLink(at: folder.appendingPathComponent("shortcut.png"), withDestinationURL: source)
    #expect(await call(runtime, "image.open", ["path": .string("shortcut.png")], origin: .mcp, workspace: id).error != nil)
    await runtime.terminals.closeAll()
}
