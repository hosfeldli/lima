const interactive = "button, input, textarea, select, a[href], summary, [role=button], [role=link], [role=menuitem], [onclick], canvas";
const labelFor = node => (node.getAttribute("aria-label") || node.getAttribute("title") || node.labels?.[0]?.innerText ||
  node.innerText || node.getAttribute("placeholder") || node.localName).trim().replace(/\s+/g, " ").slice(0, 150);
const pointFor = node => {
  const rect = node.getBoundingClientRect();
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
};

/** Why a click needs the user's OK, or null for an ordinary control. */
function sensitivity(doc, control, label) {
  const context = `${doc.title} ${control.closest("form, [role=form]")?.innerText ?? ""}`;
  if (/\b(play|roll|start|spin|deal)\b/i.test(label) && /\b(casino|wager|stake cash|sportsbook|blackjack|dice|limbo|plinko|slots?)\b/i.test(context) ||
      /\b(place bet|bet|wager|cash out|deposit|withdraw|purchase|buy now|checkout|place order|pay now|pay|transfer)\b/i.test(label)) {
    return { risk: "money", reason: "This can spend or move money." };
  }
  if (/\b(delete|remove account|send|publish|unsubscribe|log\s?in|sign\s?in)\b/i.test(label)) {
    return { risk: "account", reason: "This changes your account or sends something on your behalf." };
  }
  if (control.matches("iframe, input[type=file], input[type=password], [download]")) {
    return { risk: "account", reason: "This opens a file, a download or embedded content." };
  }
  if (control.type === "submit" && control.form && control.form.method.toLowerCase() !== "get") {
    return { risk: "account", reason: "This submits a form." };
  }
  return null;
}

/* Parent-initiated, visible-page interactions for a workspace's authorized tab. */
export class LimaPageChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    if (name === "essentialStatus") return essentialStatus(this.document, data);
    if (name !== "action" || this.document.location.origin !== data.origin) throw new Error("The page navigated.");
    const doc = this.document;
    const win = this.contentWindow;
    const { action, options } = data;
    // Sensitive steps are never refused: they come back as needsApproval and
    // the runtime asks the user, then repeats the step with `confirmed`.
    if (data.paths && !data.paths.includes(doc.location.pathname) && !data.confirmed) {
      return { needsApproval: { kind: "path", path: doc.location.pathname, risk: "routine",
        reason: "The page moved to a path the plan didn't list." } };
    }
    const viewport = { width: win.innerWidth, height: win.innerHeight };
    if (action === "inspect") {
      const elements = [];
      for (const node of doc.querySelectorAll("button, a[href], input, select, textarea, summary, [role], [tabindex], [onclick], canvas")) {
        const rect = node.getBoundingClientRect();
        const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
        const hit = doc.elementFromPoint(x, y);
        if (!hit || !node.contains(hit) || !rect.width || !rect.height) continue;
        if (!node.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue;
        let path;
        if (node.localName === "a") {
          const link = new URL(node.href);
          if (link.origin === doc.location.origin) path = link.pathname;
        }
        elements.push({ label: labelFor(node), x, y, role: node.getAttribute("role") || node.localName, path });
        if (elements.length >= 120) break;
      }
      let text = "";
      if (doc.body) {
        const walker = doc.createTreeWalker(doc.body, win.NodeFilter.SHOW_TEXT);
        for (let count = 0, node; count < 2000 && text.length < 9000 && (node = walker.nextNode()); count++) {
          const label = node.textContent.trim();
          const parent = node.parentElement;
          if (!label || !parent?.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue;
          const range = doc.createRange();
          range.selectNodeContents(node);
          const visible = [...range.getClientRects()].some(rect => {
            const x = Math.max(0, rect.left) + Math.min(rect.width / 2, 8);
            const y = rect.top + rect.height / 2;
            return parent.contains(doc.elementFromPoint(x, y));
          });
          if (visible) text += (text ? "\n" : "") + label;
        }
      }
      return { viewport, url: doc.location.href, text: text.slice(0, 9000), elements };
    }
    if (action === "click") {
      let { x, y } = options;
      let control = Number.isFinite(x) && Number.isFinite(y) && doc.elementFromPoint(x, y)?.closest(interactive);
      if (typeof options.label === "string" && (!control || labelFor(control) !== options.label)) {
        const candidates = [...doc.querySelectorAll(interactive)].filter(node => {
          if (labelFor(node) !== options.label) return false;
          const point = pointFor(node);
          return doc.elementFromPoint(point.x, point.y)?.closest(interactive) === node;
        });
        if (candidates.length !== 1) throw new Error("That target moved or became ambiguous. Inspect again; this approval is still active.");
        [control] = candidates;
        ({ x, y } = pointFor(control));
      }
      if (!control) throw new Error("Choose a visible control from a fresh inspection.");
      const label = [control.innerText, control.value, control.getAttribute("aria-label"), control.getAttribute("href")].join(" ");
      const sensitive = data.confirmed ? null : sensitivity(doc, control, label);
      if (sensitive) return { needsApproval: { kind: "click", control: labelFor(control), ...sensitive } };
      if (control.localName === "a") {
        const destination = new URL(control.href);
        if (destination.origin !== data.origin || control.target === "_blank") {
          throw new Error("This link opens another site or window. Open it as a workspace tab and request a plan for it.");
        }
        if (!data.paths?.includes(destination.pathname) && !data.confirmed) {
          return { needsApproval: { kind: "navigate", control: labelFor(control), path: destination.pathname, risk: "routine",
            reason: "This link goes to a page the plan didn't list." } };
        }
      }
      const pointer = {
        identifier: win.windowUtils.DEFAULT_MOUSE_POINTER_ID,
        button: 0, clickCount: 1, inputSource: win.MouseEvent.MOZ_SOURCE_MOUSE,
      };
      win.synthesizeMouseEvent("mousedown", x, y, { ...pointer, buttons: 1 });
      win.synthesizeMouseEvent("mouseup", x, y, { ...pointer, buttons: 0 });
      return { ok: true, action, pointer: { x, y } };
    } else if (action === "type") {
      const field = doc.activeElement;
      if (typeof options.text !== "string" || !field || !["input", "textarea"].includes(field.localName) ||
          (field.localName === "input" && !["text", "search", "number", "tel"].includes(field.type)) ||
          field.disabled || field.readOnly || !field.getBoundingClientRect().width) {
        throw new Error("Focus a visible text field before typing.");
      }
      if (!data.confirmed && (field.type === "password" || /password|one-time-code|credit card|cc-|social security|private key|secret/i.test(
        [field.name, field.autocomplete, field.placeholder, field.getAttribute("aria-label")].join(" ")))) {
        return { needsApproval: { kind: "type", control: labelFor(field), secret: true, risk: "account",
          reason: "This is a sensitive field (password, code or payment detail)." } };
      }
      const pointer = pointFor(field);
      const prototype = field.localName === "input" ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, options.text.slice(0, 2000));
      field.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText" }));
      field.dispatchEvent(new win.Event("change", { bubbles: true }));
      return { ok: true, action, pointer };
    } else if (action === "scroll") {
      win.scrollBy({ top: Math.max(-2000, Math.min(2000, Number(options.dy) || 0)), behavior: "instant" });
    } else {
      throw new Error("Unknown browser action.");
    }
    return { ok: true, action };
  }
}

function essentialStatus(doc, { origin, service }) {
  if (doc.location.origin !== origin) return null;
  if (service === "mail" && origin === "https://mail.google.com") {
    const previews = /#inbox(?:$|\/)/.test(doc.location.hash) ? [...doc.querySelectorAll("tr.zA.zE")].slice(0, 12).flatMap(row => {
      const subject = row.querySelector(".bog");
      const sender = row.querySelector(".yP");
      const id = subject?.getAttribute("data-thread-id") || row.querySelector("[data-thread-id]")?.getAttribute("data-thread-id") || row.id;
      if (!id || !sender || !subject) return [];
      return [{ id, subject: subject.textContent.trim().slice(0, 200) || "(No subject)",
        sender: (sender.getAttribute("name") || sender.textContent).trim().slice(0, 160) }];
    }) : [];
    const readCount = value => {
      const digits = value?.match(/\((\d[\d,.\u00a0\u202f ]*)\)|\b(\d[\d,.\u00a0\u202f ]*)\s+unread\b/i);
      if (!digits) return null;
      const count = Number((digits[1] ?? digits[2]).replace(/\D/g, ""));
      return Number.isSafeInteger(count) ? count : null;
    };
    const inboxes = doc.querySelectorAll('a[href$="#inbox"]');
    for (const link of inboxes) {
      for (const text of [link.getAttribute("aria-label"), link.getAttribute("title"), link.textContent]) {
        const count = readCount(text) ?? (text?.trim().match(/^inbox[ \u00a0]+(\d[\d,.]*)$/i) ? Number(text.replace(/\D/g, "")) : null);
        if (count !== null) return { unread: count, previews };
      }
      if (/^inbox$/i.test(link.textContent.trim())) return { unread: 0, previews };
    }
    if (/^inbox\s+\(/i.test(doc.title)) {
      const count = readCount(doc.title);
      if (count !== null) return { unread: count, previews };
    }
    return null;
  }
  if (service !== "calendar" || origin !== "https://calendar.google.com") return null;
  const now = Date.now();
  const tomorrow = now + 48 * 60 * 60 * 1000;
  const meetings = new Map();
  let sawEvent = false;
  for (const node of doc.querySelectorAll("[data-eventid], [data-event-id], [data-event-start], time[datetime]")) {
    const label = node.getAttribute("aria-label") ?? "";
    const timestamp = node.getAttribute("data-event-start") ?? node.getAttribute("data-start-time") ??
      node.getAttribute("datetime") ?? node.querySelector("time[datetime]")?.getAttribute("datetime");
    const startsAt = appointmentTime(timestamp, label);
    if (!Number.isFinite(startsAt)) continue;
    sawEvent = true;
    const endsAt = appointmentTime(node.getAttribute("data-event-end") ?? node.getAttribute("data-end-time"), "");
    if ((Number.isFinite(endsAt) ? endsAt : startsAt + 30 * 60000) <= now || startsAt > tomorrow) continue;
    const title = node.getAttribute("data-event-title") || node.querySelector("[data-event-title]")?.getAttribute("data-event-title") ||
      label.split(",").filter(part => part.trim() && !/\d|\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(part)).at(0)?.trim() ||
      "Upcoming meeting";
    const id = node.getAttribute("data-eventid") ?? node.getAttribute("data-event-id") ?? `${startsAt}:${title}`;
    meetings.set(id, { id, title: title.slice(0, 140), startsAt, endsAt: Number.isFinite(endsAt) ? endsAt : null });
  }
  return sawEvent ? { meetings: [...meetings.values()].sort((a, b) => a.startsAt - b.startsAt) } : null;
}

function appointmentTime(timestamp, label) {
  if (timestamp && /^\d{10,13}$/.test(timestamp)) return Number(timestamp) * (timestamp.length === 10 ? 1000 : 1);
  if (timestamp && /^\d{4}-\d\d-\d\dT/.test(timestamp)) return Date.parse(timestamp);
  const date = label.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?\b/i)?.[0];
  const time = label.match(/\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\b/i)?.[0];
  if (!date || !time) return NaN;
  const withYear = /\d{4}$/.test(date) ? date : `${date} ${new Date().getFullYear()}`;
  return Date.parse(`${withYear} ${time.replaceAll(".", "")}`);
}
