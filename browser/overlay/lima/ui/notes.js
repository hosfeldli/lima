/* Notes: index (organized by the bookmark tree), classic editor and canvas. */
import { bar, bridge, call, debounce, el, errorText, hydrateEmbeds, icon, installEmbedActions, markdown, noteEmbed, onEvent, relativeTime, setPage } from "./lib.js";
import { artifactFromBlock, CALCULATOR_TEMPLATE, noteScope, valueChip, wireValues } from "./rich-content.js";

installEmbedActions();

const attachmentCache = new Map();
function attachmentURL(id) {
  if (!attachmentCache.has(id)) {
    attachmentCache.set(id, call("notes.attachment.get", { id }).then(r => `data:image/png;base64,${r.data}`));
  }
  return attachmentCache.get(id);
}

// MARK: Index

/** Excerpt without Markdown syntax. */
const plain = text => String(text).split(/\n+/).map(line => line.replace(/[#*_`>~]|\[( |x)\]|^\s*[-+]\s/g, "").trim()).filter(Boolean).join(" · ");

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
      // Full text: notes whose content matches, from Lima's search index.
      const found = q ? new Set((await call("search.query", { query: q, limit: 200 }).catch(() => ({ results: [] }))).results
        .filter(result => result.source === "note").map(result => result.action?.payload?.id)) : null;
      const match = n => !q || n.title.toLowerCase().includes(q) || (byId.get(n.id)?.excerpt ?? "").toLowerCase().includes(q) || found.has(n.id);
      const content = [];
      for (const folder of tree.folders) {
        // A folder whose name matches shows all of its notes.
        const rows = q && folder.title.toLowerCase().includes(q) ? folder.notes : folder.notes.filter(match);
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
              el("span", { class: "muted", text: summary ? plain(summary.excerpt).slice(0, 90) : "(content unavailable)" })),
            summary?.kind === "canvas" ? el("span", { class: "badge", text: "canvas" }) : null,
            summary ? el("span", { class: "muted", text: relativeTime(summary.modifiedAt) }) : null,
            el("button", { class: "ghost danger icon-only", title: "Move to trash", "aria-label": "Move to trash", onclick: async e => {
              e.stopPropagation();
              await bridge.browser("trashNote", { noteId: entry.id });
              load();
            } }, icon("trash"))));
        }
        if (!rows.length) list.append(el("li", { class: "muted", text: "No notes. Drag a note here." }));
        content.push(el("section", {
          class: "folder",
          ondragover: e => e.preventDefault(),
          ondrop: async e => {
            const id = e.dataTransfer.getData("text/lima-note");
            if (id) { await bridge.browser("moveNote", { noteId: id, folderGuid: folder.guid }); load(); }
          },
        }, el("h3", {}, folder.title, el("span", { class: "count", text: String(rows.length) })), list));
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
      body.replaceChildren(...content);
    } catch (error) {
      body.replaceChildren(el("p", { class: "error", text: errorText(error) }));
    }
  }

  let filterTimer;
  filter.addEventListener("input", () => { clearTimeout(filterTimer); filterTimer = setTimeout(load, 160); });
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

// MARK: Page (OneNote-style): title, date, and a WYSIWYG body that
// round-trips to the encrypted Markdown store.

export function toMarkdown(root) {
  const out = [];
  const inline = node => {
    let text = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { text += child.textContent.replace(/\u00a0/g, " ").replace(/\u200b/g, ""); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.localName;
      if (tag === "ul" || tag === "ol" || (tag === "input" && child.type === "checkbox")) continue;
      const inner = inline(child);
      if (tag === "br") text += "\n";
      else if (tag === "strong" || tag === "b") text += inner.trim() ? `**${inner}**` : inner;
      else if (tag === "em" || tag === "i") text += inner.trim() ? `*${inner}*` : inner;
      else if (tag === "code") text += `\`${child.textContent}\``;
      else if (tag === "s" || tag === "del" || tag === "strike") text += `~~${inner}~~`;
      else if (tag === "a") text += `[${inner}](${child.getAttribute("href")})`;
      else if (child.classList?.contains("note-value")) text += `{{${child.dataset.valueSource ?? ""}}}`;
      else if (tag === "img") text += `![${child.alt ?? ""}${child.dataset.width ? `|${child.dataset.width}` : ""}](${child.dataset.src ?? child.getAttribute("src") ?? ""})`;
      else text += inner;
    }
    return text;
  };
  const list = (node, depth) => {
    let n = 1;
    for (const li of node.children) {
      if (li.localName === "ul" || li.localName === "ol") { list(li, depth + 1); continue; }
      if (li.localName !== "li") continue;
      const box = li.querySelector(":scope > input[type=checkbox]");
      if (!inline(li).replace(/\u200b/g, "").trim() && !li.querySelector("ul, ol")) continue; // empty rows aren't saved
      const marker = node.localName === "ol" ? `${n++}.` : "-";
      out.push(`${"  ".repeat(depth)}${marker} ${box ? `[${box.checked ? "x" : " "}] ` : ""}${inline(li).trim()}`);
      for (const nested of li.querySelectorAll(":scope > ul, :scope > ol")) list(nested, depth + 1);
    }
  };
  const block = node => {
    if (node.nodeType === Node.TEXT_NODE) { if (node.textContent.trim()) out.push(node.textContent.trim(), ""); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.dataset.noteEmbed) { out.push("::embed " + node.dataset.noteEmbed, ""); return; }
    if (node.dataset.artifact) { out.push("```" + node.dataset.artifact, node.dataset.artifactSource, "```", ""); return; }
    if (node.classList.contains("note-columns")) {
      out.push(":::columns");
      [...node.querySelectorAll(":scope > .note-column")].slice(0, 3).forEach((column, index) => {
        if (index) out.push(":::column");
        const text = toMarkdown(column).trim();
        if (text) out.push(text);
      });
      out.push(":::end", "");
      return;
    }
    const tag = node.localName;
    if (/^h[1-6]$/.test(tag)) out.push(`${"#".repeat(Number(tag[1]))} ${inline(node).trim()}`, "");
    else if (tag === "ul" || tag === "ol") { list(node, 0); out.push(""); }
    else if (tag === "pre") out.push("```", node.textContent.replace(/\n$/, ""), "```", "");
    else if (tag === "blockquote") out.push(...inline(node).trim().split("\n").map(l => `> ${l}`), "");
    else if (tag === "hr") out.push("---", "");
    else if (tag === "table") {
      const rows = [...node.querySelectorAll("tr")].map(tr => [...tr.children].map(c => inline(c).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|")));
      if (rows.length) {
        const rules = [...node.rows[0].cells].map(cell => ({ right: "---:", center: ":---:" }[cell.style.textAlign] ?? "---"));
        out.push(`| ${rows[0].join(" | ")} |`, `| ${rules.join(" | ")} |`, ...rows.slice(1).map(r => `| ${r.join(" | ")} |`), "");
      }
    } else if (tag === "div" && node.classList.contains("md")) { for (const child of node.childNodes) block(child); }
    else {
      const text = inline(node);
      if (text.trim()) out.push(text.trim(), "");
      else if (out.length && out.at(-1) !== "") out.push("");
    }
  };
  for (const child of root.childNodes) block(child);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

const dateLine = ms => new Date(ms).toLocaleString([], { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

async function renderClassic(app, note) {
  let dirty = false;
  let saving = Promise.resolve();
  let conflicted = false;
  let selectionRange;
  const status = el("span", { class: "page-status", role: "status" });
  const recover = el("button", { class: "ghost", hidden: true, onclick: saveCopy }, "Save a copy");
  const title = el("input", { class: "page-title", value: note.title === "Untitled" ? "" : note.title, placeholder: "Untitled", "aria-label": "Title" });
  const body = el("div", { class: "page-body", contenteditable: "true", spellcheck: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Page", "data-placeholder": "Start writing…" });
  const selectBody = () => {
    const selection = getSelection();
    if (document.activeElement !== body) body.focus();
    if (body.contains(selection.anchorNode)) return;
    if (selectionRange && body.contains(selectionRange.commonAncestorContainer)) {
      selection.removeAllRanges();
      selection.addRange(selectionRange);
    }
  };
  const tool = (iconOrText, label, fn) => el("button", { class: "fmt", title: label, "aria-label": label,
    onmousedown: event => event.preventDefault(),
    onclick: () => { selectBody(); fn(); markDirty(); } },
    typeof iconOrText === "string" && iconOrText.length < 3 ? el("span", { text: iconOrText }) : iconOrText);
  const exec = (command, value) => () => document.execCommand(command, false, value);
  const addRow = tool("+ Row", "Add row below", () => extendTable("row"));
  const addColumn = tool("+ Column", "Add column after", () => extendTable("column"));
  const removeRow = tool("− Row", "Delete this row", () => shrinkTable("row"));
  const removeColumn = tool("− Column", "Delete this column", () => shrinkTable("column"));
  const removeTable = tool(icon("trash"), "Delete table", () => shrinkTable("table"));
  const tableTools = [addRow, addColumn, removeRow, removeColumn, removeTable];
  const setTableTools = enabled => { for (const button of tableTools) button.hidden = button.disabled = !enabled; };
  setTableTools(false);
  // One style menu instead of three heading buttons.
  const styles = [["p", "Text"], ["h1", "Heading"], ["h2", "Subheading"], ["h3", "Small heading"]];
  const styleSelect = el("select", { class: "fmt-select fmt-style", title: "Text style", "aria-label": "Text style",
    onmousedown: () => { rememberSelection(); },
    onchange: () => { selectBody(); document.execCommand("formatBlock", false, styleSelect.value); markDirty(); } },
    styles.map(([value, text]) => el("option", { value, text })));
  /* A small menu: a toolbar button that opens a list of actions. Items keep
   * the note's selection, like the toolbar buttons. */
  const menus = [];
  const menu = (iconOrText, label, items) => {
    const list = el("div", { class: "fmt-menu", role: "menu", hidden: true });
    const button = el("button", { class: "fmt fmt-menu-button", title: label, "aria-label": label, "aria-haspopup": "menu", "aria-expanded": "false",
      onmousedown: event => { event.preventDefault(); rememberSelection(); },
      onclick: () => toggle(list.hidden) },
    typeof iconOrText === "string" ? el("span", { text: iconOrText }) : iconOrText, icon("chevron", "icon fmt-caret"));
    const toggle = open => {
      if (open) for (const other of menus) if (other !== entry) other.close();
      if (list.hidden === !open) return;
      list.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      if (open) list.querySelector("button")?.focus({ preventScroll: true });
    };
    const fill = () => list.replaceChildren(...items().map(item => item === "-" ? el("i", { class: "fmt-menu-sep", role: "separator" })
      : el("button", { class: "fmt-menu-item", role: "menuitem", disabled: item.disabled ? "" : null,
        onmousedown: event => event.preventDefault(),
        onclick: () => { toggle(false); selectBody(); item.run(); if (item.dirty !== false) markDirty(); } },
      item.icon ? icon(item.icon) : el("span", { class: "fmt-menu-blank" }), el("span", { text: item.label }), item.hint ? el("kbd", { text: item.hint }) : null)));
    const entry = { close: () => toggle(false), fill };
    menus.push(entry);
    button.addEventListener("click", fill, { capture: true });
    list.addEventListener("keydown", event => {
      if (event.key === "Escape") { toggle(false); button.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = [...list.querySelectorAll("button:not([disabled])")];
        const next = items[(items.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
        next?.focus();
      }
    });
    return el("span", { class: "fmt-menu-wrap" }, button, list);
  };
  document.addEventListener("mousedown", event => { if (!event.target.closest?.(".fmt-menu-wrap")) for (const entry of menus) entry.close(); });

  const imageFile = el("input", { type: "file", accept: "image/*", hidden: true, onchange: async () => {
    const file = imageFile.files?.[0];
    imageFile.value = "";
    if (!file) return;
    if (file.size > 25_000_000) { status.textContent = "That image is larger than 25 MB."; return; }
    status.textContent = "Adding image…";
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const { id } = await call("notes.attachment.put", { data: btoa(binary) });
      insertImage(id, file.name.replace(/\.[^.]+$/, ""));
      status.textContent = "";
    } catch (error) { status.textContent = errorText(error); }
  } });
  async function imageFromAddress() {
    const value = window.prompt("Image address (HTTPS) or a file path on this Mac");
    if (!value?.trim()) return;
    status.textContent = "Adding image…";
    try {
      const { id } = await call("notes.image.add", { source: value.trim() });
      selectBody();
      insertImage(id, "");
      status.textContent = "";
    } catch (error) { status.textContent = errorText(error); }
  }
  function insertImage(id, alt) {
    const img = el("img", { "data-src": `lima-attachment:${id}`, alt });
    document.execCommand("insertHTML", false, img.outerHTML + "<p><br></p>");
    hydrateImages();
    markDirty();
  }
  function hydrateImages() {
    for (const img of body.querySelectorAll("img[data-src^='lima-attachment:']:not([src])")) {
      attachmentURL(img.dataset.src.slice("lima-attachment:".length)).then(url => { img.src = url; }).catch(() => {});
    }
  }
  function insertCalculator() {
    const card = artifactFromBlock("calculator", JSON.stringify(JSON.parse(CALCULATOR_TEMPLATE)), el);
    document.execCommand("insertHTML", false, card.outerHTML + "<p><br></p>");
    hydrateArtifacts();
    wireValues(body);
  }
  /** Blocks pasted in as HTML lose their behaviour; rebuild them from their source. */
  function hydrateArtifacts() {
    for (const figure of body.querySelectorAll("figure[data-artifact]")) {
      if (figure.limaLive) continue;
      const live = artifactFromBlock(figure.dataset.artifact, figure.dataset.artifactSource ?? "", el);
      if (live) { live.limaLive = true; figure.replaceWith(live); } else figure.limaLive = true;
    }
  }
  let archived = false;
  const archivedNotice = el("div", { class: "notice", hidden: true }, "This note is archived. ",
    el("button", { onclick: () => setArchived(false) }, "Restore"));
  async function setArchived(value) {
    try {
      await bridge.browser(value ? "archiveNote" : "unarchiveNote", { noteId: note.id });
      archived = value;
      archivedNotice.hidden = !value;
      status.textContent = value ? "Archived" : "Restored from the archive";
    } catch (error) { status.textContent = errorText(error); }
  }
  bridge.browser("noteArchived", { noteId: note.id }).then(value => { archived = value === true; archivedNotice.hidden = !archived; }).catch(() => {});

  const insertMenu = menu(icon("plus"), "Insert", () => [
    { label: "Table", icon: "table", run: insertTable },
    { label: "Image from a file…", icon: "image", run: () => imageFile.click(), dirty: false },
    { label: "Image from an address…", icon: "globe", run: imageFromAddress, dirty: false },
    { label: "Calculator", icon: "calc", run: insertCalculator },
    { label: "Value or formula (@)", icon: "hash", run: () => { document.execCommand("insertText", false, "@"); openPicker(); }, dirty: false },
    { label: "Embed a page…", icon: "link", run: insertEmbed },
  ]);
  const columnCount = () => { const columns = currentColumns(); return columns ? columns.querySelectorAll(":scope > .note-column").length : 1; };
  const moreMenu = menu(icon("more"), "More", () => [
    { label: "Strikethrough", run: exec("strikeThrough") },
    { label: "Inline code", run: wrapCode },
    { label: "Numbered list", run: exec("insertOrderedList") },
    "-",
    ...[1, 2, 3].map(count => ({ label: count === 1 ? "One column" : `${count} columns`, disabled: columnCount() === count, run: () => setColumns(count) })),
    "-",
    { label: "Undo", hint: "⌘Z", run: exec("undo") },
    { label: "Redo", hint: "⇧⌘Z", run: exec("redo") },
    "-",
    { label: "Copy share link", icon: "link", run: () => copyShareLink(), dirty: false },
    { label: archived ? "Restore from archive" : "Archive note", icon: "archive", run: () => setArchived(!archived), dirty: false },
  ]);
  /* A link that carries the note itself (compressed, after the #), opened
   * read-only on lima.liamhosfeld.com. Browsers never send the part after #
   * to a server, so nothing is uploaded. Images stay out (they'd make the link
   * too long); calculators and value blocks still work. */
  async function copyShareLink() {
    try {
      const current = draft();
      const markdown = current.markdown.replace(/!\[([^\]]*)\]\(lima-attachment:[^)]+\)/g, "![$1](omitted)");
      const json = JSON.stringify({ v: 1, t: current.title || "Untitled", m: markdown });
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const link = `https://lima.liamhosfeld.com/n#${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
      if (link.length > 60000) { status.textContent = "This note is too long to share as a link."; return; }
      await navigator.clipboard.writeText(link);
      status.textContent = /lima-attachment:/.test(current.markdown)
        ? "Share link copied (images aren't included). Anyone with it can read this note."
        : "Share link copied. Anyone with it can read this note.";
    } catch (error) { status.textContent = errorText(error); }
  }

  function insertEmbed() {
    const value = window.prompt("Paste an HTTPS or local preview URL");
    if (!value) return;
    const card = noteEmbed(value.trim());
    if (!card) { status.textContent = "Enter an HTTPS or local preview URL."; return; }
    selectBody();
    // One editing transaction, so Undo removes the embed again.
    document.execCommand("insertHTML", false, card.outerHTML + "<p><br></p>");
    hydrateEmbeds(body);
  }
  const toolbar = el("div", { class: "page-tools", role: "toolbar" },
    styleSelect, el("i", { class: "sep" }),
    tool("B", "Bold (⌘B)", exec("bold")), tool("I", "Italic (⌘I)", exec("italic")), tool(icon("link"), "Link (⌘K)", insertLink),
    el("i", { class: "sep" }),
    tool(icon("list"), "Bulleted list", exec("insertUnorderedList")), tool(icon("checkbox"), "To-do", () => insertTodo()),
    ...tableTools,
    el("i", { class: "sep" }),
    insertMenu, moreMenu, imageFile,
    tool(icon("mic"), "Dictate (⌃⌥D)", () => bridge.browser("dictate", { noteId: note.id })),
    el("span", { class: "spacer" }), status, recover);


  /* @ in the page: a picker of the note's values (calculator boxes and rows,
   * and named values) plus New value and Formula. The choice becomes a light
   * grey block that stays live. */
  const picker = el("div", { class: "value-picker", role: "listbox", "aria-label": "Insert a value", hidden: true });
  let pickerItems = [];
  let pickerIndex = 0;
  function closePicker() { picker.hidden = true; pickerItems = []; }
  function insertValue(source) {
    // Replace the @ that opened the picker with the block.
    const selection = getSelection();
    if (selection.rangeCount) {
      const range = selection.getRangeAt(0);
      if (range.collapsed && range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset > 0 &&
          range.startContainer.textContent[range.startOffset - 1] === "@") {
        range.setStart(range.startContainer, range.startOffset - 1);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    document.execCommand("insertHTML", false, valueChip(source, el).outerHTML + " ");
    hydrateValues();
    markDirty();
  }
  /** Blocks pasted in as HTML lose their behaviour; rebuild them from their source. */
  function hydrateValues() {
    for (const chip of body.querySelectorAll(".note-value")) {
      if (chip.limaLive) continue;
      const live = valueChip(chip.dataset.valueSource ?? "", el);
      chip.replaceWith(live);
    }
    wireValues(body);
  }
  function choosePicker(index) {
    const item = pickerItems[index];
    closePicker();
    if (!item) return;
    selectBody();
    if (item.kind === "use") { insertValue(item.name); return; }
    const names = Object.keys(noteScope(body));
    if (item.kind === "new") {
      const answer = window.prompt("A name and a number, such as budget = 120");
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*[:=]+\s*(-?\d+(?:\.\d+)?)\s*$/.exec(answer ?? "");
      if (!match) { if (answer) status.textContent = "Use a name and a number, such as budget = 120."; return; }
      selectBody();
      insertValue(`${match[1]} := ${match[2]}`);
      return;
    }
    const formula = window.prompt(names.length ? `A formula using ${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}` : "A formula, such as 120 / 4");
    if (!formula?.trim()) return;
    selectBody();
    insertValue(formula.trim().slice(0, 200));
  }
  function paintPicker() {
    picker.replaceChildren(...pickerItems.map((item, index) => el("button", { type: "button", role: "option", class: "value-picker-item",
      "aria-selected": String(index === pickerIndex), onmousedown: event => event.preventDefault(), onclick: () => choosePicker(index) },
      el("span", { class: "value-picker-label", text: item.label }), item.detail ? el("span", { class: "value-picker-detail", text: item.detail }) : null)));
  }
  function openPicker() {
    const scope = noteScope(body);
    pickerItems = [
      ...Object.entries(scope).slice(0, 12).map(([name, value]) => ({ kind: "use", name, label: name, detail: String(Math.round(value * 100) / 100) })),
      { kind: "new", label: "New value…", detail: "a number you can change" },
      { kind: "formula", label: "Formula…", detail: "computed from values" },
    ];
    pickerIndex = 0;
    paintPicker();
    const rect = getSelection().rangeCount ? getSelection().getRangeAt(0).getBoundingClientRect() : body.getBoundingClientRect();
    picker.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 240))}px`;
    picker.style.top = `${Math.min(rect.bottom + 6, innerHeight - 220)}px`;
    picker.hidden = false;
  }
  body.addEventListener("input", event => {
    if (event.inputType === "insertText" && event.data === "@") openPicker();
    else if (!picker.hidden) closePicker();
  });
  body.addEventListener("keydown", event => {
    if (picker.hidden) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      pickerIndex = (pickerIndex + (event.key === "ArrowDown" ? 1 : pickerItems.length - 1)) % pickerItems.length;
      paintPicker();
    } else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); choosePicker(pickerIndex); }
    else if (event.key === "Escape") { event.preventDefault(); closePicker(); }
  }, true);
  body.addEventListener("blur", () => setTimeout(closePicker, 150));

  /* Images: click one to resize it (S, M, L or full width). */
  const sizeBar = el("div", { class: "image-size", role: "toolbar", "aria-label": "Image size", hidden: true },
    [["25%", "S"], ["50%", "M"], ["75%", "L"], ["", "Full"]].map(([width, label]) => el("button", { type: "button", class: "fmt", title: width ? `${width} wide` : "Full width",
      onmousedown: event => event.preventDefault(),
      onclick: () => {
        const img = sizeBar.limaImage;
        if (!img?.isConnected) return;
        if (width) { img.dataset.width = width; img.style.width = width; } else { delete img.dataset.width; img.style.removeProperty("width"); }
        placeSizeBar(img);
        markDirty();
      } }, label)));
  function placeSizeBar(img) {
    const rect = img.getBoundingClientRect();
    sizeBar.limaImage = img;
    sizeBar.hidden = false;
    sizeBar.style.top = `${Math.max(8, rect.top + 8)}px`;
    sizeBar.style.left = `${rect.left + 8}px`;
    for (const button of sizeBar.children) button.setAttribute("aria-pressed", String(button.title === (img.dataset.width ? `${img.dataset.width} wide` : "Full width")));
  }
  body.addEventListener("click", event => {
    const img = event.target.closest?.("img");
    if (img && body.contains(img)) { placeSizeBar(img); img.classList.add("selected-image"); }
    else sizeBar.hidden = true;
    for (const other of body.querySelectorAll("img.selected-image")) if (other !== img) other.classList.remove("selected-image");
  });
  addEventListener("scroll", () => { sizeBar.hidden = true; }, { passive: true, capture: true });

  setPage(note.title || "Untitled", "note");
  app.replaceChildren(el("div", { class: "page-wrap" },
    trashedNotice(note, () => renderNote(app, note.id)) ?? "", archivedNotice,
    toolbar, sizeBar, picker,
    el("article", { class: "page-sheet" }, title, el("div", { class: "page-date", text: dateLine(note.createdAt) }), body)));
  document.execCommand("defaultParagraphSeparator", false, "p");

  function paint() {
    const rendered = markdown(note.markdown, { attachments: attachmentURL, embeds: true });
    for (const box of rendered.querySelectorAll("input[type=checkbox]")) box.disabled = false;
    selectionRange = undefined;
    setTableTools(false);
    body.replaceChildren(...rendered.childNodes);
    body.classList.toggle("empty", !note.markdown.trim());
    wireValues(body);
  }

  function tableCell() {
    const anchor = getSelection().anchorNode;
    const cell = (anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement)?.closest("th, td");
    return cell && body.contains(cell) && !cell.closest('[contenteditable="false"]') ? cell : null;
  }

  function insertTable() {
    if (tableCell()) return;
    const table = el("table", {}, el("thead", {}, el("tr", {}, el("th", { text: "Column 1" }), el("th", { text: "Column 2" }))),
      el("tbody", {}, el("tr", {}, blankCell("td"), blankCell("td"))));
    document.execCommand("insertHTML", false, table.outerHTML + "<p><br></p>");
  }

  function blankCell(tag) { return el(tag, {}, el("br")); }

  function extendTable(kind) {
    const cell = tableCell();
    if (!cell) return;
    const table = cell.closest("table");
    const row = cell.parentElement.rowIndex;
    const column = cell.cellIndex;
    const next = table.cloneNode(true);
    if (kind === "row") {
      const section = next.tBodies[0] ?? next.createTBody();
      const added = el("tr", {}, Array.from(next.rows[0].cells, () => blankCell("td")));
      if (row === 0) section.prepend(added);
      else next.rows[row].after(added);
    } else {
      for (const [index, line] of Array.from(next.rows).entries()) {
        const added = blankCell(index === 0 ? "th" : "td");
        if (line.cells[column]) line.cells[column].after(added);
        else line.append(added);
      }
    }
    const range = document.createRange();
    range.selectNode(table);
    const selection = getSelection();
    const parent = table.parentElement;
    const index = [...parent.children].indexOf(table);
    selection.removeAllRanges();
    selection.addRange(range);
    // Use Gecko's editing transaction so Undo also restores table structure.
    if (!document.execCommand("insertHTML", false, next.outerHTML)) return;
    const replacement = parent.children[index];
    const target = replacement?.rows?.[row + (kind === "row" ? 1 : 0)]?.cells[column + (kind === "column" ? 1 : 0)];
    if (target) selection.collapse(target, 0);
  }

  /** Swaps a block for new markup as one editing transaction (Undo restores it). */
  function replaceBlock(node, html, focus) {
    const parent = node.parentElement;
    const index = [...parent.children].indexOf(node);
    const range = document.createRange();
    range.selectNode(node);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand("insertHTML", false, html)) return null;
    const replacement = parent.children[index];
    const target = focus?.(replacement);
    if (target) selection.collapse(target, 0);
    return replacement;
  }

  function shrinkTable(kind) {
    const cell = tableCell();
    if (!cell) return;
    const table = cell.closest("table");
    const row = cell.parentElement.rowIndex;
    const column = cell.cellIndex;
    const columns = table.rows[0]?.cells.length ?? 0;
    // The last row or column takes the whole table with it.
    if (kind === "table" || (kind === "row" && table.rows.length <= 1) || (kind === "column" && columns <= 1)) {
      replaceBlock(table, "<p><br></p>", replacement => replacement);
      return;
    }
    const next = table.cloneNode(true);
    if (kind === "row") {
      next.rows[row].remove();
      // Deleting the header row promotes the first body row to header.
      if (row === 0 && next.rows[0]) {
        const promoted = el("tr", {}, Array.from(next.rows[0].cells, c => { const th = el("th"); th.append(...c.childNodes); return th; }));
        next.rows[0].remove();
        (next.tHead ?? next.createTHead()).append(promoted);
      }
    } else for (const line of Array.from(next.rows)) line.cells[column]?.remove();
    replaceBlock(table, next.outerHTML, replacement =>
      replacement?.rows?.[Math.min(row, replacement.rows.length - 1)]?.cells[Math.min(column, (replacement.rows[0]?.cells.length ?? 1) - 1)]);
  }

  // MARK: Columns
  function topBlock() {
    const anchor = getSelection().anchorNode;
    let node = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    while (node && node.parentElement !== body) node = node.parentElement;
    return node && body.contains(node) ? node : null;
  }
  function currentColumns() {
    const block = topBlock();
    return block?.classList.contains("note-columns") ? block : null;
  }
  function setColumns(count) {
    const block = topBlock();
    if (!block) return;
    const existing = block.classList.contains("note-columns") ? [...block.querySelectorAll(":scope > .note-column")] : null;
    if (existing && existing.length === count) return;
    const blank = "<p><br></p>";
    if (count === 1) {
      if (!existing) return;
      // Back to one column: the columns' content, in order.
      replaceBlock(block, existing.map(column => column.innerHTML.trim() || "").join("") || blank, replacement => replacement);
      return;
    }
    let parts;
    if (existing) {
      parts = existing.map(column => column.innerHTML.trim());
      // Fewer columns: the extra content joins the last one kept.
      while (parts.length > count) { const extra = parts.pop(); parts[parts.length - 1] += extra; }
      while (parts.length < count) parts.push(blank);
    } else {
      parts = [block.outerHTML, ...Array.from({ length: count - 1 }, () => blank)];
    }
    const html = `<div class="note-columns" data-columns="${count}">${parts.map(part => `<div class="note-column">${part || blank}</div>`).join("")}</div>`;
    replaceBlock(block, existing ? html : html + blank, replacement => replacement?.querySelector(".note-column")?.firstElementChild ?? replacement);
  }

  function wrapCode() {
    const selection = getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return;
    const code = document.createElement("code");
    code.textContent = selection.toString();
    document.execCommand("insertHTML", false, code.outerHTML);
  }

  function insertLink() {
    const input = window.prompt("Link address", "https://");
    if (!input) return;
    let url;
    try { url = new URL(input.trim()); } catch { status.textContent = "Enter a valid link address."; return; }
    if (!["https:", "http:"].includes(url.protocol) && !url.href.startsWith("about:lima")) {
      status.textContent = "Enter an HTTPS, HTTP, or Lima link.";
      return;
    }
    selectBody();
    if (getSelection().isCollapsed) {
      const link = el("a", { href: url.href, text: url.href });
      document.execCommand("insertHTML", false, link.outerHTML);
    } else document.execCommand("createLink", false, url.href);
    markDirty();
  }

  function insertTodo() {
    const selection0 = getSelection();
    const current = selection0.anchorNode && (selection0.anchorNode.nodeType === 1 ? selection0.anchorNode : selection0.anchorNode.parentElement)?.closest("li");
    if (current && body.contains(current)) {
      // Already in a list: turn this item into a to-do.
      current.classList.add("task");
      if (!current.querySelector(":scope > input[type=checkbox]")) current.prepend(el("input", { type: "checkbox" }));
      return;
    }
    const li = el("li", { class: "task" }, el("input", { type: "checkbox" }), " ");
    const ul = el("ul", {}, li);
    const selection = getSelection();
    const block = selection.anchorNode && (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement)?.closest("p, h1, h2, h3, li, div.page-body > *");
    if (block && block !== body && body.contains(block)) {
      li.append(...[...block.childNodes]);
      block.replaceWith(ul);
    } else body.append(ul);
    const range = document.createRange();
    range.selectNodeContents(li);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // Markdown shortcuts at the start of a line: "# ", "## ", "- ", "1. ", "[] ".
  body.addEventListener("keydown", event => {
    if (event.isComposing) return;
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "k") {
      event.preventDefault();
      event.stopPropagation();
      insertLink();
      return;
    }
    const anchor = getSelection().anchorNode;
    if (event.key === "Tab" && (anchor?.parentElement?.closest("li") || anchor?.closest?.("li"))) {
      event.preventDefault();
      exec(event.shiftKey ? "outdent" : "indent")();
      markDirty();
      return;
    }
    if (event.key !== " ") return;
    const selection = getSelection();
    const node = selection.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const block = node.parentElement.closest("p, div, li");
    if (!block || !body.contains(block) || block.textContent !== node.textContent) return;
    const before = node.textContent.slice(0, selection.anchorOffset);
    const actions = { "#": () => exec("formatBlock", "h1")(), "##": () => exec("formatBlock", "h2")(), "###": () => exec("formatBlock", "h3")(),
      "-": () => exec("insertUnorderedList")(), "*": () => exec("insertUnorderedList")(), "1.": () => exec("insertOrderedList")(), "[]": insertTodo, ">": () => exec("formatBlock", "blockquote")() };
    if (!actions[before]) return;
    event.preventDefault();
    selection.setBaseAndExtent(node, 0, node, before.length);
    document.execCommand("delete");
    actions[before]();
    markDirty();
  });

  body.addEventListener("click", event => {
    if (event.target.matches("input[type=checkbox]")) markDirty();
    const link = event.target.closest("a[href]");
    if (link && (event.metaKey || !body.contains(document.activeElement))) { event.preventDefault(); bridge.openTab(link.href); }
  });

  function draft() {
    return { markdown: toMarkdown(body), title: title.value.trim() || "Untitled" };
  }

  const save = debounce(() => {
    const current = draft();
    saving = saving.then(async () => {
      if (!dirty || conflicted) return;
      const edits = [];
      if (current.markdown.trim() !== note.markdown.trim()) edits.push({ setMarkdown: { _0: current.markdown } });
      if (current.title !== note.title) edits.push({ setTitle: { _0: current.title } });
      if (!edits.length) {
        dirty = draft().markdown !== current.markdown || draft().title !== current.title;
        status.textContent = "";
        return;
      }
      status.textContent = "Saving…";
      try {
        note = await call("notes.apply", { id: note.id, edits, baseRevision: note.revision, author: "user" });
        const latest = draft();
        dirty = latest.markdown !== current.markdown || latest.title !== current.title;
        status.textContent = dirty ? "Saving…" : "Saved";
        setPage(note.title, "note");
      } catch (error) {
        conflicted = /changed \(expected revision/.test(errorText(error));
        recover.hidden = !conflicted;
        status.textContent = conflicted
          ? "This note changed elsewhere. Your edits are here. Save a copy to keep them."
          : `Couldn’t save. ${errorText(error)}`;
      }
    });
    return saving;
  }, 300);

  function markDirty() {
    dirty = true;
    body.classList.toggle("empty", !body.textContent.trim() && !body.querySelector("img, table, [data-artifact], [data-note-embed]"));
    if (!conflicted) save();
  }

  async function saveCopy() {
    const current = draft();
    try {
      const copied = await bridge.browser("createNote", { kind: "classic", title: current.title + " (copy)" });
      await call("notes.apply", { id: copied.id, edits: [{ setMarkdown: { _0: current.markdown } }], author: "user" });
      status.textContent = "Copy saved";
      bridge.openTab(`about:lima?note=${encodeURIComponent(copied.id)}`);
    } catch (error) { status.textContent = errorText(error); }
  }

  const rememberSelection = () => {
    setTableTools(!!tableCell());
    const selection = getSelection();
    const anchor = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
    const blockTag = anchor && body.contains(anchor) ? anchor.closest("h1, h2, h3, p, li")?.localName : null;
    if (blockTag && document.activeElement !== styleSelect) styleSelect.value = ["h1", "h2", "h3"].includes(blockTag) ? blockTag : "p";
    if (selection.rangeCount && body.contains(selection.anchorNode)) selectionRange = selection.getRangeAt(0).cloneRange();
  };
  document.addEventListener("selectionchange", rememberSelection);
  // Remove on an embed: an undoable delete of just that card.
  body.addEventListener("lima-embed-remove", event => {
    const card = event.target.closest(".note-embed");
    if (!card || !body.contains(card)) return;
    const range = document.createRange();
    range.selectNode(card);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand("delete", false) || body.contains(card)) { card.remove(); markDirty(); }
  });
  body.addEventListener("input", event => {
    // Typing a number into a calculator isn't an edit of the note (its Save is).
    if (event.target.closest?.("[data-artifact]") && !event.target.matches?.("[data-artifact]")) return;
    for (const li of body.querySelectorAll("li.task")) {
      if (!li.querySelector(":scope > input[type=checkbox]")) li.prepend(el("input", { type: "checkbox" }));
    }
    markDirty();
  });
  title.addEventListener("input", markDirty);
  title.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); body.focus(); }
  });
  const flush = () => { if (dirty) save.flush(); };
  const onKey = event => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    flush();
  };
  document.addEventListener("keydown", onKey);
  body.addEventListener("blur", flush);
  title.addEventListener("blur", flush);
  window.addEventListener("pagehide", () => {
    flush();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("selectionchange", rememberSelection);
    unsubscribe();
  }, { once: true });

  const unsubscribe = onEvent(message => {
    if (message.event === "notes.changed" && message.data.id === note.id && message.data.revision > note.revision &&
        !dirty && document.activeElement !== body && !body.contains(document.activeElement)) {
      note = message.data;
      if (document.activeElement !== title) title.value = note.title === "Untitled" ? "" : note.title;
      setPage(note.title, "note");
      paint();
    }
    // Dictation started in this note lands at the cursor.
    if (message.event === "dictation.result" && message.data.target === note.id && message.data.text) {
      body.focus();
      const selection = getSelection();
      if (!selection.rangeCount || !body.contains(selection.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(body);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      document.execCommand("insertText", false, (body.textContent.trim() ? " " : "") + message.data.text);
    }
  });
  paint();
  if (!document.hidden && !note.markdown.trim() && !title.value) title.focus();
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
      el("button", { onclick: addEmbed }, "+ Embed"),
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

  function addEmbed() {
    const value = window.prompt("Paste an HTTPS or local preview URL");
    if (!value) return;
    const card = noteEmbed(value.trim());
    if (!card) { status.textContent = "Enter an HTTPS or local preview URL."; return; }
    const { x, y } = nextPosition();
    const block = { id: crypto.randomUUID(), type: "text", x, y, width: 520, height: 420, z: note.blocks.length,
      content: "::embed " + card.dataset.noteEmbed };
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
      node.append(markdown(block.content, { embeds: true }));
    } else {
      node.textContent = block.content;
    }
    const handle = el("div", { class: "resize" });
    node.append(handle);
    node.addEventListener("lima-embed-remove", () => {
      apply([{ removeBlock: { id: block.id } }], "Deleted");
      if (selected === block.id) selected = null;
    });

    node.addEventListener("pointerdown", event => {
      // The embed's own controls and player stay usable; the rest of the card drags and selects the block.
      if (event.button !== 0 || node.isContentEditable || event.target.closest(".note-embed button, .note-embed iframe")) return;
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
      const clear = () => {
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", cancel);
      };
      const cancel = () => { clear(); draw(); };
      const up = e => {
        clear();
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) < 2) return;
        const x = resizing ? block.x : Math.max(0, start.bx + dx), y = resizing ? block.y : Math.max(0, start.by + dy);
        const w = resizing ? Math.max(40, start.bw + dx) : block.width, h = resizing ? Math.max(30, start.bh + dy) : block.height;
        apply([{ moveBlock: { id: block.id, x, y, width: w, height: h } }]);
      };
      node.addEventListener("pointermove", move);
      node.addEventListener("pointerup", up);
      node.addEventListener("pointercancel", cancel);
    });
    node.addEventListener("dblclick", event => {
      if (block.type === "image" || event.target.closest(".note-embed")) return;
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
    if (document.activeElement?.isContentEditable || e.target === title) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); history(e.shiftKey ? "notes.redo" : "notes.undo"); }
    if ((e.key === "Backspace" || e.key === "Delete") && selected) { e.preventDefault(); apply([{ removeBlock: { id: selected } }], "Deleted"); selected = null; }
  });
  const saveTitle = debounce(() => apply([{ setTitle: { _0: title.value || "Untitled Canvas" } }]), 500);
  title.addEventListener("input", saveTitle);
  const unsubscribe = onEvent(message => {
    if (message.event === "notes.changed" && message.data.id === note.id && message.data.revision > note.revision) {
      note = message.data;
      setPage(note.title, "note");
      if (document.activeElement !== title) title.value = note.title;
      if (!document.activeElement?.isContentEditable) draw();
    }
  });
  window.addEventListener("pagehide", unsubscribe, { once: true });
  draw();
}
