/* Notes: index (organized by the bookmark tree), classic editor and canvas. */
import { bar, bridge, call, debounce, el, errorText, markdown, onEvent, relativeTime, setPage } from "./lib.js";

const attachmentCache = new Map();
function attachmentURL(id) {
  if (!attachmentCache.has(id)) {
    attachmentCache.set(id, call("notes.attachment.get", { id }).then(r => `data:image/png;base64,${r.data}`));
  }
  return attachmentCache.get(id);
}

// MARK: Index

export async function renderIndex(app) {
  setPage("Notes", "note");
  const body = el("div", { class: "page narrow" });
  const filter = el("input", { type: "search", placeholder: "Filter notes", style: { minWidth: "220px" } });
  app.replaceChildren(
    bar("Notes",
      filter,
      el("button", { onclick: () => createNote("classic") }, "New Note"),
      el("button", { onclick: () => createNote("canvas") }, "New Canvas"),
      el("button", { class: "ghost", onclick: newFolder }, "New Folder")),
    el("div", { class: "prism-rule" }),
    body
  );

  async function createNote(kind) {
    const note = await bridge.browser("createNote", { kind, title: kind === "canvas" ? "Untitled Canvas" : "Untitled" });
    bridge.openTab(`about:lima?note=${encodeURIComponent(note.id)}`);
  }

  async function newFolder() {
    const title = prompt("Folder name");
    if (title) { await bridge.browser("createFolder", { title }); load(); }
  }

  async function load() {
    try {
      const [tree, notes] = await Promise.all([bridge.browser("noteFolders"), call("notes.list")]);
      const byId = new Map(notes.map(n => [n.id, n]));
      const q = filter.value.trim().toLowerCase();
      const match = n => !q || n.title.toLowerCase().includes(q) || (byId.get(n.id)?.excerpt ?? "").toLowerCase().includes(q);
      const content = [];
      for (const folder of tree.folders) {
        const rows = folder.notes.filter(match);
        if (q && !rows.length) continue;
        const list = el("ul", { class: "list" });
        for (const entry of rows) {
          const summary = byId.get(entry.id);
          list.append(el("li", {
            class: "clickable", draggable: "true",
            ondragstart: e => e.dataTransfer.setData("text/lima-note", entry.id),
            onclick: () => bridge.openTab(`about:lima?note=${encodeURIComponent(entry.id)}`),
          },
            el("img", { src: "resource://lima-ui/icons/note.svg", width: 16, height: 16, alt: "" }),
            el("span", { class: "grow" }, el("strong", { text: entry.title || "Untitled" }), " ",
              el("span", { class: "muted", text: summary ? summary.excerpt.slice(0, 90) : "(content unavailable)" })),
            summary?.kind === "canvas" ? el("span", { class: "badge", text: "canvas" }) : null,
            summary ? el("span", { class: "muted", text: relativeTime(summary.modifiedAt) }) : null,
            el("button", { class: "ghost danger", title: "Move to trash", onclick: async e => {
              e.stopPropagation();
              await bridge.browser("trashNote", { noteId: entry.id });
              load();
            } }, "×")));
        }
        if (!rows.length) list.append(el("li", { class: "muted", text: "No notes. Drag a note here." }));
        content.push(el("section", {
          class: "folder",
          ondragover: e => e.preventDefault(),
          ondrop: async e => {
            const id = e.dataTransfer.getData("text/lima-note");
            if (id) { await bridge.browser("moveNote", { noteId: id, folderGuid: folder.guid }); load(); }
          },
        }, el("h3", {}, folder.title, folder.guid === tree.defaultGuid ? el("span", { class: "badge", text: "default" }) : null), list));
      }
      const trashed = notes.filter(n => n.trashed);
      if (trashed.length) {
        content.push(el("section", { class: "folder" }, el("h3", { text: "Trash" }), el("ul", { class: "list" },
          trashed.map(n => el("li", {},
            el("span", { class: "grow muted", text: n.title }),
            el("button", { onclick: async () => { await bridge.browser("restoreNote", { noteId: n.id }); load(); } }, "Restore"),
            el("button", { class: "danger", onclick: async () => {
              if (confirm(`Permanently delete “${n.title}”? This cannot be undone.`)) { await call("notes.purge", { id: n.id }); load(); }
            } }, "Delete forever"))))));
      }
      content.push(el("p", { class: "muted", text: "Notes are bookmarks: organize them in Zen's bookmarks like any page. Titles are stored in your browser profile; note content stays encrypted by Lima." }));
      body.replaceChildren(...content);
    } catch (error) {
      body.replaceChildren(el("p", { class: "error", text: errorText(error) }));
    }
  }

  filter.addEventListener("input", load);
  onEvent(m => { if (["notes.changed", "notes.deleted", "notes.bookmarks"].includes(m.event)) load(); });
  load();
}

// MARK: Note tab

export async function renderNote(app, id) {
  let note;
  try {
    note = await call("notes.get", { id });
  } catch (error) {
    setPage("Missing note", "note");
    app.replaceChildren(el("div", { class: "page narrow" }, el("p", { class: "error", text: `This note is not available: ${errorText(error)}` })));
    return;
  }
  if (note.kind === "canvas") return renderCanvas(app, note);
  return renderClassic(app, note);
}

function trashedNotice(note, rerender) {
  if (!note.trashedAt) return null;
  return el("div", { class: "notice warn" }, "This note is in the trash. ",
    el("button", { onclick: async () => { await bridge.browser("restoreNote", { noteId: note.id }); rerender(); } }, "Restore"));
}

async function renderClassic(app, note) {
  let dirty = false;
  let preview = false;
  const status = el("span", { class: "muted", text: "Saved" });
  const title = el("input", { class: "note-title", value: note.title, "aria-label": "Title" });
  const editor = el("textarea", { class: "note-editor", spellcheck: "true", "aria-label": "Note" });
  editor.value = note.markdown;
  const previewPane = el("div", { class: "note-preview", hidden: true });
  const body = el("div", { class: "note-body" }, editor, previewPane);
  const undoButton = el("button", { class: "ghost", title: "Undo (⌘Z)", onclick: () => history("notes.undo") }, "Undo");
  const redoButton = el("button", { class: "ghost", title: "Redo (⇧⌘Z)", onclick: () => history("notes.redo") }, "Redo");
  const previewButton = el("button", { onclick: () => { preview = !preview; renderPreview(); } }, "Preview");

  setPage(note.title || "Untitled", "note");
  app.replaceChildren(
    bar("", status, undoButton, redoButton, previewButton,
      el("button", { class: "ghost", onclick: () => bridge.openTab("about:lima?view=notes") }, "All notes")),
    trashedNotice(note, () => renderNote(app, note.id)) ?? "",
    el("div", { class: "note-layout" }, title, body)
  );

  function renderPreview() {
    previewPane.hidden = !preview;
    previewButton.textContent = preview ? "Hide preview" : "Preview";
    if (preview) previewPane.replaceChildren(markdown(editor.value, { onTaskToggle: toggleTask, attachments: attachmentURL }));
  }

  function toggleTask(line, checked) {
    const lines = editor.value.split("\n");
    lines[line] = lines[line].replace(/\[( |x|X)\]/, checked ? "[x]" : "[ ]");
    editor.value = lines.join("\n");
    dirty = true;
    save.flush();
  }

  const save = debounce(async () => {
    const edits = [];
    if (editor.value !== note.markdown) edits.push({ setMarkdown: { _0: editor.value } });
    if (title.value !== note.title) edits.push({ setTitle: { _0: title.value || "Untitled" } });
    if (!edits.length) { dirty = false; status.textContent = "Saved"; return; }
    status.textContent = "Saving…";
    try {
      note = await call("notes.apply", { id: note.id, edits, baseRevision: note.revision, author: "user" });
      dirty = editor.value !== note.markdown || title.value !== note.title;
      status.textContent = dirty ? "Saving…" : "Saved";
      setPage(note.title, "note");
      if (dirty) save();
    } catch (error) {
      if (/changed \(expected revision/.test(errorText(error))) {
        // Someone else (an agent, MCP client, another tab) edited it.
        const latest = await call("notes.get", { id: note.id });
        status.textContent = "Updated elsewhere — your unsaved text is kept below";
        note = latest;
        editor.value = `${latest.markdown}\n\n<!-- your unsaved edit -->\n${editor.value}`;
        dirty = true;
      } else status.textContent = `Not saved: ${errorText(error)}`;
    }
    if (preview) renderPreview();
  }, 450);

  async function history(method) {
    if (dirty) await save.flush();
    try {
      note = await call(method, { id: note.id, author: "user" });
      editor.value = note.markdown;
      title.value = note.title;
      status.textContent = method === "notes.undo" ? "Undone" : "Redone";
      if (preview) renderPreview();
    } catch (error) {
      status.textContent = errorText(error);
    }
  }

  editor.addEventListener("input", () => { dirty = true; status.textContent = "Editing…"; save(); });
  title.addEventListener("input", () => { dirty = true; save(); });
  // Undo goes through the service's transaction history, never a view's
  // own (possibly stale) editor state.
  document.addEventListener("keydown", e => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
    if (document.activeElement !== editor && document.activeElement !== title) return;
    e.preventDefault();
    history(e.shiftKey ? "notes.redo" : "notes.undo");
  });
  window.addEventListener("pagehide", () => { if (dirty) save.flush(); });

  onEvent(message => {
    if (message.event === "notes.changed" && message.data.id === note.id && message.data.revision > note.revision && !dirty) {
      note = message.data;
      if (editor.value !== note.markdown) editor.value = note.markdown;
      if (title.value !== note.title) title.value = note.title;
      setPage(note.title, "note");
      if (preview) renderPreview();
    }
  });
  if (!note.markdown) title.select();
}

// MARK: Canvas

async function renderCanvas(app, note) {
  let selected = null;
  let connectFrom = null;
  const status = el("span", { class: "muted", text: "" });
  const surface = el("div", { class: "canvas-surface" });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "canvas-svg");
  const wrap = el("div", { class: "canvas-wrap", tabindex: "0" }, surface);
  const title = el("input", { class: "note-title", value: note.title, style: { padding: "10px 16px 4px", fontSize: "18px" } });

  setPage(note.title || "Untitled Canvas", "note");
  app.replaceChildren(
    bar("",
      el("button", { onclick: () => add("text") }, "+ Text"),
      el("button", { onclick: () => add("code") }, "+ Code"),
      el("button", { onclick: () => add("flow") }, "+ Node"),
      el("button", { onclick: () => { connectFrom = selected; status.textContent = selected ? "Click another block to connect" : "Select a block first"; } }, "Connect"),
      el("button", { onclick: diagram }, "Diagram from text"),
      el("button", { onclick: cleanup }, "Clean up layout"),
      status,
      el("button", { class: "ghost", onclick: () => history("notes.undo") }, "Undo"),
      el("button", { class: "ghost", onclick: () => history("notes.redo") }, "Redo")),
    trashedNotice(note, () => renderNote(app, note.id)) ?? "",
    title,
    wrap
  );

  async function apply(edits, label) {
    if (!edits.length) return;
    try {
      note = await call("notes.apply", { id: note.id, edits, author: "user" });
      status.textContent = label ?? "";
      draw();
    } catch (error) {
      status.textContent = errorText(error);
    }
  }

  async function history(method) {
    try { note = await call(method, { id: note.id, author: "user" }); draw(); status.textContent = ""; }
    catch (error) { status.textContent = errorText(error); }
  }

  function nextPosition() {
    const bottom = note.blocks.reduce((max, b) => Math.max(max, b.y + b.height), 0);
    return { x: 48 + wrap.scrollLeft, y: Math.max(48, bottom + 24) };
  }

  function add(type) {
    const { x, y } = nextPosition();
    const block = {
      id: crypto.randomUUID(), type, x, y, width: type === "flow" ? 200 : 260, height: type === "flow" ? 72 : 140, z: note.blocks.length,
      content: type === "code" ? "// code" : type === "flow" ? "Step" : "Text",
    };
    apply([{ addBlock: { _0: block } }]);
  }

  async function diagram() {
    const spec = prompt("Describe the flow, one chain per line (e.g. Idea -> Plan -> Ship)");
    if (!spec) return;
    const edits = await call("notes.generateDiagram", { id: note.id, spec });
    apply(edits, `Added ${edits.filter(e => e.addBlock).length} nodes`);
  }

  async function cleanup() {
    const report = await call("notes.cleanupLayout", { id: note.id });
    const summary = `${report.overlaps.length} overlaps, ${report.duplicates.length} duplicates, ${report.misaligned.length} off-grid, ${report.disconnected.length} disconnected`;
    if (!report.edits.length) { status.textContent = `Layout is clean (${summary})`; return; }
    if (confirm(`Clean up: ${summary}.\nMove ${report.edits.length} blocks? (Undo restores the layout.)`)) apply(report.edits, "Cleaned up");
  }

  function draw() {
    surface.replaceChildren(svg);
    svg.replaceChildren();
    const byId = new Map(note.blocks.map(b => [b.id, b]));
    for (const c of note.connections) {
      const a = byId.get(c.from), b = byId.get(c.to);
      if (!a || !b) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", a.x + a.width / 2); line.setAttribute("y1", a.y + a.height / 2);
      line.setAttribute("x2", b.x + b.width / 2); line.setAttribute("y2", b.y + b.height / 2);
      line.setAttribute("stroke", "currentColor"); line.setAttribute("stroke-opacity", "0.45"); line.setAttribute("stroke-width", "2");
      svg.append(line);
      if (c.label) {
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", (a.x + b.x + a.width / 2 + b.width / 2) / 2);
        text.setAttribute("y", (a.y + b.y + a.height / 2 + b.height / 2) / 2 - 6);
        text.setAttribute("fill", "currentColor"); text.setAttribute("font-size", "12"); text.setAttribute("text-anchor", "middle");
        text.textContent = c.label;
        svg.append(text);
      }
    }
    for (const block of [...note.blocks].sort((a, b) => a.z - b.z)) surface.append(blockNode(block));
  }

  function blockNode(block) {
    const node = el("div", {
      class: `block ${block.type}${selected === block.id ? " selected" : ""}`,
      style: { left: `${block.x}px`, top: `${block.y}px`, width: `${block.width}px`, height: `${block.height}px` },
      tabindex: "0",
    });
    if (block.type === "image") {
      const img = el("img", { alt: "" });
      attachmentURL(block.content).then(url => { img.src = url; });
      node.append(img);
    } else if (block.type === "text") {
      node.append(markdown(block.content));
    } else {
      node.textContent = block.content;
    }
    const handle = el("div", { class: "resize" });
    node.append(handle);

    node.addEventListener("pointerdown", event => {
      if (node.isContentEditable) return;
      if (connectFrom && connectFrom !== block.id) {
        apply([{ connect: { _0: { id: crypto.randomUUID(), from: connectFrom, to: block.id } } }], "Connected");
        connectFrom = null;
        return;
      }
      selected = block.id;
      for (const other of surface.querySelectorAll(".block.selected")) other.classList.remove("selected");
      node.classList.add("selected");
      const resizing = event.target === handle;
      const start = { x: event.clientX, y: event.clientY, bx: block.x, by: block.y, bw: block.width, bh: block.height };
      node.setPointerCapture(event.pointerId);
      const move = e => {
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (resizing) { node.style.width = `${Math.max(40, start.bw + dx)}px`; node.style.height = `${Math.max(30, start.bh + dy)}px`; }
        else { node.style.left = `${Math.max(0, start.bx + dx)}px`; node.style.top = `${Math.max(0, start.by + dy)}px`; }
      };
      const up = e => {
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) < 2) return;
        const x = resizing ? block.x : Math.max(0, start.bx + dx), y = resizing ? block.y : Math.max(0, start.by + dy);
        const w = resizing ? Math.max(40, start.bw + dx) : block.width, h = resizing ? Math.max(30, start.bh + dy) : block.height;
        apply([{ moveBlock: { id: block.id, x, y, width: w, height: h } }]);
      };
      node.addEventListener("pointermove", move);
      node.addEventListener("pointerup", up);
    });
    node.addEventListener("dblclick", () => {
      if (block.type === "image") return;
      node.contentEditable = "true";
      node.textContent = block.content;
      node.focus();
      node.addEventListener("blur", () => {
        node.contentEditable = "false";
        const content = node.innerText;
        if (content !== block.content) apply([{ updateBlockContent: { id: block.id, content } }]);
        else draw();
      }, { once: true });
    });
    return node;
  }

  wrap.addEventListener("keydown", e => {
    if (document.activeElement?.isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); history(e.shiftKey ? "notes.redo" : "notes.undo"); }
    if ((e.key === "Backspace" || e.key === "Delete") && selected) { e.preventDefault(); apply([{ removeBlock: { id: selected } }], "Deleted"); selected = null; }
  });
  const saveTitle = debounce(() => apply([{ setTitle: { _0: title.value || "Untitled Canvas" } }]), 500);
  title.addEventListener("input", saveTitle);
  onEvent(message => {
    if (message.event === "notes.changed" && message.data.id === note.id && message.data.revision > note.revision) {
      note = message.data;
      setPage(note.title, "note");
      if (document.activeElement !== title) title.value = note.title;
      if (!document.activeElement?.isContentEditable) draw();
    }
  });
  draw();
}
