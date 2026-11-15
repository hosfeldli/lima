/* about:lima router. Each URL is one tab with one job; everything that
 * organizes them lives in Zen's sidebar (docs/architecture/sidebar-workspaces.md).
 * Sources are ES modules; the build bundles them into one classic script
 * because module scripts cannot load cross-origin into about:lima. */
import { bridge, call, el, icon, setPage } from "./lib.js";
import { renderActivity, renderRun } from "./home.js";
import { renderIndex, renderNote } from "./notes.js";
import { renderTerminal } from "./terminal.js";
import { renderChat } from "./chat.js";
import { renderStudio } from "./studio.js";
import { renderAsk, renderAudio, renderIntegrations } from "./views.js";

const params = new URLSearchParams(location.search);
const app = document.getElementById("app");

/** Pre-sidebar links: a workspace dashboard is now its chat. */
async function openWorkspace(id) {
  const workspace = await call("workspace.get", { id }).catch(() => null);
  if (workspace?.conversationID) bridge.replaceURL(`about:lima?chat=${encodeURIComponent(workspace.conversationID)}`);
  else renderStart(app);
}

/** about:lima with nothing to show: point at the sidebar and ⌘T. */
function renderStart(root) {
  setPage("Lima", "lima");
  const create = what => bridge.browser("create", { what });
  root.replaceChildren(el("div", { class: "start" },
    el("img", { src: "resource://lima-ui/marks/lima-mark.svg", alt: "", width: 44, height: 44 }),
    el("button", { class: "start-search", onclick: () => bridge.browser("search", {}) }, icon("search"), "Search or ask", el("kbd", { text: "⌘T" })),
    el("div", { class: "start-actions" },
      el("button", { class: "ghost", onclick: () => create("workspace") }, icon("star"), "New AI Workspace"),
      el("button", { class: "ghost", onclick: () => create("note") }, icon("note"), "New Note"),
      el("button", { class: "ghost", onclick: () => create("terminal") }, icon("terminal"), "New Terminal")),
    el("p", { class: "muted", text: "Workspaces, notes, terminals and agents live in the sidebar. ＋ or right-click to add one." })));
}

const routes = [
  [() => params.has("workspace"), () => openWorkspace(params.get("workspace"))],
  [() => ["workspaces", "agents"].includes(params.get("view")), () => renderStart(app)],
  [() => params.has("note"), () => renderNote(app, params.get("note"))],
  [() => params.get("view") === "notes", () => renderIndex(app)],
  [() => params.has("terminal") || params.get("view") === "terminal", () => renderTerminal(app, params.get("terminal"))],
  [() => params.has("chat") || params.get("view") === "chat", () => renderChat(app, params.get("chat") ?? "new", params.get("prompt"))],
  [() => params.has("ask"), () => renderAsk(app, params.get("ask"))],
  [() => params.has("run"), () => renderRun(app, params.get("run"), params.get("input"))],
  [() => params.has("tool"), () => renderRun(app, params.get("tool"), params.get("input"))],
  [() => params.get("view") === "activity", () => renderActivity(app, params.get("tab") ?? "commands")],
  [() => params.get("view") === "context", () => renderActivity(app, "reports", params.get("report"))],
  [() => params.get("view") === "studio", () => renderStudio(app)],
  [() => params.get("view") === "audio", () => renderAudio(app)],
  [() => params.get("view") === "integrations", () => renderIntegrations(app)],
];

// ⌘K in a Lima tab opens Lima Search, same as ⌘T.
document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    bridge?.browser("search", {});
  }
});

if (!bridge) {
  setPage("Lima");
  app.append(el("div", { class: "start" }, el("p", { class: "error", text: "Lima's runtime bridge is unavailable in this tab." })));
} else {
  const route = routes.find(([match]) => match());
  Promise.resolve()
    .then(() => (route ? route[1]() : renderStart(app)))
    .catch(error => {
      app.replaceChildren(el("div", { class: "start" }, el("p", { class: "error", text: `Could not open this Lima page: ${error.message ?? error}` })));
    });
}
