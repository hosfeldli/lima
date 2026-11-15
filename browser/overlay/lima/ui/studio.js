/* Screenshot Studio tab (spec v2 §9). Captures live in an in-memory tray and
 * never enter activity history; saving to a note stores an encrypted
 * attachment. OCR boxes arrive in image pixels and are drawn in the same
 * space, so Retina/mixed-DPI captures line up. */
import { bar, bridge, call, el, errorText, setPage } from "./lib.js";

export async function renderStudio(app) {
  setPage("Screenshot Studio", "studio");
  let current = null;
  let image = null;
  let tool = "rect";
  let shapes = [];
  let ocr = [];
  const tray = el("div", { class: "tray" });
  const canvas = el("canvas");
  const status = el("span", { class: "muted" });
  const ocrText = el("pre", { style: { whiteSpace: "pre-wrap", fontFamily: "var(--mono)", fontSize: "12px" }, hidden: true });
  const toolButton = (id, label) => el("button", { "data-tool": id, onclick: () => { tool = id; markTool(); } }, label);
  const tools = el("div", { class: "segmented", role: "group", "aria-label": "Markup tool" }, toolButton("rect", "Box"), toolButton("arrow", "Arrow"), toolButton("redact", "Redact"));

  app.replaceChildren(
    bar("Screenshot Studio",
      el("button", { class: "primary", onclick: () => capture("region") }, "Capture Region"),
      el("button", { onclick: () => capture("window") }, "Window"),
      el("button", { onclick: () => capture("display") }, "Display"),
      tools, status,
      el("button", { onclick: runOCR }, "Recognize Text"),
      el("button", { onclick: savePNG }, "Save PNG"),
      el("button", { onclick: saveToNote }, "Save to Note")),
    el("div", { class: "studio" }, tray, el("div", { class: "stage" }, el("span", { class: "tab" }, "Canvas"), canvas, ocrText))
  );

  function markTool() {
    for (const b of tools.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
  }
  markTool();

  async function capture(mode) {
    status.textContent = mode === "display" ? "Capturing…" : "Select on screen…";
    try {
      const record = await call("capture.take", { mode });
      status.textContent = `${record.width}×${record.height}`;
      await loadTray(record.id);
    } catch (error) {
      status.textContent = errorText(error);
    }
  }

  async function loadTray(selectId) {
    const items = await call("capture.list");
    tray.replaceChildren(el("span", { class: "tab" }, "Captures", items.length ? el("span", { class: "count", text: String(items.length) }) : ""), ...items.map(item => el("img", {
      src: `data:image/png;base64,${item.pngBase64}`, alt: "Capture", class: item.id === (selectId ?? current?.id) ? "active" : "",
      onclick: () => select(item),
    })));
    canvas.hidden = !items.length;
    if (!items.length) tray.append(el("p", { class: "muted", text: "No captures yet. Capture Region, Window or Display to start; captures stay here until you close Lima." }));
    const target = items.find(i => i.id === selectId) ?? (current ? items.find(i => i.id === current.id) : items[0]);
    if (target) select(target);
  }

  function select(item) {
    current = item;
    shapes = [];
    ocr = [];
    ocrText.hidden = true;
    for (const img of tray.querySelectorAll("img")) img.classList.toggle("active", img.src.endsWith(item.pngBase64.slice(-32)));
    image = new Image();
    image.onload = draw;
    image.src = `data:image/png;base64,${item.pngBase64}`;
  }

  function draw() {
    if (!image) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const scale = Math.max(1, image.naturalWidth / 1200);
    for (const s of shapes) {
      ctx.lineWidth = 3 * scale;
      if (s.type === "redact") {
        ctx.fillStyle = "#111";
        ctx.fillRect(s.x, s.y, s.w, s.h);
      } else if (s.type === "rect") {
        ctx.strokeStyle = "#ff4d6d";
        ctx.strokeRect(s.x, s.y, s.w, s.h);
      } else {
        ctx.strokeStyle = "#ff4d6d";
        ctx.fillStyle = "#ff4d6d";
        const x2 = s.x + s.w, y2 = s.y + s.h, angle = Math.atan2(s.h, s.w), head = 16 * scale;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(angle - 0.4), y2 - head * Math.sin(angle - 0.4));
        ctx.lineTo(x2 - head * Math.cos(angle + 0.4), y2 - head * Math.sin(angle + 0.4));
        ctx.fill();
      }
    }
    ctx.strokeStyle = "rgba(79,124,255,0.8)";
    ctx.lineWidth = Math.max(1, scale);
    for (const line of ocr) ctx.strokeRect(line.x, line.y, line.width, line.height);
  }

  // Pointer → image pixel coordinates (the canvas is CSS-scaled).
  const toImage = e => {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
  };
  canvas.addEventListener("pointerdown", e => {
    if (!image) return;
    const start = toImage(e);
    const shape = { type: tool, x: start.x, y: start.y, w: 0, h: 0 };
    shapes.push(shape);
    canvas.setPointerCapture(e.pointerId);
    const move = ev => { const p = toImage(ev); shape.w = p.x - start.x; shape.h = p.y - start.y; draw(); };
    const up = () => { canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); if (Math.abs(shape.w) + Math.abs(shape.h) < 4) shapes.pop(); draw(); };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
  });
  document.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); shapes.pop(); draw(); }
  });

  async function runOCR() {
    if (!current) return;
    status.textContent = "Recognizing…";
    try {
      ocr = await call("capture.ocr", { id: current.id });
      draw();
      const text = ocr.map(l => l.text).join("\n");
      ocrText.textContent = text || "(no text found)";
      ocrText.hidden = false;
      if (text) bridge.copy(text);
      status.textContent = text ? `${ocr.length} lines — copied` : "No text found";
    } catch (error) {
      status.textContent = errorText(error);
    }
  }

  function annotatedPNG() {
    return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  }

  async function savePNG() {
    if (!current) return;
    const blob = await annotatedPNG();
    const link = el("a", { href: URL.createObjectURL(blob), download: `Lima Screenshot ${new Date().toISOString().replace(/[:.]/g, "-")}.png` });
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function saveToNote() {
    if (!current) return;
    const blob = await annotatedPNG();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const { id } = await call("notes.attachment.put", { data: btoa(binary) });
    const caption = ocr.length ? `\n\n> ${ocr.map(l => l.text).join(" ").slice(0, 400)}` : "";
    const note = await bridge.browser("createNote", { kind: "classic", title: `Screenshot ${new Date().toLocaleString()}`, markdown: `![Screenshot](lima-attachment:${id})${caption}` });
    await call("capture.discard", { id: current.id });
    bridge.openTab(`about:lima?note=${encodeURIComponent(note.id)}`);
  }

  loadTray();
}
