import { bridge, call, el, errorText, setPage } from "./lib.js";

export const imageGenerationSettingsURL = "about:lima?view=integrations&section=image-generation";
export function studioURL(workspace, kind, id = "new") {
  const field = { vector: "vectorDocument", animation: "animationDocument" }[kind];
  return `about:lima?view=image&imageWorkspace=${encodeURIComponent(workspace)}&${field}=${encodeURIComponent(id)}`;
}

export function generationSettings() {
  const port = numberInput(8188, 1024, 65535);
  const steps = numberInput(24, 1, 60);
  const checkpoint = el("input", { list: "lima-image-models", placeholder: "model.safetensors", "aria-label": "Checkpoint" });
  const models = el("datalist", { id: "lima-image-models" });
  const agents = el("input", { type: "checkbox" });
  const status = el("p", { role: "status" });
  const form = el("form", { class: "image-settings-form" },
    el("p", { class: "muted", text: "Run ComfyUI with a compatible Stable Diffusion checkpoint on this Mac. Lima sends generation prompts to its localhost API." }),
    field("Local server port", port), field("Sampling steps", steps), field("Default checkpoint", checkpoint), models,
    el("label", { class: "row" }, agents, "Allow workspace agents to generate images"),
    el("div", { class: "row" },
      el("button", { class: "primary", type: "submit" }, "Save"),
      el("button", { type: "button", onclick: async () => {
        status.textContent = "Checking local ComfyUI…";
        try {
          const options = await call("image.generation_models", { port: port.valueAsNumber });
          models.replaceChildren(...options.map(value => el("option", { value })));
          if (!checkpoint.value && options.length) checkpoint.value = options[0];
          status.textContent = options.length ? `Found ${options.length} installed checkpoints.` : "No compatible checkpoints appeared.";
        } catch (error) { status.textContent = errorText(error); }
      } }, "Check connection")), status);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const result = await call("image.generation_config", { port: port.valueAsNumber, checkpoint: checkpoint.value,
        steps: steps.valueAsNumber, allow_agents: agents.checked });
      status.textContent = result.configured ? "Image generation settings saved." : "Image generation disabled until you choose a checkpoint.";
    } catch (error) { status.textContent = errorText(error); }
  });
  call("image.generation_config").then(data => {
    port.value = data.port;
    steps.value = data.steps;
    checkpoint.value = data.checkpoint;
    agents.checked = data.allow_agents;
  }).catch(error => { status.textContent = errorText(error); });
  return form;
}

export async function watchGeneration(workspace, operation, progress, signal) {
  while (!signal?.aborted) {
    const job = await call("image.generation_status", { workspace_id: workspace, operation_id: operation });
    if (signal?.aborted) return null;
    progress(job);
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  return null;
}

function field(label, input) { return el("label", {}, label, input); }
function numberInput(value, min, max, step = 1) { return el("input", { type: "number", value, min, max, step, required: true }); }
function textInput(value = "", placeholder = "") { return el("input", { type: "text", value, placeholder, required: true }); }
function choice(values, label) {
  return el("select", { "aria-label": label }, values.map(([value, text]) => el("option", { value, text })));
}

function surface(app, workspace, kind, action) {
  const title = kind === "vector" ? "Vector Studio" : "Animation Studio";
  setPage(title, "image");
  const status = el("p", { role: "status", class: "image-studio-status" });
  const caption = el("p", { class: "muted image-studio-caption" });
  const art = el("img", { class: "image-fit", alt: kind === "vector" ? "Vector preview" : "Animation preview", hidden: true });
  const preview = el("div", { class: "image-studio-canvas", tabindex: "0", "aria-label": "Studio preview" }, art);
  const strip = el("div", { class: "studio-control-strip" });
  const form = el("form", { class: "image-studio-settings", hidden: true });
  const special = el("div", { class: "image-studio-toolbar" });
  const controls = el("div", { class: "image-studio-toolbar" });
  let busy = false;
  const toolbar = el("div", { class: "image-studio-toolbar" },
    el("button", { onclick: () => bridge.openTab(`about:lima?view=image&imageWorkspace=${encodeURIComponent(workspace)}`) }, "Raster"),
    el("button", { onclick: () => bridge.openTab(studioURL(workspace, kind === "vector" ? "animation" : "vector")) },
      kind === "vector" ? "Animation" : "Vector"));
  app.replaceChildren(el("div", { class: "image-studio" },
    el("header", { class: "image-studio-header" }, el("h1", { text: title }), toolbar, special, controls, form),
    preview, strip, el("footer", {}, caption, status)));

  const button = (label, invoke, area = controls) => {
    const node = el("button", { type: "button", class: "ghost", onclick: () => { if (!busy) invoke(); } }, label);
    area.append(node);
    return node;
  };
  const run = async operation => {
    if (busy) return;
    busy = true;
    status.textContent = "Working…";
    preview.setAttribute("aria-busy", "true");
    try {
      await operation();
      if (status.textContent === "Working…") status.textContent = "";
    } catch (error) { status.textContent = errorText(error); }
    finally { busy = false; preview.setAttribute("aria-busy", "false"); }
  };
  const configure = (label, fields, submit) => {
    form.replaceChildren(...fields, el("button", { class: "primary", type: "submit" }, label),
      el("button", { type: "button", class: "ghost", onclick: () => { form.hidden = true; } }, "Cancel"));
    form.hidden = false;
    form.onsubmit = event => {
      event.preventDefault();
      run(async () => { await submit(); form.hidden = true; });
    };
    form.querySelector("input,select,textarea")?.focus();
  };
  const paint = png => {
    art.hidden = !png;
    if (png) art.src = "data:image/png;base64," + png;
    else art.removeAttribute("src");
  };
  action({ status, caption, art, strip, controls, special, configure, button, paint, run });
}

export function renderStudioVector(app, workspace, document) {
  surface(app, workspace, "vector", ui => {
    const request = (method, payload = {}) => call("vector." + method, { workspace_id: workspace, ...payload });
    const shapes = el("select", { "aria-label": "Vector object" });
    let current;
    const revise = () => ({ document_id: current.document_id, source_revision: current.revision_id, idempotency_key: crypto.randomUUID() });
    async function load(id, { selected = shapes.value } = {}) {
      current = await request("render", { document_id: id });
      shapes.replaceChildren(...current.shapes.map(shape => el("option", { value: shape.id, text: `${shape.id} · ${shape.fill}` })));
      if (current.shapes.some(shape => shape.id === selected)) shapes.value = selected;
      ui.controls.hidden = false;
      ui.paint(current.preview);
      ui.caption.textContent = `${current.shape_count} editable paths · ${current.dimensions.width} × ${current.dimensions.height}`;
      undo.disabled = !current.can_undo;
      redo.disabled = !current.can_redo;
    }
    async function update(method, parameters) {
      await request(method, { ...revise(), target_ids: [shapes.value], parameters });
      await load(current.document_id);
    }
    ui.controls.hidden = true;
    ui.controls.append(shapes);
    ui.button("Open SVG", () => {
      const path = textInput("", "assets/icon.svg");
      ui.configure("Open SVG", [field("Workspace SVG path", path)], async () => {
        const result = await request("open", { path: path.value, show_in_workspace: true });
        await load(result.document_id);
      });
    }, ui.special);
    ui.button("Fill & stroke", () => {
      const shape = current.shapes.find(item => item.id === shapes.value);
      const fill = textInput(shape.fill), stroke = textInput(shape.stroke), width = numberInput(shape.stroke_width, 0, 1000, 0.1);
      ui.configure("Apply style", [field("Fill hex or none", fill), field("Stroke hex or none", stroke), field("Stroke width", width)],
        () => update("set_style", { fill: fill.value, stroke: stroke.value, width: width.valueAsNumber }));
    });
    ui.button("Path", () => ui.run(async () => {
      const shape = await request("get_path", { document_id: current.document_id, shape_id: shapes.value });
      const source = shape.segments.map(segment => segment.command + segment.points.join(" ")).join(" ");
      const data = el("textarea", { rows: 4, required: true });
      data.value = source;
      ui.configure("Update path", [field("SVG path commands", data)], () => update("set_path", { path: data.value }));
    }));
    ui.button("Move", () => {
      const x = numberInput(0, -100000, 100000, 0.1), y = numberInput(0, -100000, 100000, 0.1);
      ui.configure("Move shape", [field("X", x), field("Y", y)], () => update("move", { x: x.valueAsNumber, y: y.valueAsNumber }));
    });
    const undo = ui.button("Undo", () => ui.run(() => update("undo")));
    const redo = ui.button("Redo", () => ui.run(() => update("redo")));
    ui.button("Export SVG", () => {
      const name = textInput("artwork.svg");
      ui.configure("Export SVG", [field("Workspace export path", name)], async () => {
        const result = await request("export", { ...revise(), output_name: name.value });
        ui.status.textContent = `Exported ${result.artifact_ids[0]}`;
      });
    });
    const params = new URLSearchParams(location.search);
    ui.run(async () => {
      const last = document === "new" ? await request("recent") : document;
      if (last) await load(last, { selected: params.get("shape") });
    });
  });
}

export function renderStudioAnimation(app, workspace, document) {
  surface(app, workspace, "animation", ui => {
    const request = (method, payload = {}) => call("animation." + method, { workspace_id: workspace, ...payload });
    const frames = el("select", { "aria-label": "Timeline frame" });
    let current;
    const revise = () => ({ document_id: current.document_id, source_revision: current.revision_id, idempotency_key: crypto.randomUUID() });
    function paint(timeline) {
      current = timeline;
      ui.controls.hidden = false;
      const selected = frames.value;
      frames.replaceChildren(...timeline.frames.map(({ id, duration_ms }, index) =>
        el("option", { value: id, text: `Frame ${index + 1} · ${duration_ms} ms` })));
      if (timeline.frames.some(f => f.id === selected)) frames.value = selected;
      frames.hidden = !timeline.frames.length;
      frames.disabled = !timeline.frames.length;
      ui.caption.textContent = `${timeline.frames.length} frames · ${timeline.frames.reduce((total, frame) => total + frame.duration_ms, 0)} ms`;
      ui.paint(null);
      play.textContent = "Play preview";
      undo.disabled = !timeline.can_undo;
      redo.disabled = !timeline.can_redo;
      for (const control of [play, timing, duplicate, remove, exportButton]) control.disabled = !timeline.frames.length;
      loop.textContent = timeline.loop ? "Loop on" : "Loop off";
      loop.setAttribute("aria-pressed", String(timeline.loop));
    }
    async function update(method, parameters = {}) {
      const result = await request(method, { ...revise(), ...parameters });
      paint(result);
    }
    ui.strip.append(frames);
    ui.controls.hidden = true;
    ui.button("New timeline", () => ui.run(async () => paint(await request("create", { show_in_workspace: true }))), ui.special);
    ui.button("Add frame", () => {
      const path = textInput("", "assets/frame-01.png");
      const duration = numberInput(150, 20, 10000);
      ui.configure("Add frame", [field("Workspace image or SVG", path), field("Duration in ms", duration)], () =>
        update("add_frame", { path: path.value, duration_ms: duration.valueAsNumber }));
    });
    ui.button("Tween shape", () => ui.run(async () => {
      const vectorID = await call("vector.recent", { workspace_id: workspace });
      if (!vectorID) throw new Error("Open or trace a vector in this workspace first.");
      const vector = await call("vector.inspect", { workspace_id: workspace, document_id: vectorID });
      const shape = choice(vector.shapes.map(item => [item.id, item.id]), "Shape to animate");
      const x = numberInput(12, -10000, 10000, 0.1), y = numberInput(0, -10000, 10000, 0.1);
      const degrees = numberInput(0, -360, 360, 0.1), scale = numberInput(1, 0.01, 10, 0.01);
      const count = numberInput(6, 2, 24), duration = numberInput(100, 20, 10000);
      ui.configure("Add tween", [field("Shape", shape), field("Move X", x), field("Move Y", y), field("Rotate", degrees),
        field("Scale", scale), field("Frames", count), field("Duration per frame in ms", duration)], () => update("tween", {
          vector_document_id: vectorID, vector_revision: vector.revision_id, frame_count: count.valueAsNumber, duration_ms: duration.valueAsNumber,
          poses: [{ shape_id: shape.value, from: [0, 0, 0, 1], to: [x.valueAsNumber, y.valueAsNumber, degrees.valueAsNumber, scale.valueAsNumber] }],
      }));
    }));
    const timing = ui.button("Timing", () => {
      const frame = current.frames.find(item => item.id === frames.value);
      const duration = numberInput(frame.duration_ms, 20, 10000);
      ui.configure("Set duration", [field("Duration in ms", duration)], () => update("set_duration", { frame_id: frame.id, duration_ms: duration.valueAsNumber }));
    });
    const duplicate = ui.button("Duplicate", () => ui.run(() => update("duplicate_frame", { frame_id: frames.value })));
    const remove = ui.button("Remove", () => ui.run(() => update("remove_frame", { frame_id: frames.value })));
    const loop = ui.button("Loop on", () => ui.run(() => update("set_loop", { loop: !current.loop })));
    const undo = ui.button("Undo", () => ui.run(() => update("undo")));
    const redo = ui.button("Redo", () => ui.run(() => update("redo")));
    const play = ui.button("Play preview", () => ui.run(async () => {
      if (!ui.art.hidden) { ui.paint(null); play.textContent = "Play preview"; return; }
      const result = await request("render_preview", { document_id: current.document_id });
      ui.paint(result.preview);
      play.textContent = "Stop preview";
    }));
    const exportButton = ui.button("Export", () => {
      const kind = choice([["gif", "Animated GIF"], ["apng", "Animated PNG"], ["png", "Spritesheet + JSON"]], "Export format");
      const name = textInput("animation.gif");
      kind.onchange = () => { name.value = name.value.replace(/\.[^.]+$/, "") + "." + kind.value; };
      ui.configure("Export", [field("Format", kind), field("Workspace export path", name)], async () => {
        const method = kind.value === "png" ? "export_spritesheet" : "export";
        const result = await request(method, { ...revise(), output_name: name.value, format: kind.value });
        ui.status.textContent = `Exported ${result.artifact_ids.join(", ")}`;
      });
    });
    ui.run(async () => {
      const last = document === "new" ? await request("recent") : document;
      if (last) paint(await request("inspect", { document_id: last }));
    });
  });
}
