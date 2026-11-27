import { SETTLE } from "./motion.sys.mjs";
/* about:lima router. Each URL is one tab with one job; everything that
 * organizes them lives in Zen's sidebar (docs/architecture/sidebar-workspaces.md).
 * Sources are ES modules; the build bundles them into one classic script
 * because module scripts cannot load cross-origin into about:lima. */
import { bridge, el, setPage } from "./lib.js";
import { renderActivity, renderRun } from "./home.js";
import { renderIndex, renderNote, renderNotesHelp } from "./notes.js";
import { renderAssistant } from "./assistant.js";
import { renderWorkspace } from "./workspace.js";
import { renderChat, renderMedia } from "./chat.js";
import { renderStudio } from "./studio.js";
import { renderWelcome } from "./welcome.js";
import { renderWhatsNew } from "./whatsnew.js";
import { renderMini } from "./mini.js";
import { renderAsk, renderAudio, renderIntegrations } from "./views.js";
import { renderImageStudio } from "./image-studio.js";
import { renderSchedules } from "./schedules.js";
import { renderStudioAnimation, renderStudioVector } from "./studio-production.js";

document.documentElement.style.setProperty("--lima-motion-settle", SETTLE);
const params = new URLSearchParams(location.search);
const app = document.getElementById("app");

/** Home and Companion use the same workspace handoff composer. */
function renderStart(root) {
  return renderAssistant(root, null, { home: true });
}

const routes = [
  [() => params.get("view") === "welcome", () => renderWelcome(app)],
  [() => params.get("view") === "whats-new", () => renderWhatsNew(app)],
  [() => params.get("view") === "mini", () => renderMini(app)],
  [() => params.get("view") === "notes-help", () => renderNotesHelp(app)],
  [() => params.get("view") === "image", () => {
    const workspace = params.get("imageWorkspace");
    if (workspace && params.has("vectorDocument")) return renderStudioVector(app, workspace, params.get("vectorDocument"));
    if (workspace && params.has("animationDocument")) return renderStudioAnimation(app, workspace, params.get("animationDocument"));
    return renderImageStudio(app, workspace, params.get("imageDocument"));
  }],
  [() => params.get("view") === "assistant", () => renderAssistant(app, params.get("workspaceId"))],
  [() => params.has("workspace"), () => renderWorkspace(app, params.get("workspace"))],
  [() => ["workspaces", "agents"].includes(params.get("view")), () => renderStart(app)],
  [() => params.has("note"), () => renderNote(app, params.get("note"))],
  [() => params.get("view") === "notes", () => renderIndex(app)],
  // The terminal was removed (agents use their own tools); old tabs land home.
  [() => params.has("terminal") || params.get("view") === "terminal", () => renderStart(app)],
  [() => params.has("chat") || params.get("view") === "chat", () => renderChat(app, params.get("chat") ?? "new", params.get("prompt"))],
  [() => params.has("ask"), () => renderAsk(app, params.get("ask"))],
  [() => params.has("run"), () => renderRun(app, params.get("run"), params.get("input"), params.get("execution"))],
  [() => params.has("tool"), () => renderRun(app, params.get("tool"), params.get("input"))],
  [() => params.get("view") === "schedules", () => renderSchedules(app)],
  [() => params.get("view") === "media", () => renderMedia(app, params.get("chat"), params.get("media"))],
  [() => params.get("view") === "activity", () => renderActivity(app, params.get("tab") ?? "commands")],
  [() => params.get("view") === "context", () => renderActivity(app, "reports", params.get("report"))],
  [() => params.get("view") === "studio", () => renderStudio(app)],
  [() => params.get("view") === "audio", () => renderAudio(app)],
  [() => params.get("view") === "integrations", () => renderIntegrations(app, params.get("section"))],
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
