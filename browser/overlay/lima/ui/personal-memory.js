import { bridge, call, el, errorText, onEvent, relativeTime } from "./lib.js";

export function personalMemoryForm() {
  const status = el("p", { role: "status", class: "muted" });
  const field = (label, control) => el("label", { class: "personal-field" }, el("span", { text: label }), control);
  const inputs = {
    name: el("input", { type: "text", autocomplete: "name", maxlength: 120 }),
    email: el("input", { type: "email", autocomplete: "email", maxlength: 320 }),
    phone: el("input", { type: "tel", autocomplete: "tel", maxlength: 40 }),
    homeAddress: el("textarea", { rows: 2, autocomplete: "street-address", maxlength: 500 }),
    notes: el("textarea", { rows: 4, maxlength: 4000, placeholder: "Preferences, routines, or details you want to remember" }),
    shareNotes: el("input", { type: "checkbox" }),
    shareProfile: el("input", { type: "checkbox" }),
  };
  const setFields = data => {
    for (const [key, input] of Object.entries(inputs)) {
      if (input.type === "checkbox") input.checked = data[key] === true;
      else input.value = data[key] ?? "";
    }
  };
  const clear = el("button", { type: "button", class: "ghost", onclick: () => save({}) }, "Clear saved information");
  const fields = el("fieldset", { disabled: true },
    el("div", { class: "personal-grid" }, field("Name", inputs.name), field("Email", inputs.email), field("Phone number", inputs.phone), field("Home address", inputs.homeAddress)),
    field("App memory", inputs.notes),
    el("label", { class: "personal-check" }, inputs.shareNotes, "Use app memory in Companion"),
    el("label", { class: "personal-check" }, inputs.shareProfile, "Use profile details in Companion"),
    el("p", { class: "muted", text: "Lima stores this information encrypted on this Mac. Turning on either sharing option sends those details to your selected AI provider on Companion requests." }),
    el("div", { class: "row" }, el("button", { type: "submit", class: "primary" }, "Save"), clear));
  async function save(data) {
    fields.disabled = true;
    status.textContent = "Saving…";
    try {
      setFields(await call("personalMemory.save", data));
      status.textContent = Object.keys(data).length ? "Saved" : "Saved information cleared";
    } catch (error) { status.textContent = errorText(error); }
    finally { fields.disabled = false; }
  }
  const form = el("form", { class: "personal-memory", autocomplete: "off", onsubmit: event => {
    event.preventDefault();
    save(Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.type === "checkbox" ? input.checked : input.value])));
  } }, fields, status);
  call("personalMemory.get").then(data => { setFields(data); fields.disabled = false; }).catch(error => { status.textContent = errorText(error); });
  return form;
}

export function locationSettings() {
  const status = el("p", { role: "status", class: "muted" });
  const allowed = el("input", { type: "checkbox", disabled: true, onchange: async () => {
    const enabled = allowed.checked;
    allowed.disabled = check.disabled = true;
    try {
      allowed.checked = await bridge.browser("locationPreference", { enabled });
      status.textContent = allowed.checked ? "Location enabled in Lima. Check access to verify macOS permission." : "Location turned off in Lima.";
    } catch (error) { allowed.checked = !enabled; status.textContent = errorText(error); }
    finally { allowed.disabled = false; check.disabled = !allowed.checked; }
  } });
  const check = el("button", { class: "ghost", disabled: true, onclick: async () => {
    check.disabled = allowed.disabled = true;
    status.textContent = "Checking location access… macOS may ask you to allow Lima.";
    try {
      const place = await bridge.browser("locationCheck", {});
      status.textContent = place?.latitude != null
        ? `Working. Lima sees an approximate location near ${place.latitude.toFixed(1)}, ${place.longitude.toFixed(1)}.`
        : "Lima can read your approximate location.";
    }
    catch (error) { status.textContent = errorText(error); }
    finally { check.disabled = allowed.disabled = false; }
  } }, "Check access");
  bridge.browser("locationPreference", {}).then(enabled => {
    allowed.checked = enabled;
    allowed.disabled = false;
    check.disabled = !enabled;
  }).catch(error => { status.textContent = errorText(error); });
  return el("div", {}, el("label", { class: "personal-check" }, allowed, "Allow Lima to read my approximate location"),
    el("p", { class: "muted", text: "Workspace agents ask each time they need your location. macOS manages system-level access." }),
    el("div", { class: "row" }, check, el("button", { class: "ghost", onclick: () => {
      bridge.browser("locationSettings", {}).catch(error => { status.textContent = errorText(error); });
    } }, "Open macOS Location Services")), status);
}

/* The Companion's own memory: notes it keeps about you, updated once a day
 * from your requests and activity. You can read, edit, refresh, clear or
 * turn it off; turning it off stops updates and keeps it out of requests. */
export function companionMemorySettings() {
  const status = el("p", { role: "status", class: "muted" });
  const enabled = el("input", { type: "checkbox", disabled: true });
  const text = el("textarea", { rows: 7, maxlength: 6000, disabled: true, "aria-label": "Companion memory",
    placeholder: "Nothing yet. After a day of using Lima, the Companion writes what it learned here." });
  const save = el("button", { type: "button", class: "ghost", disabled: true }, "Save edits");
  const refresh = el("button", { type: "button", class: "ghost", disabled: true }, "Update now");
  const clear = el("button", { type: "button", class: "ghost", disabled: true }, "Forget everything");
  const describe = data => {
    if (!data.enabled) return "Off. The Companion doesn’t update or use this memory.";
    if (data.status === "queued") {
      const when = data.nextAttemptAt ? `at ${new Date(data.nextAttemptAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "soon";
      return `The last update didn’t finish (${data.lastError ?? "AI unavailable"}). It’s queued and retries ${when}.`;
    }
    return data.updatedAt ? `Updated ${relativeTime(data.updatedAt)}. The next update runs tomorrow, or when your Mac is next on.` : "The first update runs tomorrow.";
  };
  const draw = data => {
    enabled.checked = data.enabled;
    if (document.activeElement !== text) text.value = data.summary ?? "";
    status.textContent = describe(data);
    for (const control of [enabled, text, save, refresh, clear]) control.disabled = false;
    refresh.disabled = !data.enabled;
  };
  const run = async (method, params, busy) => {
    for (const control of [enabled, save, refresh, clear]) control.disabled = true;
    if (busy) status.textContent = busy;
    try { draw(await call(method, params)); }
    catch (error) { status.textContent = errorText(error); for (const control of [enabled, save, refresh, clear]) control.disabled = false; }
  };
  enabled.addEventListener("change", () => run("companionMemory.update", { enabled: enabled.checked }));
  save.addEventListener("click", () => run("companionMemory.update", { summary: text.value }, "Saving…"));
  refresh.addEventListener("click", () => run("companionMemory.run", null, "Reading today so far…"));
  clear.addEventListener("click", () => { if (confirm("Forget everything the Companion has learned?")) run("companionMemory.update", { summary: "" }); });
  const off = onEvent(({ event, data }) => {
    if (!status.isConnected) { off(); return; }
    if (event === "companionMemory.updated") draw(data);
  });
  call("companionMemory.get").then(draw).catch(error => { status.textContent = errorText(error); });
  return el("div", { class: "personal-memory" },
    el("p", { class: "muted", text: "Separate from your information above. Once a day the Companion reads your requests and recorded activity since its last update and keeps short notes here, using your default AI. If your Mac was off or the AI was unavailable, it catches up next time." }),
    el("label", { class: "personal-check" }, enabled, "Let the Companion keep a memory"), text,
    el("div", { class: "row" }, save, refresh, clear), status);
}
