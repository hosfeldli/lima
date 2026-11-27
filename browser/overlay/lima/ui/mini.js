import { bridge, el, errorText, icon, setPage } from "./lib.js";

/* Mini Lima's empty page (⌥⌘N): one box for an address or a search. */
export function renderMini(app) {
  setPage("Mini Lima", "search");
  document.body.classList.add("mini-page");
  const input = el("input", { type: "text", class: "mini-input", placeholder: "Search or enter an address", "aria-label": "Search or enter an address",
    autocomplete: "off", spellcheck: "false" });
  const status = el("p", { class: "mini-status muted", role: "status" });
  const go = async () => {
    if (!input.value.trim()) return;
    try { await bridge.browser("miniSearch", { text: input.value }); } catch (error) { status.textContent = errorText(error); }
  };
  input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); go(); } });
  app.replaceChildren(el("main", { class: "mini" },
    el("form", { class: "mini-box", onsubmit: event => { event.preventDefault(); go(); } }, icon("search"), input),
    el("p", { class: "mini-hint muted" }, "Links you open from other apps land here too. ", el("kbd", { text: "⌘O" }), " moves a page into your Lima window."),
    status));
  requestAnimationFrame(() => input.focus());
}
