/* ⇧⌘C: copying the page's link shows a small card under the address bar,
 * with the site, the link itself, and Copy as Markdown and Share. Replaces
 * Zen's one-line toast. Hovering keeps it open; it fades after a moment. */

const HTML = "http://www.w3.org/1999/xhtml";

export function installCopyLink(win) {
  const actions = win.gZenCommonActions;
  if (!actions || actions.limaCopyLink) return;
  actions.limaCopyLink = true;
  const doc = win.document;
  const el = (tag, attrs = {}, ...children) => {
    const node = doc.createElementNS(HTML, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  };
  const icon = el("img", { class: "lima-copied-icon", alt: "" });
  const title = el("strong", { class: "lima-copied-title" });
  const link = el("span", { class: "lima-copied-link" });
  const markdown = el("button", { class: "lima-copied-button", type: "button" }, "Copy as Markdown");
  const share = el("button", { class: "lima-copied-button", type: "button" }, "Share…");
  const card = el("div", { id: "lima-copied", role: "status", "aria-live": "polite", hidden: "true" },
    el("span", { class: "lima-copied-check", "aria-hidden": "true" }),
    el("div", { class: "lima-copied-text" }, title, el("span", { class: "lima-copied-site" }, icon, link)),
    el("div", { class: "lima-copied-actions" }, markdown, share));
  (doc.getElementById("browser") ?? doc.documentElement).append(card);

  let timer = null;
  let current = [];
  const hide = () => {
    if (card.matches(":hover, :focus-within")) { timer = win.setTimeout(hide, 800); return; }
    card.removeAttribute("data-open");
    timer = win.setTimeout(() => { card.hidden = true; }, 200);
  };
  const show = () => {
    win.clearTimeout(timer);
    card.hidden = false;
    // Re-trigger the check's draw on each copy.
    card.removeAttribute("data-open");
    void card.offsetWidth;
    card.setAttribute("data-open", "true");
    timer = win.setTimeout(hide, 2800);
  };
  markdown.addEventListener("click", () => {
    actions.copyCurrentURLAsMarkdownToClipboard();
    title.textContent = "Copied as Markdown";
    show();
  });
  share.addEventListener("click", event => {
    const uri = current[0]?.uri;
    if (!uri) return;
    const rect = event.currentTarget.getBoundingClientRect();
    try { Services.zen.share(uri, "", "", rect.left, win.innerHeight - rect.bottom, rect.width, rect.height); } catch {}
  });

  actions.copyCurrentURLToClipboard = function () {
    const [urls, multiple] = this.getCurrentURLs();
    const { BrowserUtils } = ChromeUtils.importESModule("resource://gre/modules/BrowserUtils.sys.mjs");
    BrowserUtils.copyLinks(urls.map(({ uri, title: name }) => ({ url: uri.displaySpec, title: name })));
    current = urls;
    const first = urls[0];
    let host = "";
    try { host = first.uri.host.replace(/^www\./, ""); } catch {}
    title.textContent = multiple ? `${urls.length} links copied` : "Link copied";
    link.textContent = multiple ? urls.map(({ uri }) => { try { return uri.host.replace(/^www\./, ""); } catch { return uri.spec; } }).join(", ")
      : first.uri.displaySpec.replace(/^https?:\/\/(www\.)?/, "");
    link.title = multiple ? "" : first.uri.displaySpec;
    const image = !multiple && win.gBrowser.selectedTab.getAttribute("image");
    icon.hidden = !image;
    if (image) icon.src = image;
    card.toggleAttribute("data-host", !!host);
    share.hidden = multiple || !/^https?:/.test(first.uri.spec) || !Services.zen?.canShare?.();
    markdown.hidden = multiple;
    show();
  };
}
