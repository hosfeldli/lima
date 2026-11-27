import { bridge, el, errorText, icon, setPage } from "./lib.js";

/* Mini Lima's empty page: a quick look at the web from anywhere. One box
 * for an address or a search (Lima's own search engine setting), a few
 * places to jump to, and the keys that matter. */
export function renderMini(app) {
  setPage("Mini Lima", "search");
  document.body.classList.add("mini-page");
  const input = el("input", { type: "text", class: "mini-input", placeholder: "Search or enter a website…", "aria-label": "Search or enter a website",
    autocomplete: "off", spellcheck: "false" });
  const status = el("p", { class: "mini-status muted", role: "status" });
  const go = async text => {
    const value = (text ?? input.value).trim();
    if (!value) return;
    try { await bridge.browser("miniSearch", { text: value }); } catch (error) { status.textContent = errorText(error); }
  };
  input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); go(); } });
  const chip = (label, glyph, run) => el("button", { type: "button", class: "mini-chip", onclick: run }, icon(glyph), label);
  const chips = el("div", { class: "mini-chips" },
    chip("Google", "search", () => go("https://www.google.com/")),
    chip("YouTube", "play", () => go("https://www.youtube.com/")),
    chip("GitHub", "github", () => go("https://github.com/")));
  bridge.browser("miniInfo", {}).then(info => {
    if (info?.lastClosed) chips.append(chip("Reopen last", "history", () => go(info.lastClosed)));
    shortcut.textContent = info?.shortcut ?? "⌥⌘N";
  }).catch(() => {});
  const shortcut = el("kbd", { text: "⌥⌘N" });
  app.replaceChildren(el("main", { class: "mini" },
    el("p", { class: "mini-eyebrow", text: "Mini Lima" }),
    el("h1", { class: "mini-title", text: "A quick look at the web." }),
    el("form", { class: "mini-box", onsubmit: event => { event.preventDefault(); go(); } }, icon("search"), input,
      el("kbd", { class: "mini-enter", "aria-hidden": "true", text: "↵" })),
    chips,
    el("p", { class: "mini-keys muted" }, el("span", {}, el("kbd", { text: "esc" }), " Close"), el("span", {}, el("kbd", { text: "⌘O" }), " Open in Lima"),
      el("span", {}, shortcut, " Mini Lima from anywhere in Lima")),
    status));
  requestAnimationFrame(() => input.focus());
}
