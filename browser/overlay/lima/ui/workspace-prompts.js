import { call, el, errorText, icon, onEvent } from "./lib.js";

// What an approval puts at stake, in a few words.
const RISK = {
  money: ["warning", "Can spend money"],
  account: ["key", "Acts on your account"],
  // Something Lima's safety policy would otherwise stop.
  system: ["warning", "Affects your Mac"],
  // New reach: an ungranted scope, a folder outside the workspace.
  access: ["key", "Needs new access"],
  schedule: ["calendar", "Runs on its own later"],
};

export function workspacePrompts({ workspace = () => null, signal } = {}) {
  const tray = el("section", { class: "workspace-prompts", hidden: true, "aria-label": "Requests awaiting your response" });
  const rows = new Map();
  function draw() {
    const id = workspace();
    for (const card of rows.values()) {
      card.hidden = id !== null && card.dataset.workspace !== id && card.dataset.parent !== id;
    }
    tray.hidden = ![...rows.values()].some(card => !card.hidden);
  }
  function show(prompt) {
    if (rows.has(prompt.id)) return;
    const fields = prompt.fields ?? [];
    const controls = fields.map(field => {
      const required = field.required !== false && field.type !== "checkbox";
      const control = field.type === "select"
        ? el("select", { required }, el("option", { value: "", text: "Choose…" }),
          ...field.options.map(option => el("option", { value: option, text: option })))
        : el("input", { type: field.type, required, min: field.min, max: field.max,
          step: field.type === "number" ? "any" : undefined, maxlength: field.type === "text" ? 2000 : undefined,
          autocomplete: "off" });
      return { field, control };
    });
    const input = !prompt.approval && !fields.length ? el("textarea", { required: true, "aria-label": "Answer", rows: 2 }) : null;
    const status = el("div", { class: "prompt-status", role: "status" });
    const send = el("button", { class: "primary", type: "submit" }, prompt.approval ? prompt.actionLabel || "Allow" : "Send answer");
    const cancel = el("button", { class: "ghost", type: "button", onclick: () => reply(false) }, prompt.approval ? "Deny" : "Dismiss");
    // "For this task" also covers the helpers working with this agent.
    const task = prompt.allowTask ? el("button", { type: "button", class: "ghost",
      title: "Don't ask again for this site while this task runs, including its helper agents",
      onclick: () => reply(true, "task") }, "Allow for this task") : null;
    const form = el("form", { onsubmit: event => { event.preventDefault(); reply(true); } },
      input && el("label", { class: "prompt-answer" }, el("span", { text: "Your answer" }), input),
      fields.length ? el("div", { class: "workspace-question-fields" }, controls.map(({ field, control }) => {
        const caption = el("span", {}, field.label,
          field.required === false && field.type !== "checkbox" ? el("small", { text: "Optional" }) : null);
        return el("label", { "data-field-type": field.type },
          ...(field.type === "checkbox" ? [control, caption] : [caption, control]));
      })) : null,
      status, el("div", { class: "prompt-actions" }, cancel, task, send));
    const [riskIcon, riskText] = RISK[prompt.risk] ?? [];
    const facts = (prompt.facts ?? []).filter(fact => fact.value);
    // Long plans fold away; the question and facts carry the decision.
    const detail = !prompt.detail ? null : prompt.detail.length > 160 || prompt.detail.includes("\n")
      ? el("details", { class: "prompt-detail" }, el("summary", { text: prompt.approval ? "What it will do" : "Details" }), el("p", { text: prompt.detail }))
      : el("p", { class: "prompt-detail", text: prompt.detail });
    const card = el("article", { class: prompt.approval ? "prompt-approval" : "prompt-question", "data-risk": prompt.risk ?? undefined,
      "data-workspace": prompt.workspaceId, "data-parent": prompt.parentWorkspaceId ?? undefined },
      el("header", {},
        el("div", { class: "prompt-workspace" }, el("span", { text: prompt.workspaceName }),
          riskText ? el("span", { class: "prompt-risk" }, icon(riskIcon), riskText) : null),
        el("h3", { text: prompt.question })),
      facts.length ? el("dl", { class: "prompt-facts" }, facts.flatMap(fact => [el("dt", { text: fact.label }), el("dd", { text: fact.value })])) : null,
      detail, form);
    rows.set(prompt.id, card);
    tray.append(card);
    draw();
    async function reply(approved, scope = "once") {
      if (approved && !form.reportValidity()) return;
      send.disabled = cancel.disabled = true;
      if (task) task.disabled = true;
      form.setAttribute("aria-busy", "true");
      status.textContent = "Sending…";
      const values = approved && fields.length ? Object.fromEntries(controls.map(({ field, control }) => [
        field.id, field.type === "checkbox" ? control.checked : field.type === "number" && control.value ? control.valueAsNumber : control.value,
      ])) : undefined;
      try { await call("workspace.promptReply", { id: prompt.id, approved, text: input?.value, values, scope }); }
      catch (error) { status.textContent = errorText(error); send.disabled = cancel.disabled = false; if (task) task.disabled = false; }
      finally { form.removeAttribute("aria-busy"); }
    }
  }
  const removed = new Set();
  const unsubscribe = onEvent(({ event, data }) => {
    if (event === "prompt.opened") show(data);
    if (event === "prompt.closed") {
      removed.add(data.id);
      rows.get(data.id)?.remove();
      rows.delete(data.id);
      draw();
    }
  });
  if (signal) signal.addEventListener("abort", unsubscribe, { once: true });
  else window.addEventListener("pagehide", unsubscribe, { once: true });
  call("workspace.prompts").then(prompts => {
    if (!signal?.aborted) prompts.filter(prompt => !removed.has(prompt.id)).forEach(show);
  }).catch(() => {});
  return { node: tray, draw };
}
