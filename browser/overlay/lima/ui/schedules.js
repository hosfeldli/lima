/* Scheduled Tasks (about:lima?view=schedules): work Lima starts on its own,
 * once or on repeat. Each run hands the instruction to a workspace's agent,
 * like a Companion request; the Companion creates most of these. */
import { bridge, call, el, errorText, icon, onEvent, relativeTime, setPage } from "./lib.js";
import { preferredAgent } from "./composer.js";

const DAYS = [["sun", "Sun"], ["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"]];
const KINDS = [["once", "One time"], ["daily", "Every day"], ["weekdays", "Weekdays"], ["weekly", "Certain days"], ["monthly", "Monthly"]];

const pad = n => String(n).padStart(2, "0");
const localInput = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** One line on how the latest run went. */
export function lastRunText(task) {
  const run = task.runs?.at(-1);
  if (!run) return "Hasn't run yet";
  const when = relativeTime(run.at);
  if (run.error) return `Last run ${when} didn't start: ${run.error}`;
  const late = !run.manual && run.at - run.due > 5 * 60_000;
  return `Last run ${when}${run.manual ? " (run early)" : late ? " (late: Lima wasn't open)" : ""}`;
}

export async function renderSchedules(app) {
  setPage("Scheduled Tasks", "calendar");
  const page = el("div", { class: "page narrow schedules-page" });
  const error = el("p", { class: "error", role: "status", hidden: true });
  const lists = el("div", { class: "schedule-sections" });
  const editor = el("div", { class: "schedule-editor", hidden: true });
  const add = el("button", { class: "primary", onclick: () => openEditor(null) }, icon("plus"), "New Scheduled Task");
  app.replaceChildren(el("header", { class: "bar" }, icon("calendar"), el("h1", { text: "Scheduled Tasks" }), el("span", { class: "spacer" }), add), page);
  page.append(
    el("p", { class: "muted schedules-intro", text: "Lima starts these on its own and hands each one to its workspace's agent. Ask the Companion things like “every day at 8:00 AM, check…” or “book this when reservations open 60 days out.” Lima needs to be open; a run it missed starts as soon as it's back, marked late." }),
    error, editor, lists);

  let schedules = [];
  let workspaces = new Map();
  const report = failure => { error.hidden = false; error.textContent = errorText(failure); };

  async function load() {
    try {
      const [items, all] = await Promise.all([call("schedule.list"), call("workspace.list").catch(() => [])]);
      schedules = items;
      workspaces = new Map(all.filter(w => !w.parentID).map(w => [w.id, w]));
      error.hidden = true;
      draw();
    } catch (failure) { report(failure); }
  }

  function draw() {
    const groups = [
      ["Repeating", schedules.filter(task => task.state === "scheduled" && task.repeats)],
      ["One time", schedules.filter(task => task.state === "scheduled" && !task.repeats)],
      ["Paused", schedules.filter(task => task.state === "paused")],
      ["Finished", schedules.filter(task => task.state === "done")],
    ].filter(([, items]) => items.length);
    lists.replaceChildren(...(groups.length ? groups.map(([label, items]) => el("section", { class: "schedule-group" },
      el("h2", { text: label }), el("ul", { class: "schedule-list" }, items.map(row))))
      : [el("div", { class: "schedule-empty" }, icon("calendar"), el("p", { text: "Nothing scheduled yet." }))]));
  }

  function row(task) {
    const workspace = workspaces.get(task.workspaceID);
    const act = (label, title, run) => el("button", { class: "ghost", title, onclick: async event => {
      event.currentTarget.disabled = true;
      try { await run(); } catch (failure) { report(failure); } finally { load(); }
    } }, label);
    const lastRun = task.runs?.at(-1);
    return el("li", { class: "schedule-row", "data-state": task.state },
      el("span", { class: "schedule-icon", "aria-hidden": "true" }, icon(task.repeats ? "redo" : "calendar")),
      el("div", { class: "schedule-main" },
        el("div", { class: "schedule-line" }, el("strong", { text: task.title }),
          el("span", { class: "badge", text: task.state === "paused" ? "Paused" : task.state === "done" ? "Done" : task.summary })),
        task.state === "scheduled" && task.nextRunLabel ? el("p", { class: "schedule-next" }, "Next: ", el("time", { text: task.nextRunLabel })) : null,
        el("p", { class: "schedule-instruction", text: task.instruction }),
        el("p", { class: "muted schedule-meta", text: [
          workspace ? `In ${workspace.name}` : `In a new workspace${task.workspaceName ? ` “${task.workspaceName}”` : ""}`,
          task.createdBy && task.createdBy !== "You" ? `Scheduled by ${task.createdBy}` : null,
          lastRunText(task),
        ].filter(Boolean).join(" · ") }),
        el("div", { class: "row schedule-actions" },
          act("Run Now", "Start this run now; the schedule stays the same", () => call("schedule.run", { id: task.id })),
          task.state !== "done" ? act(task.paused ? "Resume" : "Pause", task.paused ? "Start running on schedule again" : "Stop running until resumed",
            () => call("schedule.update", { id: task.id, paused: !task.paused })) : null,
          el("button", { class: "ghost", onclick: () => openEditor(task) }, task.state === "done" ? "Schedule Again" : "Edit"),
          (lastRun?.workspaceID ?? task.workspaceID) && workspaces.has(lastRun?.workspaceID ?? task.workspaceID)
            ? el("button", { class: "ghost", onclick: () => bridge.browser("openChat", { id: lastRun?.workspaceID ?? task.workspaceID }) }, "Open Workspace")
            : null,
          act("Delete", "Delete this scheduled task", async () => {
            if (confirm(`Delete “${task.title}”?`)) await call("schedule.delete", { id: task.id });
          }))));
  }

  /** Create or edit: what to do, when, and where. */
  function openEditor(task) {
    const s = task?.schedule;
    const kind = el("select", { "aria-label": "Repeats" }, KINDS.map(([value, text]) => el("option", { value, text })));
    kind.value = !s ? "daily" : s.kind === "weekly" && String(s.days) === "2,3,4,5,6" ? "weekdays" : s.kind;
    const at = el("input", { type: "datetime-local", "aria-label": "Date and time" });
    at.value = s?.at && s.at > Date.now() ? localInput(s.at) : localInput(Date.now() + 86_400_000 - (Date.now() % 60_000));
    const time = el("input", { type: "time", "aria-label": "Time", value: s?.time ?? "08:00" });
    const days = el("div", { class: "schedule-days" }, DAYS.map(([value, text], index) => el("label", {},
      el("input", { type: "checkbox", value, checked: s?.days?.includes(index + 1) ?? index === 1 }), text)));
    const day = el("input", { type: "number", min: 1, max: 31, value: s?.day ?? 1, "aria-label": "Day of the month" });
    const title = el("input", { type: "text", placeholder: "Check dinner reservations", value: task?.title ?? "", "aria-label": "Title" });
    const instruction = el("textarea", { rows: 4, placeholder: "Open https://… and look for a table for two at 7 PM; book it if one is free and tell me.", "aria-label": "Instruction" });
    instruction.value = task?.instruction ?? "";
    const where = el("select", { "aria-label": "Workspace" }, el("option", { value: "", text: "A new workspace" }),
      [...workspaces.values()].map(w => el("option", { value: w.id, text: w.name })));
    where.value = task?.workspaceID && workspaces.has(task.workspaceID) ? task.workspaceID : "";
    const status = el("p", { class: "error", role: "status", hidden: true });
    const field = (label, control) => el("label", { class: "schedule-field" }, el("span", { text: label }), control);
    const whenFields = el("div", { class: "schedule-when" });
    const paintWhen = () => whenFields.replaceChildren(
      field("Repeats", kind),
      kind.value === "once" ? field("On", at) : field("At", time),
      kind.value === "weekly" ? field("Days", days) : null,
      kind.value === "monthly" ? field("Day", day) : null);
    kind.addEventListener("change", paintWhen);
    paintWhen();

    const when = () => kind.value === "once" ? { kind: "once", at: at.value }
      : kind.value === "weekly" ? { kind: "weekly", time: time.value, days: [...days.querySelectorAll("input:checked")].map(box => box.value) }
      : kind.value === "monthly" ? { kind: "monthly", time: time.value, day: Number(day.value) }
      : { kind: kind.value, time: time.value };
    const save = async event => {
      event.preventDefault();
      status.hidden = true;
      try {
        if (task && task.state !== "done") {
          await call("schedule.update", { id: task.id, title: title.value, instruction: instruction.value, when: when() });
        } else {
          const agent = await preferredAgent().catch(() => ({}));
          await call("schedule.create", { ...agent, title: title.value, instruction: instruction.value, when: when(),
            workspaceId: where.value || undefined, workspaceName: where.value ? undefined : (title.value || "Scheduled Tasks") });
        }
        editor.hidden = true;
        editor.replaceChildren();
        load();
      } catch (failure) { status.hidden = false; status.textContent = errorText(failure); }
    };
    editor.hidden = false;
    editor.replaceChildren(el("form", { class: "schedule-form", onsubmit: save },
      el("h2", { text: task && task.state !== "done" ? "Edit Scheduled Task" : "New Scheduled Task" }),
      field("Title", title), field("What to do each time", instruction), whenFields,
      task && task.state !== "done" ? null : field("Runs in", where),
      status,
      el("div", { class: "row" }, el("button", { class: "primary", type: "submit" }, "Save"),
        el("button", { class: "ghost", type: "button", onclick: () => { editor.hidden = true; editor.replaceChildren(); } }, "Cancel"))));
    (task ? instruction : title).focus();
  }

  const unsubscribe = onEvent(({ event }) => {
    if (event === "schedule.updated" || event === "schedule.deleted") load();
  });
  addEventListener("unload", unsubscribe, { once: true });
  await load();
}
