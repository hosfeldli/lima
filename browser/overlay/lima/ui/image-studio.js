import { bridge, call, el, errorText, onEvent, setPage } from "./lib.js";
import { imageGenerationSettingsURL, studioURL, watchGeneration } from "./studio-production.js";

export function renderImageStudio(app, workspace, documentID) {
  setPage("Image Studio", "image");
  if (!workspace) {
    app.replaceChildren(el("p", { class: "empty", text: "Open Image Studio from a workspace’s sidebar menu." }));
    return;
  }
  const request = (operation, data = {}) => call("image." + operation, { workspace_id: workspace, ...data });
  let current, original, selection, comparing = false, busy = false, zoom = "fit";
  const lifetime = new AbortController();
  const path = el("input", { type: "text", placeholder: "assets/example.png", "aria-label": "Workspace image path", required: true });
  const notice = el("p", { class: "image-studio-status", role: "status" });
  const art = el("img", { alt: "Image preview", hidden: true, draggable: "false" });
  const canvas = el("div", { class: "image-studio-canvas", tabindex: "0", "aria-label": "Image canvas" }, art);
  const caption = el("p", { class: "muted image-studio-caption" });
  const settings = el("form", { class: "image-studio-settings", hidden: true });
  const toolbar = el("div", { class: "image-studio-toolbar", role: "toolbar", "aria-label": "Image editing" });
  const open = el("form", { class: "image-studio-open", onsubmit: event => {
    event.preventDefault();
    run(async () => {
      const doc = await request("open", { path: path.value, show_in_workspace: true });
      original = undefined;
      await load(doc.document_id);
    });
  } }, path, el("button", { class: "primary", type: "submit" }, "Open image"));
  const buttons = [];
  const needsImage = new Set();
  const button = (label, action, requiresImage = true) => {
    const control = el("button", { type: "button", class: "ghost", onclick: action }, label);
    buttons.push(control);
    if (requiresImage) needsImage.add(control);
    toolbar.append(control);
    return control;
  };
  const dropdown = (items, label) => el("select", { "aria-label": label },
    items.map(([value, label]) => el("option", { value, text: label })));
  const zoomMenu = dropdown([["fit", "Fit"], ["100", "100%"], ["150", "150%"], ["200", "200%"]], "Zoom");
  zoomMenu.onchange = () => { zoom = zoomMenu.value; applyZoom(); };
  const backplate = dropdown([["checker", "Checkerboard"], ["white", "White"], ["black", "Black"]], "Preview background");
  backplate.onchange = () => { canvas.dataset.background = backplate.value; };
  toolbar.append(zoomMenu, backplate);
  button("Generate", () => run(async () => {
    const config = await request("generation_config");
    if (!config.configured) {
      notice.replaceChildren("Choose a local checkpoint in ", el("button", { onclick: () => bridge.openTab(imageGenerationSettingsURL) }, "Image Generation Settings"));
      return;
    }
    const prompt = el("textarea", { rows: 3, maxlength: 4000, required: true });
    const name = el("input", { type: "text", value: "generated.png", required: true });
    const fields = [
      ["Prompt", prompt, "prompt", field => field.value],
      number("Width", "width", 768, { min: 256, max: 1536, step: 8 }),
      number("Height", "height", 768, { min: 256, max: 1536, step: 8 }),
      number("Variations", "count", 1, { min: 1, max: 4 }),
      ["Workspace export path", name, "output_name", field => field.value],
    ];
    edit("generate", fields, "Generate image");
  }), false);
  button("Vector", () => bridge.openTab(studioURL(workspace, "vector")), false);
  button("Animation", () => bridge.openTab(studioURL(workspace, "animation")), false);

  function edit(operation, fields, label) {
    settings.hidden = false;
    settings.replaceChildren(...fields.map(([label, input]) => el("label", {}, label, input)),
      el("button", { class: "primary", type: "submit" }, label),
      el("button", { class: "ghost", type: "button", onclick: () => { settings.hidden = true; } }, "Cancel"));
    settings.onsubmit = event => {
      event.preventDefault();
      const values = Object.fromEntries(fields.map(([, field, name, convert]) => [name, convert(field)]));
      if (operation === "generate") {
        run(async () => {
          const job = await request("generate", { ...values, idempotency_key: crypto.randomUUID(), show_in_workspace: true });
          settings.hidden = true;
          await followGeneration(job.operation_id);
        });
      } else if (operation === "trace") {
        run(async () => {
          const result = await call("vector.trace", { workspace_id: workspace, ...revision(), parameters: values, show_in_workspace: true });
          settings.hidden = true;
          notice.replaceChildren(`${result.shape_count} editable paths. `, ...(result.warnings ?? []), " ",
            el("button", { onclick: () => bridge.openTab(result.studio_url) }, "Open Vector Studio"));
        });
      } else if (operation === "export") {
        const { filename, ...parameters } = values;
        run(async () => {
          const saved = await request("export", { ...revision(), output_name: filename, parameters });
          settings.hidden = true;
          notice.textContent = [`Exported ${saved.artifact_ids[0]}`, ...saved.warnings].join(" · ");
        });
      } else finish(operation, values);
    };
    fields[0][1].focus();
  }

  const number = (label, name, value, { min = 0, max = 8192, step = 1 } = {}) =>
    [label, el("input", { type: "number", value, min, max, step, required: true }), name, field => field.valueAsNumber];
  const color = el("input", { type: "color", value: "#ffffff", "aria-label": "Background color" });
  const connected = el("input", { type: "checkbox" });
  button("Crop", () => edit("crop", [
    number("Left", "x", 0), number("Top", "y", 0),
    number("Width", "width", current.dimensions.width, { min: 1 }),
    number("Height", "height", current.dimensions.height, { min: 1 }),
  ], "Apply crop"));
  button("Resize", () => edit("resize", [
    number("Width", "width", current.dimensions.width, { min: 1 }),
    number("Height", "height", current.dimensions.height, { min: 1 }),
    ["Fit mode", dropdown([["contain", "Contain"], ["cover", "Cover"], ["stretch", "Stretch"], ["pad", "Pad"]], "Fit mode"), "mode", field => field.value],
  ], "Apply resize"));
  button("Rotate", () => edit("rotate", [number("Clockwise degrees", "degrees", 90, { min: -360, max: 360, step: 0.1 })], "Apply rotation"));
  button("Trim", () => finish("trim"));
  button("Background", () => {
    connected.checked = true;
    edit("color_key", [
      ["Color to remove", color, "target_colors", field => [field.value]],
      number("Tolerance", "tolerance", 8, { max: 100, step: 1 }),
      number("Softness", "softness", 3, { max: 50, step: 1 }),
      ["Only connected edges", connected, "connected_only", field => field.checked],
    ], "Remove color");
  });
  button("Mask", () => edit("mask", [
    ["Workspace mask path", el("input", { type: "text", placeholder: "assets/mask.png", required: true }), "path", field => field.value],
    ["Mask channel", dropdown([["luminance", "Luminance"], ["alpha", "Alpha"]], "Mask channel"), "channel", field => field.value],
  ], "Apply mask"));
  button("Select subject", () => run(async () => {
    selection = await request("select_subject", { document_id: current.document_id, source_revision: current.revision_id });
    comparing = false;
    paint();
    notice.replaceChildren("Foreground mask ready. ", el("button", { onclick: () => finish("remove_background", { selection_id: selection.selection_id }) }, "Apply selection"),
      el("button", { onclick: () => { selection = undefined; paint(); notice.textContent = ""; } }, "Discard"));
  }));
  button("Trace SVG", () => edit("trace", [
    ["Trace style", dropdown([["flat_color", "Flat color"], ["monochrome", "Monochrome"], ["outline", "Outline"]], "Trace style"), "mode", field => field.value],
    number("Max colors", "colors", 6, { min: 1, max: 16 }),
    number("Tracing resolution", "max_edge", 256, { min: 32, max: 512 }),
    number("Minimum area", "minimum_area", 2, { min: 1, max: 1000 }),
  ], "Trace paths"));
  const undo = button("Undo", () => finish("undo"));
  const redo = button("Redo", () => finish("redo"));
  const compare = button("Compare", () => run(async () => {
    selection = undefined;
    if (!original) {
      const history = await request("history", { document_id: current.document_id });
      original = await request("preview", { document_id: current.document_id, source_revision: history.revisions[0].id });
    }
    comparing = !comparing;
    paint();
  }));
  compare.setAttribute("aria-pressed", "false");
  button("Export", () => {
    const name = current.source_path.split("/").at(-1).replace(/\.[^.]+$/, "");
    const format = dropdown([["png", "PNG"], ["jpeg", "JPEG"], ["tiff", "TIFF"]], "Export format");
    const filename = el("input", { type: "text", value: name + "-edited.png", required: true });
    format.onchange = () => { filename.value = filename.value.replace(/\.[^.]+$/, "") + "." + format.value; };
    edit("export", [
      ["Filename", filename, "filename", field => field.value],
      ["Format", format, "format", field => field.value],
    ], "Export image");
  });

  function revision() {
    return { document_id: current.document_id, source_revision: current.revision_id, idempotency_key: crypto.randomUUID() };
  }
  function finish(operation, parameters = {}) {
    return run(async () => {
      const next = await request(operation, { ...revision(), parameters });
      settings.hidden = true;
      await load(next.document_id);
    });
  }
  async function load(id) {
    current = await request("preview", { document_id: id });
    comparing = false;
    selection = undefined;
    setPage(current.source_path.split("/").at(-1) || "Image Studio", "image");
    paint();
  }
  function applyZoom() {
    const display = comparing ? original : current;
    if (!display) return;
    art.classList.toggle("image-fit", zoom === "fit");
    art.style.width = zoom === "fit" ? "" : (display.dimensions.width * Number(zoom) / 100) + "px";
  }
  function paint() {
    if (!current) return;
    const display = comparing ? original : current;
    art.hidden = false;
    art.src = "data:image/png;base64," + (selection?.preview ?? display.preview);
    caption.textContent = [
      display.source_path, `${display.dimensions.width} × ${display.dimensions.height}`,
      selection ? "Estimated foreground mask" : comparing ? "Original" : "Working revision", !selection && display.transparent ? "Transparency" : "",
    ].filter(Boolean).join(" · ");
    compare.setAttribute("aria-pressed", String(comparing));
    applyZoom();
  }
  function updateControls() {
    for (const control of [...buttons, ...open.querySelectorAll("button, input"), ...settings.querySelectorAll("button, input, select")]) {
      control.disabled = busy || (!current && needsImage.has(control));
    }
    undo.disabled ||= !current?.can_undo;
    redo.disabled ||= !current?.can_redo;
    canvas.setAttribute("aria-busy", String(busy));
  }

  async function followGeneration(id) {
    let phase;
    const cancel = el("button", { onclick: () => request("generation_cancel", { operation_id: id }).catch(error => { notice.textContent = errorText(error); }) }, "Stop import");
    const job = await watchGeneration(workspace, id, record => {
      if (record.status === phase) return;
      phase = record.status;
      if (phase === "running" || phase === "queued") notice.replaceChildren(phase === "running" ? "Generating image… " : "Waiting for the local provider… ", cancel);
    }, lifetime.signal);
    if (!job) return;
    if (job.status !== "completed") throw new Error([job.error || "Generation stopped.", job.artifact_ids.join(", ")].filter(Boolean).join(" "));
    original = undefined;
    await load(job.documents[0].document_id);
    notice.replaceChildren("Generated ", job.artifact_ids.join(", "), ...job.documents.slice(1).map((document, index) =>
      el("button", { onclick: () => bridge.openTab(document.studio_url) }, `Open variation ${index + 2}`)));
  }
  async function run(operation) {
    if (busy) return;
    busy = true;
    notice.textContent = "Processing image…";
    updateControls();
    try {
      await operation();
      if (notice.textContent === "Processing image…") notice.textContent = "";
    } catch (error) {
      notice.textContent = errorText(error);
    } finally { busy = false; updateControls(); }
  }

  app.replaceChildren(el("div", { class: "image-studio" },
    el("header", { class: "image-studio-header" }, el("h1", { text: "Image Studio" }), open, toolbar, settings),
    canvas, el("footer", {}, caption, notice)));
  updateControls();
  run(async () => {
    if (documentID) { await load(documentID); return; }
    const [last, job] = await Promise.all([request("recent"), request("generation_latest")]);
    if (job && ["queued", "running"].includes(job.status)) await followGeneration(job.operation_id);
    else if (last) await load(last);
  });
  const unsubscribe = onEvent(({ event, data }) => {
    if (event === "image.changed" && data.workspace_id === workspace && data.document_id === current?.document_id &&
        !busy && data.revision_id !== current.revision_id) run(() => load(data.document_id));
  });
  window.addEventListener("pagehide", () => { lifetime.abort(); unsubscribe(); }, { once: true });
}
