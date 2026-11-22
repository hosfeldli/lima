# Image Studio

Image Studio uses a workspace tab, a compact toolbar, a scrollable canvas, and temporary controls for individual operations. Open it from **Open Image Studio** in a workspace's sidebar menu, then enter a workspace-relative file path. For automation, a workspace agent can run the same local operations through Lima's MCP tools.

Raster images, vector documents, and animation timelines with open Studio tabs appear in the workspace's **Images** folder, alongside **Tabs**. The folder starts collapsed, and background additions preserve the selected tab and the folder's current open or closed state. Source and export files keep their original project paths.

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

## Generation and subject selection

The first generation adapter uses a user-configured ComfyUI server at `127.0.0.1`. Open **Settings → Image Generation**, check the connection, and choose an installed compatible Stable Diffusion checkpoint. Checkpoint selection and permission for workspace agents are independent of the chat provider. The adapter builds a text-to-image workflow from standard ComfyUI nodes. It does not accept arbitrary workflow graphs or send project files. [ComfyUI server routes](https://docs.comfy.org/development/comfyui-server/comms_routes)

Companion handles simple prompt-to-image requests. Confirm the destination when it uses an existing workspace. Requests with multiple production steps run through the existing Orchestrator. Jobs expose an operation ID through `image.generate` and retain prompt, seed, model, provider job ID, and verified asset paths. Poll `image.generation_status` before retrying or reporting completion. Cancel stops Lima's import, and an already-running provider workflow can continue. Lima keeps successfully imported variants and opens their preview tabs in the background.

`image.select_subject` uses Apple Vision to estimate foreground objects. The selection ID belongs to the exact image revision. The browser can preview the mask before applying it with `image.remove_background`. Agents can choose returned instance IDs or ask Vision to select the foreground while applying the operation. Check fine hair, thin lines, and ambiguous edges against the original. [Apple Vision foreground masking](https://developer.apple.com/documentation/vision/vninstancemaskobservation/generatescaledmaskforimage%28forinstances%3Afrom%3A%29)

## Vector and animation

`vector.trace` takes an exact raster document revision and produces SVG paths with stable IDs. Flat color, monochrome, and outline modes form closed contours around connected regions, including holes. Color count, resolution, and minimum region area control complexity. Tracing simplifies pixel detail and is most suitable for graphic artwork. The result reports a normalized RGBA difference and opaque coverage change against the source preview.

Vector Studio opens solid-fill paths, simple SVG shapes, and transforms. The import parser rejects scripts, external resources, and unsupported features. Convert advanced SVG features such as gradients, embedded images, and unsupported path commands before importing. Agents can inspect and change individual paths, nodes, fills, strokes, transforms, groups, and stacking order. Export reparses the result and verifies that it renders with the same shape IDs. Vector and animation edits use immutable revisions with Undo and Redo.

Animation Studio supports up to 60 same-size frames, with individual durations, loop control, and a playback preview. Frames can come from workspace images, supported SVGs, or exact Studio revisions. `animation.tween` interpolates selected vector shapes between translation, rotation, and scale poses. Use `animation.export` for GIF or APNG and `animation.export_spritesheet` for PNG and frame-coordinate JSON. ImageIO reopens animated exports and verifies their format, dimensions, and frame count.

Model-backed reference edits, image inpainting, advanced SVG boolean geometry, mixed-media composition, and persistent character-reference profiles are outside these four delivered workflows.
