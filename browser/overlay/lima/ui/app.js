/* about:lima router. Each URL is a tab-addressable Lima surface, so Zen's
 * tab, workspace, session-restore and bookmark machinery applies to it.
 * Sources are ES modules; the build bundles them into one classic script
 * because module scripts cannot load cross-origin into about:lima. */
import { bridge, el, setPage } from "./lib.js";
import { aurora, installPalette, openPalette } from "./components.js";
import { renderActivity, renderHome, renderRun } from "./home.js";
import { renderWorkspace, renderWorkspaces } from "./workspaces.js";
import { renderIndex, renderNote } from "./notes.js";
import { renderTerminal } from "./terminal.js";
import { renderChat } from "./chat.js";
import { renderStudio } from "./studio.js";
import { renderAsk, renderAudio, renderIntegrations } from "./views.js";

const params = new URLSearchParams(location.search);
const app = document.getElementById("app");

const routes = [
  [() => params.has("workspace"), () => renderWorkspace(app, params.get("workspace"))],
  [() => params.get("view") === "workspaces", () => renderWorkspaces(app, params.has("new"))],
  [() => params.has("note"), () => renderNote(app, params.get("note"))],
  [() => params.get("view") === "notes", () => renderIndex(app)],
  [() => params.has("terminal") || params.get("view") === "terminal", () => renderTerminal(app, params.get("terminal"))],
  [() => params.has("chat") || params.get("view") === "chat", () => renderChat(app, params.get("chat"), params.get("prompt"))],
  [() => params.has("ask"), () => renderAsk(app, params.get("ask"))],
  [() => params.has("run"), () => renderRun(app, params.get("run"), params.get("input"))],
  [() => params.has("tool"), () => renderRun(app, params.get("tool"), params.get("input"))], // pre-unification links
  [() => params.get("view") === "activity", () => renderActivity(app, params.get("tab") ?? "commands")],
  [() => params.get("view") === "agents", () => renderWorkspaces(app, false)], // merged into Workspaces
  [() => params.get("view") === "context", () => renderActivity(app, "reports", params.get("report"))], // merged into Activity
  [() => params.get("view") === "studio", () => renderStudio(app)],
  [() => params.get("view") === "audio", () => renderAudio(app)],
  [() => params.get("view") === "integrations", () => renderIntegrations(app)],
];

document.body.prepend(aurora());
installPalette();

if (!bridge) {
  setPage("Lima");
  app.append(el("div", { class: "page narrow" }, el("p", { class: "error", text: "Lima's runtime bridge is unavailable in this tab." })));
} else {
  const route = routes.find(([match]) => match());
  Promise.resolve()
    .then(() => (route ? route[1]() : renderHome(app)))
    .then(() => { if (params.has("palette")) openPalette(params.get("palette")); })
    .catch(error => {
      app.replaceChildren(el("div", { class: "page narrow" }, el("p", { class: "error", text: `Could not open this Lima page: ${error.message ?? error}` })));
    });
}
