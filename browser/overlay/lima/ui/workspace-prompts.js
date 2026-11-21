import { call, el, errorText, onEvent } from "./lib.js";

export function workspacePrompts({ workspace = () => null, signal } = {}) {
  const tray = el("section", { class: "workspace-prompts", hidden: true, "aria-label": "Requests awaiting your response" });
  const rows = new Map();
  function draw() {
    const id = workspace();
    for (const card of rows.values()) card.hidden = id !== null && card.dataset.workspace !== id;
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
    const status = el("div", { class: "muted", role: "status" });
    const send = el("button", { class: "primary", type: "submit" }, prompt.approval ? prompt.actionLabel || "Approve session" : "Send answer");
    const cancel = el("button", { class: "ghost", type: "button", onclick: () => reply(false) }, prompt.approval ? "Decline" : "Dismiss");
    const form = el("form", { onsubmit: event => { event.preventDefault(); reply(true); } },
      input, fields.length ? el("div", { class: "workspace-question-fields" }, controls.map(({ field, control }) =>
        el("label", { "data-field-type": field.type }, el("span", { text: field.label }), control))) : null,
      el("div", { class: "row" }, send, cancel), status);
    const card = el("article", { "data-workspace": prompt.workspaceId },
      el("strong", { text: prompt.workspaceName }), el("p", { text: prompt.question }),
      prompt.detail ? el("p", { class: "prompt-detail", text: prompt.detail }) : null, form);
    rows.set(prompt.id, card);
    tray.append(card);
    draw();
    async function reply(approved) {
      send.disabled = cancel.disabled = true;
      const values = approved && fields.length ? Object.fromEntries(controls.map(({ field, control }) => [
        field.id, field.type === "checkbox" ? control.checked : field.type === "number" && control.value ? control.valueAsNumber : control.value,
      ])) : undefined;
      try { await call("workspace.promptReply", { id: prompt.id, approved, text: input?.value, values }); }
      catch (error) { status.textContent = errorText(error); send.disabled = cancel.disabled = false; }
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
