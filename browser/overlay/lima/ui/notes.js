/* Notes: index (organized by the bookmark tree), classic editor and canvas. */
import { bar, bridge, call, debounce, el, errorText, hydrateEmbeds, icon, installEmbedActions, markdown, noteEmbed, onEvent, relativeTime, setPage } from "./lib.js";

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
      else if (tag === "img") text += `![${child.alt ?? ""}](${child.dataset.src ?? child.getAttribute("src") ?? ""})`;
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
  const body = el("div", { class: "page-body", contenteditable: "true", spellcheck: "true", "aria-label": "Page", "data-placeholder": "Start writing…" });
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
  addRow.disabled = addColumn.disabled = true;
  const toolbar = el("div", { class: "page-tools", role: "toolbar" },
    tool("H1", "Heading", exec("formatBlock", "h1")), tool("H2", "Subheading", exec("formatBlock", "h2")), tool(icon("paragraph"), "Text", exec("formatBlock", "p")),
    el("i", { class: "sep" }),
    tool("B", "Bold (⌘B)", exec("bold")), tool("I", "Italic (⌘I)", exec("italic")), tool("S", "Strikethrough", exec("strikeThrough")),
    tool("{}", "Code", wrapCode), tool(icon("link"), "Link (⌘K)", insertLink),
    el("i", { class: "sep" }),
    tool(icon("list"), "Bulleted list", exec("insertUnorderedList")), tool("1.", "Numbered list", exec("insertOrderedList")), tool(icon("checkbox"), "To-do", () => insertTodo()),
    tool(icon("table"), "Insert table", insertTable), addRow, addColumn,
    tool(icon("globe"), "Insert an interactive embed", () => {
      const value = window.prompt("Paste an HTTPS or local preview URL");
      if (!value) return;
      const card = noteEmbed(value.trim());
      if (!card) { status.textContent = "Enter an HTTPS or local preview URL."; return; }
      selectBody();
      // One editing transaction, so Undo removes the embed again.
      document.execCommand("insertHTML", false, card.outerHTML + "<p><br></p>");
      hydrateEmbeds(body);
    }),
    el("i", { class: "sep" }),
    tool(icon("mic"), "Dictate (⌃⌥D)", () => bridge.browser("dictate", { noteId: note.id })),
    el("span", { class: "spacer" }), status, recover,
    tool(icon("undo"), "Undo (⌘Z)", exec("undo")), tool(icon("redo"), "Redo (⇧⌘Z)", exec("redo")));

  setPage(note.title || "Untitled", "note");
  app.replaceChildren(el("div", { class: "page-wrap" },
    trashedNotice(note, () => renderNote(app, note.id)) ?? "",
    toolbar,
    el("article", { class: "page-sheet" }, title, el("div", { class: "page-date", text: dateLine(note.createdAt) }), body)));
  document.execCommand("defaultParagraphSeparator", false, "p");

  function paint() {
    const rendered = markdown(note.markdown, { attachments: attachmentURL, embeds: true });
    for (const box of rendered.querySelectorAll("input[type=checkbox]")) box.disabled = false;
    selectionRange = undefined;
    addRow.disabled = addColumn.disabled = true;
    body.replaceChildren(...rendered.childNodes);
    body.classList.toggle("empty", !note.markdown.trim());
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
    addRow.disabled = addColumn.disabled = !tableCell();
    const selection = getSelection();
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
  body.addEventListener("input", () => {
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
