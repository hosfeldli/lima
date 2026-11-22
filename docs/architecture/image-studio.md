# Image Studio

Image Studio uses a workspace tab, a compact toolbar, a scrollable canvas, and temporary controls for individual operations. Open it from **Open Image Studio** in a workspace's sidebar menu, then enter a workspace-relative file path. For automation, a workspace agent can run the same local operations through Lima's MCP tools.

## Local editing foundation

The Swift runtime accepts single-image PNG, JPEG, and TIFF sources. It inspects dimensions, source format, color space, and pixel transparency. The editor supports exact crop and resize, rotation, transparent-margin trim, image masks, and color keying in CIELAB. Connected color keying starts at the perimeter, which keeps enclosed details with the same color. The original file stays in the project. An editable document holds immutable PNG revisions and a revision tree in the local Lima runtime.

Image Studio reads a reduced-size preview. Zoom controls interpret dimensions using the working image size. Comparison switches between the original and current revision. Exports use a separate workspace-relative filename. The runtime verifies the encoded format, dimensions, and transparency before publishing the file. JPEG composites transparency over white. Generated metadata such as EXIF location is excluded from exported files.

The tool surface is limited to the authenticated workspace. Relative paths can reference existing visible directories within that workspace. File access uses directory descriptors and rejects symlink traversal. Existing exports and originals cannot be overwritten. Inputs are limited to 32 MB, 12 megapixels, and 8,192 pixels per edge. Revision edits are serialized in the native runtime. Image Studio stays responsive while native processing runs. Opening an agent-created preview tab leaves the current browser tab selected.

## Tool contract

`image.open` accepts `path` and optional `show_in_workspace`. `image.inspect`, `image.sample_color`, and `image.history` return data for a document and revision. Mutations take `document_id`, `source_revision`, and an `idempotency_key`. The active revision must match the requested source revision. Identical retries return the existing result. A reused key with different parameters is rejected.

- `image.crop` accepts `x`, `y`, `width`, and `height` in `parameters`. Set `coordinate_space` to `normalized` for 0–1 coordinates. The origin is the image's top-left corner.
- `image.resize` accepts exact `width` and `height` and a `mode` of `contain`, `cover`, `stretch`, or `pad`.
- `image.color_key` accepts up to four `target_colors` in hex notation plus `tolerance`, `softness`, `connected_only`, and `invert`.
- `image.mask` accepts an image-sized mask at `parameters.path`, a `channel` of `luminance` or `alpha`, and optional `invert`.
- `image.undo`, `image.redo`, and `image.checkout` navigate revisions. Checkout takes `parameters.revision_id`.
- `image.export` and `image.convert` accept `output_name` with a matching extension and optional `parameters.format` and `parameters.quality`.

Browser calls include `workspace_id`. The workspace-bound MCP tools use underscore names such as `image_color_key` and take their scope from token authentication. Browser-only helpers receive no filesystem image tools.

## Remaining phases

The local foundation uses full raster revisions. Vector tracing and structured SVG editing require a separately validated geometry engine. Semantic generation and segmentation require provider adapters, upload authorization, and usage controls. Editable mixed-media layers, path handles, animation authoring, and character reference profiles build on those later components.
