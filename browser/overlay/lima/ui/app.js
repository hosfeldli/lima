/* about:lima router. Each URL is a tab-addressable Lima surface, so Zen's
 * tab, workspace, session-restore and bookmark machinery applies to it.
 * Sources are ES modules; the build bundles them into one classic script
 * because module scripts cannot load cross-origin into about:lima. */
import { bridge, el, setPage } from "./lib.js";
import { renderIndex, renderNote } from "./notes.js";
import { renderTerminal } from "./terminal.js";
import { renderChat } from "./chat.js";
import { renderStudio } from "./studio.js";
import { renderAgents, renderAsk, renderAudio, renderContext, renderHome, renderIntegrations, renderTool } from "./views.js";

const params = new URLSearchParams(location.search);
const app = document.getElementById("app");

const routes = [
  [() => params.has("note"), () => renderNote(app, params.get("note"))],
  [() => params.get("view") === "notes", () => renderIndex(app)],
  [() => params.has("terminal") || params.get("view") === "terminal", () => renderTerminal(app, params.get("terminal"))],
  [() => params.has("chat") || params.get("view") === "chat", () => renderChat(app, params.get("chat"), params.get("prompt"))],
  [() => params.has("ask"), () => renderAsk(app, params.get("ask"))],
  [() => params.has("tool"), () => renderTool(app, params.get("tool"), params.get("input") ?? "")],
  [() => params.get("view") === "agents", () => renderAgents(app)],
  [() => params.get("view") === "context", () => renderContext(app, params.get("report"))],
  [() => params.get("view") === "studio", () => renderStudio(app)],
  [() => params.get("view") === "audio", () => renderAudio(app)],
  [() => params.get("view") === "integrations", () => renderIntegrations(app)],
];

if (!bridge) {
  setPage("Lima");
  app.append(el("div", { class: "page narrow" }, el("p", { class: "error", text: "Lima's runtime bridge is unavailable in this tab." })));
} else {
  const route = routes.find(([match]) => match());
  Promise.resolve()
    .then(() => (route ? route[1]() : renderHome(app)))
    .catch(error => {
      app.replaceChildren(el("div", { class: "page narrow" }, el("p", { class: "error", text: `Could not open this Lima page: ${error.message ?? error}` })));
    });
}
