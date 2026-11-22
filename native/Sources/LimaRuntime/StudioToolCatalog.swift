import LimaProtocol

extension MCPServer {
    static let productionTools: [Tool] = {
        let number = schema("number"), integer = schema("integer"), string = schema("string"), bool = schema("boolean")
        let source: [String: JSONValue] = ["document_id": string, "source_revision": string]
        let targets: [String: JSONValue] = ["target_ids": list(string)]
        let changed = source.merging(["idempotency_key": string]) { _, new in new }
        let editRequired = ["document_id", "source_revision", "idempotency_key"]
        var tools = [
            studioTool("image.generate", "Queue local text-to-image generation with the configured ComfyUI checkpoint. Poll image_generation_status using operation_id.",
                       ["prompt": string, "negative_prompt": string, "width": integer, "height": integer, "count": integer, "seed": integer,
                        "output_name": string, "idempotency_key": string, "show_in_workspace": bool],
                       ["prompt", "output_name", "idempotency_key"]),
            studioTool("image.generation_status", "Check a queued generation job. Completed jobs include actual verified asset paths and editable documents.", ["operation_id": string], ["operation_id"]),
            studioTool("image.generation_cancel", "Stop importing a generation job. An active ComfyUI request can continue locally.", ["operation_id": string], ["operation_id"]),
            studioTool("vector.trace", "Trace an exact raster revision into editable vector paths. Modes are flat_color, monochrome, and outline. Use fewer colors or less resolution for detailed inputs.",
                       source.merging(["parameters": object(["mode": string, "colors": integer, "max_edge": integer, "minimum_area": integer]),
                                       "show_in_workspace": bool]) { _, new in new }, ["document_id", "source_revision"]),
            studioTool("vector.open", "Open a workspace-relative SVG with editable solid paths, shapes and groups. Unsafe and unsupported SVG features are rejected.",
                       ["path": string, "show_in_workspace": bool], ["path"]),
            studioTool("vector.inspect", "List editable vector shapes and IDs, colors, groups, viewBox and dimensions.", source, ["document_id"]),
            studioTool("vector.get_path", "Read a shape by ID with its path segments, nodes and transform.",
                       source.merging(["shape_id": string]) { _, new in new }, ["document_id", "shape_id"]),
            studioTool("vector.validate", "Validate and render the chosen SVG revision, including a pure-vector check.", source, ["document_id"]),
            studioTool("vector.export", "Verify and export a pure SVG to a new workspace-relative path.", source.merging(["output_name": string]) { _, new in new },
                       ["document_id", "source_revision", "output_name"]),
            studioTool("animation.create", "Create a timeline. Add PNG, JPEG, TIFF, or supported SVG frames, or tween a vector shape.", ["loop": bool, "show_in_workspace": bool], []),
            studioTool("animation.inspect", "List timeline frames with stable IDs, timing, dimensions and loop status.", source, ["document_id"]),
        ]
        let updates: [(String, String, [String: JSONValue])] = [
            ("set_fill", "Change a path's solid fill or set it to none.", ["color": string]),
            ("set_stroke", "Change a path's solid stroke color and width.", ["color": string, "width": number]),
            ("set_opacity", "Set opacity from 0 to 1.", ["opacity": number]),
            ("set_path", "Replace path geometry with SVG path data or absolute segments.", ["path": string, "segments": list(object(["command": string, "points": list(number)]))]),
            ("edit_nodes", "Update path nodes or Bézier control coordinates by zero-based segment index.", ["nodes": list(object(["index": integer, "points": list(number)]))]),
            ("move", "Translate in viewBox units.", ["x": number, "y": number]),
            ("scale", "Scale by positive factors about the viewBox origin.", ["x": number, "y": number]),
            ("rotate", "Rotate clockwise around x,y in viewBox coordinates.", ["degrees": number, "x": number, "y": number]),
            ("transform", "Apply six affine matrix numbers in SVG order.", ["matrix": list(number)]),
            ("group", "Assign a group name to the selected shapes.", ["name": string]),
            ("ungroup", "Remove selected shapes from their groups.", [:]),
            ("reorder", "Move shapes to front or back, preserving their relative order.", ["position": string]),
            ("duplicate", "Duplicate shapes with new stable IDs.", [:]),
            ("delete", "Delete shapes from the active revision. Earlier revisions remain available.", [:]),
        ]
        for (name, label, fields) in updates {
            var schema = changed.merging(targets) { _, new in new }
            if !fields.isEmpty { schema["parameters"] = object(fields) }
            tools.append(studioTool("vector." + name, label, schema, editRequired + ["target_ids"]))
        }
        let animations: [(String, String, [String: JSONValue], [String])] = [
            ("add_frame", "Add a same-sized raster or SVG from a workspace-relative path, or pass an exact image or vector revision.",
             ["path": string, "image_document_id": string, "image_revision": string, "vector_document_id": string, "vector_revision": string, "duration_ms": integer], []),
            ("tween", "Append 2–24 frames by interpolating exact vector shape poses. Each from/to is [x, y, degrees, scale].",
             ["vector_document_id": string, "vector_revision": string, "poses": list(object(["shape_id": string, "from": list(number), "to": list(number)])),
              "frame_count": integer, "duration_ms": integer], ["vector_document_id", "vector_revision", "poses", "frame_count"]),
            ("duplicate_frame", "Duplicate the named frame.", ["frame_id": string], ["frame_id"]),
            ("set_duration", "Change one frame's duration in milliseconds.", ["frame_id": string, "duration_ms": integer], ["frame_id", "duration_ms"]),
            ("remove_frame", "Remove a frame from the current revision.", ["frame_id": string], ["frame_id"]),
            ("move_frame", "Move a frame to a zero-based position.", ["frame_id": string, "index": integer], ["frame_id", "index"]),
            ("set_loop", "Choose continuous or one-shot playback.", ["loop": bool], ["loop"]),
        ]
        for (name, label, fields, required) in animations {
            tools.append(studioTool("animation." + name, label, changed.merging(fields) { _, new in new }, editRequired + required))
        }
        for kind in ["vector", "animation"] {
            tools.append(studioTool(kind + ".undo", "Restore the previous revision.", changed, editRequired))
            tools.append(studioTool(kind + ".redo", "Restore the last undone revision.", changed, editRequired))
        }
        tools.append(studioTool("animation.export", "Validate and export the exact timeline as GIF or APNG.",
            source.merging(["format": string, "output_name": string]) { _, new in new }, ["document_id", "source_revision", "output_name"]))
        tools.append(studioTool("animation.export_spritesheet", "Create a PNG sheet and matching JSON frame timing and coordinates.",
            source.merging(["columns": integer, "output_name": string]) { _, new in new }, ["document_id", "source_revision", "output_name"]))
        return tools
    }()

    private static func studioTool(_ method: String, _ description: String, _ fields: [String: JSONValue], _ required: [String]) -> Tool {
        Tool(name: method.replacingOccurrences(of: ".", with: "_"), description: description, properties: [:], required: required,
             structuredProperties: fields) { args, client in
            try client.call(method, params: args)
        }
    }

    private static func schema(_ type: String) -> JSONValue { .object(["type": .string(type)]) }
    private static func list(_ item: JSONValue) -> JSONValue { .object(["type": .string("array"), "items": item]) }
    private static func object(_ fields: [String: JSONValue]) -> JSONValue { .object(["type": .string("object"), "properties": .object(fields)]) }
}
