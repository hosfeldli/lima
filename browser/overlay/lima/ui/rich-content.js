export function markdownCells(line) {
  const row = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === "\\" && row[i + 1] === "|") { cell += "|"; i++; continue; }
    if (char === "`") quoted = !quoted;
    if (char === "|" && !quoted) { cells.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

export function markdownTableAt(lines, index) {
  if (index + 1 >= lines.length || !lines[index].includes("|")) return null;
  const headers = markdownCells(lines[index]);
  const alignment = markdownCells(lines[index + 1]);
  if (headers.length !== alignment.length || !alignment.every(cell => /^:?-{2,}:?$/.test(cell))) return null;
  return { headers, alignment: alignment.map(cell => cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : "left") };
}

export function artifactFromBlock(kind, source, el) {
  if (!["chart", "checklist", "quiz", "details", "map", "calculator"].includes(kind) || source.length > 20000) return null;
  let spec;
  try { spec = JSON.parse(source); } catch { return null; }
  if (!spec || typeof spec !== "object") return null;
  const title = typeof spec.title === "string" ? spec.title.slice(0, 120) : "";
  const article = el("figure", { class: "rich-artifact", contenteditable: "false", "data-artifact": kind, "data-artifact-source": source });
  if (title) article.append(el("figcaption", { text: title }));
  if (kind === "calculator") {
    const node = calculator(spec, el);
    if (!node) return null;
    article.classList.add("has-actions");
    article.append(el("div", { class: "artifact-actions", role: "toolbar", "aria-label": "Calculator" }, node.limaCopy,
      el("button", { type: "button", class: "ghost artifact-edit", onclick: () => editCalculator(article, spec, el) }, "Edit")), node);
  } else if (kind === "map") {
    const map = offlineMap(spec, title, el);
    if (!map) return null;
    article.append(map);
  } else if (kind === "chart") {
    const values = Array.isArray(spec.values) ? spec.values.slice(0, 50).filter(row =>
      typeof row?.label === "string" && Number.isFinite(row.value) && Math.abs(row.value) < 1e100) : [];
    if (!values.length) return null;
    article.append(spec.type === "line" ? lineChart(values, title) : barChart(values, el));
    const entries = el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Label"), el("th", {}, "Value"))),
      el("tbody", {}, values.map(row => el("tr", {}, el("td", { text: row.label }), el("td", { text: String(row.value) })))));
    article.append(el("details", {}, el("summary", {}, "View chart data"), entries));
  } else if (kind === "checklist") {
    const items = stringItems(spec.items);
    if (!items.length) return null;
    article.append(el("ul", { class: "interactive-checklist" }, items.map(item =>
      el("li", {}, el("label", {}, el("input", { type: "checkbox" }), " ", item)))));
  } else if (kind === "quiz") {
    const options = stringItems(spec.options);
    if (!options.length || !Number.isInteger(spec.correct) || spec.correct < 0 || spec.correct >= options.length) return null;
    const result = el("p", { role: "status" });
    article.append(el("div", { class: "quiz-options" }, options.map((option, index) =>
      el("button", { class: "ghost", onclick: () => {
        result.textContent = index === spec.correct ? "Correct" : "Try again";
      } }, option))), result);
  } else {
    const detail = typeof spec.text === "string" ? spec.text.slice(0, 6000) : "";
    if (!detail) return null;
    article.append(el("details", {}, el("summary", {}, "Show details"), el("p", { text: detail })));
  }
  return article;
}

function editCalculator(article, spec, el) {
  const original = [...article.childNodes];
  const field = (label, value, type = "text") => {
    const input = Array.isArray(type)
      ? el("select", {}, type.map(option => el("option", { value: option, selected: option === (value || type[0]), text: option[0].toUpperCase() + option.slice(1) })))
      : el("input", { type, value: String(value ?? ""), ...(type === "number" ? { step: "any" } : {}) });
    return { input, label: el("label", { class: "calc-edit-field" }, label, input) };
  };
  const title = field("Title", spec.title), note = field("Note", spec.note);
  const inputs = [], rows = [];
  const fields = {
    input: [["Label", "label"], ["Variable", "id"], ["Kind", "type", ["number", "slider", "toggle"]], ["Starting value", "value", "number"], ["Unit", "unit"],
      ["Minimum", "min", "number"], ["Maximum", "max", "number"], ["Step", "step", "number"]],
    row: [["Label", "label"], ["Formula", "value"], ["Result variable", "id"], ["Unit", "unit"], ["Decimals", "decimals", "number"]],
  };
  const error = el("p", { class: "artifact-error", role: "alert", hidden: true });
  const group = (kind, name, entries, values, maximum) => {
    const list = el("div", { class: "calc-edit-list" });
    const add = el("button", { type: "button", class: "ghost", onclick: () => append({}) }, `Add ${kind}`);
    function append(value) {
      const controls = fields[kind].map(([label, key, type]) => ({ key, type, ...field(label, value[key] ?? (key === "value" ? value.formula : ""), type) }));
      const entry = { value, controls };
      const remove = el("button", { type: "button", class: "ghost", "aria-label": `Remove ${kind}`, onclick: () => {
        values.splice(values.indexOf(entry), 1);
        row.remove();
        add.disabled = false;
        add.focus();
      } }, "Remove");
      const row = el("div", { class: "calc-edit-row" }, controls.map(control => control.label), remove);
      values.push(entry);
      list.append(row);
      add.disabled = values.length >= maximum;
      return controls[0].input;
    }
    entries.slice(0, maximum).forEach(append);
    add.addEventListener("click", () => values.at(-1)?.controls[0].input.focus());
    return el("fieldset", {}, el("legend", { text: name }), list, add);
  };
  const read = ({ value, controls }) => {
    const entry = { ...value };
    for (const { input, key, type } of controls) {
      const text = input.value.trim();
      if (!text || (key === "type" && text === "number")) delete entry[key];
      else entry[key] = type === "number" ? Number(text) : text;
    }
    return entry;
  };
  const save = () => {
    const next = { ...spec, title: title.input.value, note: note.input.value, inputs: inputs.map(read), rows: rows.map(read) };
    const seen = new Set();
    const ids = [...next.inputs.map(input => input.id), ...next.rows.map(row => row.id).filter(Boolean)];
    const invalidIDs = ids.some(id => {
      if (!CALC_ID.test(id ?? "") || seen.has(id)) return true;
      seen.add(id);
      return false;
    });
    const incomplete = !next.inputs.length || !next.rows.length ||
      next.inputs.some(input => !input.label || !Number.isFinite(input.value) ||
        (input.min ?? -Infinity) > (input.max ?? Infinity) || (input.step !== undefined && input.step <= 0)) ||
      next.rows.some(row => !row.label || !row.value || (row.decimals !== undefined &&
        (!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 6)));
    const fresh = !invalidIDs && !incomplete && artifactFromBlock("calculator", JSON.stringify(next), el);
    if (!fresh) {
      error.hidden = false;
      error.textContent = "Enter a label and starting value for each input, a label and formula for each result, and use unique variable names.";
      return;
    }
    article.replaceWith(fresh);
    fresh.limaLive = true;
    fresh.dispatchEvent(new Event("input", { bubbles: true }));
  };
  article.replaceChildren(el("div", { class: "calc-editor" }, title.label,
    group("input", "Inputs", spec.inputs, inputs, 8), group("row", "Results", spec.rows, rows, 60), note.label, error,
    el("div", { class: "row" },
      el("button", { type: "button", class: "primary", onclick: save }, "Save"),
      el("button", { type: "button", class: "ghost", onclick: () => article.replaceChildren(...original) }, "Cancel"))));
  title.input.focus();
}

function copyResult(el, label, text) {
  return el("button", { type: "button", class: "ghost result-copy", "aria-label": label, title: label,
    onmousedown: event => event.preventDefault(),
    onclick: async event => {
      const button = event.currentTarget;
      const value = text();
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy failed";
      }
      setTimeout(() => { button.textContent = "Copy"; }, 1400);
    } }, "Copy");
}

function stringItems(items) {
  return Array.isArray(items) ? items.slice(0, 30).map(item => typeof item === "string" ? item.slice(0, 600) : "").filter(Boolean) : [];
}

function barChart(values, el) {
  const scale = Math.max(1, ...values.map(row => Math.abs(row.value)));
  return el("div", { class: "bar-chart" }, values.map(row => el("div", {},
    el("span", { text: row.label, title: row.label }),
    el("span", { class: "chart-bars", "aria-hidden": "true", "data-negative": row.value < 0 ? "true" : "false" },
      el("i", { style: { width: (Math.abs(row.value) / scale * 50) + "%" } })),
    el("strong", { text: String(row.value) }))));
}

function lineChart(values, title) {
  const SVG = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 560 160");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", title || "Line chart");
  const floor = Math.min(...values.map(row => row.value));
  const span = Math.max(1, Math.max(...values.map(row => row.value)) - floor);
  const points = values.map((row, index) => [
    values.length === 1 ? 280 : (16 + 528 * index / (values.length - 1)),
    144 - 128 * ((row.value - floor) / span),
  ]);
  const line = document.createElementNS(SVG, "polyline");
  line.setAttribute("points", points.map(point => point.join(",")).join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "2.5");
  svg.append(line);
  points.forEach(([x, y], index) => {
    const dot = document.createElementNS(SVG, "circle");
    dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", 4); dot.setAttribute("fill", "currentColor");
    const label = document.createElementNS(SVG, "title");
    label.textContent = values[index].label + " · " + values[index].value;
    dot.append(label);
    svg.append(dot);
  });
  return svg;
}

function offlineMap(spec, title, el) {
  const W = 720, H = 360;
  const project = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [(lon + 180) * 2, (90 - lat) * 2] : null;
  const markers = (Array.isArray(spec.markers) ? spec.markers.slice(0, 100) : []).flatMap(marker => {
    const point = project(marker?.latitude, marker?.longitude);
    return point ? [{ point, label: typeof marker.label === "string" ? marker.label.slice(0, 100) : "Location" }] : [];
  });
  const routes = (Array.isArray(spec.routes) ? spec.routes.slice(0, 25) : []).flatMap(route => {
    const points = Array.isArray(route?.points) && route.points.slice(0, 1500).map(point =>
      Array.isArray(point) && project(...point.slice(0, 2)));
    return points?.length >= 2 && points.every(Boolean)
      ? [{ points, label: typeof route.label === "string" ? route.label.slice(0, 100) : "Route",
        minutes: Number.isFinite(route.durationMinutes) && route.durationMinutes > 0 ? Math.round(route.durationMinutes) : null,
        mode: typeof route.mode === "string" ? route.mode.slice(0, 30) : null }] : [];
  });
  if (!markers.length && !routes.length) return null;
  const svg = (name, attributes) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };
  const canvas = svg("svg", { class: "offline-map-canvas", role: "group", "aria-label": title || "Map showing locations and routes" });
  const image = svg("image", { href: "resource://lima-ui/marks/offline-map.svg", width: W, height: H });
  canvas.append(image);
  for (const { points, label } of routes) {
    const path = svg("path", { class: "offline-map-route", "vector-effect": "non-scaling-stroke" });
    const segments = [];
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i - 1];
      let [nextX, nextY] = points[i];
      if (Math.abs(nextX - x) <= W / 2) {
        segments.push(`M${x},${y}L${nextX},${nextY}`);
      } else {
        const edge = nextX < x ? W : 0;
        const shift = nextX < x ? W : -W;
        nextX += shift;
        const edgeY = y + (nextY - y) * (edge - x) / (nextX - x || 1);
        segments.push(`M${x},${y}L${edge},${edgeY}M${edge - shift},${edgeY}L${nextX - shift},${nextY}`);
      }
    }
    path.setAttribute("d", segments.join(" "));
    const hint = svg("title", {});
    hint.textContent = label;
    path.append(hint);
    canvas.append(path);
  }
  const selectedLocation = el("p", { class: "offline-map-selection", hidden: true, role: "status" });
  let selectedPin;
  function selectPin(pin, label) {
    selectedPin?.removeAttribute("data-selected");
    selectedPin = pin;
    pin.setAttribute("data-selected", "");
    selectedLocation.textContent = label;
    selectedLocation.hidden = false;
  }
  const pins = markers.map(({ point: [x, y], label }) => {
    const pin = svg("circle", { cx: x, cy: y, class: "offline-map-pin", "vector-effect": "non-scaling-stroke",
      role: "button", tabindex: "0", "aria-label": label });
    pin.addEventListener("click", () => selectPin(pin, label));
    pin.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectPin(pin, label);
    });
    const hint = svg("title", {});
    hint.textContent = label;
    pin.append(hint);
    canvas.append(pin);
    return pin;
  });

  const points = [...markers.map(marker => marker.point), ...routes.flatMap(route => route.points)];
  let box;
  function update(x, y, scale) {
    const width = W * Math.max(.008, Math.min(1, scale)), height = width / 2;
    box = {
      x: Math.max(0, Math.min(W - width, x - width / 2)),
      y: Math.max(0, Math.min(H - height, y - height / 2)),
      width, height,
    };
    canvas.setAttribute("viewBox", `${box.x} ${box.y} ${width} ${height}`);
    for (const pin of pins) pin.setAttribute("r", width / 160);
  }
  function fit() {
    const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    update((left + right) / 2, (top + bottom) / 2, Math.max(.025, (right - left) / 590, (bottom - top) / 295));
  }
  function zoom(by) { update(box.x + box.width / 2, box.y + box.height / 2, box.width * by / W); }
  let drag;
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest(".offline-map-pin")) return;
    drag = { x: event.clientX, y: event.clientY, start: box, ratio: box.width / canvas.getBoundingClientRect().width };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (!drag) return;
    const { start, x, y, ratio } = drag;
    update(start.x + start.width / 2 - (event.clientX - x) * ratio,
      start.y + start.height / 2 - (event.clientY - y) * ratio, start.width / W);
  });
  canvas.addEventListener("lostpointercapture", () => { drag = undefined; });
  fit();
  const button = (label, name, onclick) => el("button", { class: "ghost", "aria-label": name, onclick }, label);
  const estimates = routes.filter(route => route.minutes != null);
  return el("div", { class: "offline-map" }, canvas, selectedLocation,
    estimates.length ? el("ul", { class: "offline-map-estimates", "aria-label": "Travel time estimates" },
      estimates.map(route => el("li", {}, el("strong", { text: route.label }),
        ` · about ${route.minutes} min${route.mode ? ` (${route.mode})` : ""}`))) : null,
    el("div", { class: "offline-map-controls row" },
      button("−", "Zoom out", () => zoom(1.7)), button("+", "Zoom in", () => zoom(1 / 1.7)),
      button("Fit", "Fit route and locations", fit), button("World", "Show world map", () => update(W / 2, H / 2, 1)),
      el("span", { class: "spacer" }), el("small", { text: "Made with Natural Earth" })),
    markers.length ? el("details", {}, el("summary", {}, "Locations"),
      el("ul", {}, markers.map(({ point: [x, y], label }, index) => el("li", {},
        button(label, `Center map on ${label}`, () => { update(x, y, .025); selectPin(pins[index], label); }))))) : null);
}

/* Calculators: inputs and rows computed from them, such as a recipe whose
 * ingredients scale with the servings you enter. Formulas are read by a
 * small parser (no script runs). They can use numbers, the names of values
 * in the note, + - * / % ^, comparisons (< <= > >= == !=, giving 1 or 0),
 * and/or/not, parentheses, the constants pi, yes and no, and the functions
 * in CALC_FUNCTIONS. */
export const CALC_FUNCTIONS = {
  round: (x, digits = 0) => { const f = 10 ** Math.max(0, Math.min(6, Math.trunc(digits))); return Math.round(x * f) / f; },
  ceil: Math.ceil, floor: Math.floor, min: Math.min, max: Math.max, abs: Math.abs, sqrt: Math.sqrt,
  if: (test, then, otherwise = 0) => (test ? then : otherwise),
  sum: (...values) => values.reduce((total, value) => total + value, 0),
  avg: (...values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : NaN,
  pow: Math.pow, clamp: (x, low, high) => Math.min(Math.max(x, low), high),
  pct: (part, whole) => part / whole * 100, log: Math.log10, ln: Math.log, exp: Math.exp, sign: Math.sign,
  not: x => (x ? 0 : 1),
};
const CALC_CONSTANTS = { pi: Math.PI, yes: 1, no: 0, true: 1, false: 0 };
const KEYWORDS = new Set(["and", "or", "as", "in", "step"]);

export function evaluateFormula(source, scope) {
  const text = String(source ?? "");
  if (!text.trim()) throw new Error("Empty formula");
  if (text.length > 300) throw new Error("Formula is too long");
  const tokens = [];
  const pattern = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|==|!=|[-+*/%^(),×÷<>]))/y;
  let match;
  while (pattern.lastIndex < text.length && (match = pattern.exec(text))) {
    if (match[1] !== undefined) tokens.push({ number: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push(KEYWORDS.has(match[2]) ? { op: match[2] } : { name: match[2] });
    else tokens.push({ op: match[3] === "×" ? "*" : match[3] === "÷" ? "/" : match[3] });
    if (tokens.length > 200) throw new Error("Formula is too long");
  }
  const rest = text.slice(pattern.lastIndex).trim();
  if (rest) throw new Error(`Can't read “${rest.slice(0, 12)}”`);
  let at = 0;
  const peek = () => tokens[at];
  const take = op => (peek()?.op === op ? (at++, true) : false);
  const expect = op => { if (!take(op)) throw new Error(`Expected “${op}”`); };
  const either = () => {
    let value = both();
    while (take("or")) { const right = both(); value = value || right ? 1 : 0; }
    return value;
  };
  function both() {
    let value = compare();
    while (take("and")) { const right = compare(); value = value && right ? 1 : 0; }
    return value;
  }
  function compare() {
    const left = expression();
    for (const op of ["<=", ">=", "==", "!=", "<", ">"]) {
      if (!take(op)) continue;
      const right = expression();
      const close = Math.abs(left - right) < 1e-9;
      return { "<=": left <= right || close, ">=": left >= right || close, "==": close, "!=": !close, "<": left < right && !close, ">": left > right && !close }[op] ? 1 : 0;
    }
    return left;
  }
  function expression() {
    let value = term();
    for (;;) {
      if (take("+")) value += term();
      else if (take("-")) value -= term();
      else return value;
    }
  }
  function term() {
    let value = unary();
    for (;;) {
      if (take("*")) value *= unary();
      else if (take("/")) value /= unary();
      else if (take("%")) value %= unary();
      else return value;
    }
  }
  // Exponents bind tighter than a leading minus: -2^2 is -4.
  function unary() {
    if (take("-")) return -unary();
    if (take("+")) return unary();
    return power();
  }
  function power() {
    const base = primary();
    return take("^") ? base ** unary() : base;
  }
  function primary() {
    const token = tokens[at++];
    if (!token) throw new Error("The formula ends too soon");
    if (token.number !== undefined) return token.number;
    if (token.op === "(") { const value = either(); expect(")"); return value; }
    if (token.name !== undefined) {
      if (peek()?.op === "(") {
        const fn = Object.hasOwn(CALC_FUNCTIONS, token.name) ? CALC_FUNCTIONS[token.name] : null;
        if (!fn) throw new Error(`No function named “${token.name}”`);
        at++;
        const args = [];
        if (!take(")")) { do args.push(either()); while (take(",")); expect(")"); }
        return fn(...args);
      }
      if (Object.hasOwn(scope, token.name)) return scope[token.name];
      if (Object.hasOwn(CALC_CONSTANTS, token.name)) return CALC_CONSTANTS[token.name];
      throw new Error(`Nothing is named “${token.name}”`);
    }
    throw new Error(`Unexpected “${token.op}”`);
  }
  const value = either();
  if (at !== tokens.length) throw new Error(`Unexpected “${tokens[at].op ?? tokens[at].name ?? tokens[at].number}”`);
  if (!Number.isFinite(value)) throw new Error("The result isn't a number (dividing by zero?)");
  return value;
}

const CALC_ID = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** The calculator's own state from its JSON, or null when it's unusable. */
export function calculatorSpec(spec) {
  const inputs = (Array.isArray(spec.inputs) ? spec.inputs : []).slice(0, 8).filter(input => CALC_ID.test(input?.id ?? "")).map(input => ({
    id: input.id, label: typeof input.label === "string" ? input.label.slice(0, 80) : input.id,
    type: ["slider", "toggle"].includes(input.type) ? input.type : "number",
    value: input.type === "toggle" ? (input.value ? 1 : 0) : Number.isFinite(input.value) ? input.value : 1,
    min: Number.isFinite(input.min) ? input.min : undefined, max: Number.isFinite(input.max) ? input.max : undefined,
    step: Number.isFinite(input.step) && input.step > 0 ? input.step : "any",
    unit: typeof input.unit === "string" ? input.unit.slice(0, 20) : "",
  }));
  const rows = (Array.isArray(spec.rows) ? spec.rows : []).slice(0, 60).filter(row => typeof row?.label === "string").map(row => ({
    id: CALC_ID.test(row.id ?? "") ? row.id : null, label: row.label.slice(0, 120),
    formula: String(row.value ?? row.formula ?? "").slice(0, 300), unit: typeof row.unit === "string" ? row.unit.slice(0, 20) : "",
    decimals: Number.isInteger(row.decimals) ? Math.max(0, Math.min(6, row.decimals)) : 2,
  }));
  return inputs.length && rows.length ? { inputs, rows, note: typeof spec.note === "string" ? spec.note.slice(0, 400) : "" } : null;
}

const formatNumber = (value, decimals) => {
  const fixed = Number(value.toFixed(decimals));
  return fixed.toLocaleString(undefined, { maximumFractionDigits: decimals });
};

function calculator(spec, el) {
  const calc = calculatorSpec(spec);
  if (!calc) return null;
  const outputs = calc.rows.map(row => el("output", { class: "calc-value" }));
  const readouts = calc.inputs.map(input => input.type === "slider" ? el("output", { class: "calc-readout", text: String(input.value) }) : null);
  const boxes = calc.inputs.map((input, index) => {
    if (input.type === "toggle") {
      return el("input", { type: "checkbox", role: "switch", class: "calc-toggle", checked: !!input.value, "aria-label": input.label, onchange: () => compute() });
    }
    const slider = input.type === "slider";
    return el("input", { type: slider ? "range" : "number", value: String(input.value), step: String(input.step),
      min: String(input.min ?? (slider ? 0 : "")), max: String(input.max ?? (slider ? 100 : "")),
      "aria-label": input.label, oninput: () => { if (readouts[index]) readouts[index].textContent = boxes[index].value; compute(); } });
  });
  const inputValue = (input, index) => {
    if (input.type === "toggle") return boxes[index].checked ? 1 : 0;
    const value = Number(boxes[index].value);
    return Number.isFinite(value) && boxes[index].value !== "" ? value : input.value;
  };
  function compute() {
    // Values defined elsewhere in the note are usable here too.
    const host = node.closest(".md, .page-body");
    const scope = host ? Object.fromEntries(Object.entries(noteScope(host)).filter(([key]) => !calc.inputs.some(input => input.id === key))) : {};
    calc.inputs.forEach((input, index) => { scope[input.id] = inputValue(input, index); });
    calc.rows.forEach((row, index) => {
      try {
        const value = evaluateFormula(row.formula, scope);
        if (row.id) scope[row.id] = value;
        outputs[index].textContent = formatNumber(value, row.decimals);
        outputs[index].removeAttribute("data-error");
      } catch (error) {
        outputs[index].textContent = "—";
        outputs[index].dataset.error = "true";
        outputs[index].title = `${error.message} in “${row.formula}”`;
      }
    });
    const figure = node.closest("figure[data-artifact]");
    if (figure) {
      figure.limaValues = Object.fromEntries([...calc.inputs.map(input => input.id), ...calc.rows.map(row => row.id).filter(Boolean)]
        .filter(key => Object.hasOwn(scope, key)).map(key => [key, scope[key]]));
    }
    node.dispatchEvent(new CustomEvent("lima-recalc", { bubbles: true }));
  }
  const node = el("div", { class: "calculator" },
    el("div", { class: "calc-inputs" }, calc.inputs.map((input, index) =>
      el("label", { class: "calc-input", "data-type": input.type }, el("span", { text: input.label }), boxes[index], readouts[index],
        input.unit ? el("span", { class: "calc-unit", text: input.unit }) : null))),
    el("table", { class: "calc-rows" }, el("tbody", {}, calc.rows.map((row, index) =>
      el("tr", {}, el("th", { scope: "row", text: row.label }), el("td", {}, outputs[index], row.unit ? el("span", { class: "calc-unit", text: ` ${row.unit}` }) : null))))),
    calc.note ? el("p", { class: "calc-note", text: calc.note }) : null);
  node.limaCopy = copyResult(el, "Copy calculator as text", () => [
      typeof spec.title === "string" ? spec.title : "",
      ...calc.inputs.map((input, index) => `${input.label}: ${input.type === "toggle" ? (inputValue(input, index) ? "yes" : "no") : inputValue(input, index)}${input.unit ? ` ${input.unit}` : ""}`),
      ...calc.rows.map((row, index) => `${row.label}: ${outputs[index].textContent}${row.unit ? ` ${row.unit}` : ""}`),
      calc.note,
    ].filter(Boolean).join("\n"));
  node.limaCompute = compute;
  // Once in a note, read its values (they may be defined below this block).
  queueMicrotask(compute);
  return node;
}

/** A starting calculator for the Notes Insert menu. */
export const CALCULATOR_TEMPLATE = JSON.stringify({
  title: "Recipe",
  inputs: [{ id: "servings", label: "Servings", value: 4, min: 1, step: 1 }],
  rows: [
    { label: "Flour", value: "250 * servings / 4", unit: "g" },
    { label: "Milk", value: "300 * servings / 4", unit: "ml" },
    { label: "Eggs", value: "ceil(2 * servings / 4)", decimals: 0 },
  ],
  note: "Written for 4 servings.",
}, null, 2);

/* Note values: light grey blocks that name a number or compute one, so a
 * note works like a small low-code flow. In Markdown:
 *   {{budget := 120}}                         a number you can change
 *   {{guests := 4 in 1..12}}                  a slider (add "step 2" for steps)
 *   {{vegan := yes}}                          a switch (1 when on, 0 when off)
 *   {{size := medium in small=1, medium=1.5, large=2}}   a choice; its value is the number
 *   {{budget / guests}}                       a live result
 *   {{each = budget / guests as $}}           a named result other formulas can use
 * Results take a display format after "as": $ € £ (money), % (percent sign),
 * 0 / 0.0 / 0.00 (decimals), or a short unit such as g or kg, e.g. "as 0.0 kg".
 * Formulas can also use calculator inputs and rows, and facts about the note:
 * tasks and done (its checklist), and for each table column with numbers,
 * <column>_sum, <column>_avg, <column>_min, <column>_max and <column>_count
 * (the column's header in lower case, spaces as _). */
const NAME = "[A-Za-z_][A-Za-z0-9_]{0,39}";
const NUMBER = "-?\\d+(?:\\.\\d+)?";
const FORMAT = /^(?:([$€£%])|(0(?:\.0{1,6})?|int))?\s*([A-Za-zµ°%/²³]{1,12})?$/;

/** What a {{…}} block holds, or { kind: "result" } for anything else. */
export function parseValueSource(source) {
  const text = String(source ?? "").trim().slice(0, 300);
  let match = new RegExp(`^(${NAME})\\s*:=\\s*(${NUMBER})\\s+in\\s+(${NUMBER})\\s*\\.\\.\\s*(${NUMBER})(?:\\s+step\\s+(\\d+(?:\\.\\d+)?))?$`).exec(text);
  if (match) {
    const [min, max] = [Number(match[3]), Number(match[4])].sort((a, b) => a - b);
    const step = match[5] ? Number(match[5]) : 1;
    return { kind: "slider", name: match[1], value: Math.min(max, Math.max(min, Number(match[2]))), min, max, step: step > 0 ? step : 1 };
  }
  match = new RegExp(`^(${NAME})\\s*:=\\s*([^=]+?)\\s+in\\s+(.+)$`).exec(text);
  if (match) {
    const options = match[3].split(",").map(part => /^\s*([^=,]{1,30}?)\s*=\s*(-?\d+(?:\.\d+)?)\s*$/.exec(part)).filter(Boolean)
      .map(([, label, value]) => ({ label, value: Number(value) })).slice(0, 20);
    if (options.length >= 2 && options.length === match[3].split(",").length) {
      const choice = options.find(option => option.label === match[2].trim()) ?? options[0];
      return { kind: "choice", name: match[1], choice: choice.label, value: choice.value, options };
    }
  }
  match = new RegExp(`^(${NAME})\\s*:=\\s*(yes|no|on|off|true|false)$`, "i").exec(text);
  if (match) return { kind: "toggle", name: match[1], value: /^(yes|on|true)$/i.test(match[2]) ? 1 : 0 };
  match = new RegExp(`^(${NAME})\\s*:=\\s*(${NUMBER})$`).exec(text);
  if (match) return { kind: "number", name: match[1], value: Number(match[2]) };
  let formula = text, name = null, format = "";
  const as = /\s+as\s+([^]*)$/.exec(formula);
  if (as && FORMAT.test(as[1].trim())) { format = as[1].trim(); formula = formula.slice(0, as.index); }
  match = new RegExp(`^(${NAME})\\s*=(?!=)\\s*([^]+)$`).exec(formula);
  if (match) { name = match[1]; formula = match[2]; }
  return { kind: "result", name, formula: formula.trim(), format };
}

/** The Markdown source for an input block holding `value`. */
export function valueSource(spec, value) {
  if (spec.kind === "slider") return `${spec.name} := ${value} in ${spec.min}..${spec.max}${spec.step !== 1 ? ` step ${spec.step}` : ""}`;
  if (spec.kind === "toggle") return `${spec.name} := ${value ? "yes" : "no"}`;
  if (spec.kind === "choice") return `${spec.name} := ${value} in ${spec.options.map(option => `${option.label}=${option.value}`).join(", ")}`;
  return `${spec.name} := ${value}`;
}

/** A number shown with a block's format ("" is up to two decimals). */
export function formatValue(value, format = "") {
  const [, money, decimals, unit] = FORMAT.exec(String(format).trim()) ?? [];
  const places = money && money !== "%" ? 2 : decimals === "int" ? 0 : decimals ? (decimals.split(".")[1] ?? "").length : null;
  const text = Number(value.toFixed(places ?? 2)).toLocaleString(undefined,
    places === null ? { maximumFractionDigits: 2 } : { minimumFractionDigits: places, maximumFractionDigits: places });
  if (money === "%") return `${text}%${unit ? ` ${unit}` : ""}`;
  if (money) return `${value < 0 ? "−" : ""}${money}${text.replace(/^-/, "")}${unit ? ` ${unit}` : ""}`;
  return unit ? `${text} ${unit}` : text;
}

/** The grey block for one {{…}} source. */
export function valueChip(source, el) {
  const text = String(source).slice(0, 300);
  const spec = parseValueSource(text);
  if (spec.kind !== "result") {
    const chip = el("span", { class: "note-value", contenteditable: "false", "data-value-source": text, "data-define": spec.name, "data-kind": spec.kind });
    const changed = value => {
      chip.dataset.valueSource = valueSource(spec, value);
      chip.dispatchEvent(new Event("input", { bubbles: true }));
      chip.dispatchEvent(new CustomEvent("lima-recalc", { bubbles: true }));
    };
    let control;
    if (spec.kind === "toggle") {
      control = el("input", { type: "checkbox", role: "switch", class: "note-value-toggle", checked: !!spec.value, "aria-label": spec.name,
        onchange: () => changed(control.checked ? 1 : 0) });
    } else if (spec.kind === "choice") {
      control = el("select", { class: "note-value-select", "aria-label": spec.name, onchange: () => changed(control.value) },
        spec.options.map(option => el("option", { value: option.label, selected: option.label === spec.choice, text: option.label })));
    } else if (spec.kind === "slider") {
      const readout = el("output", { class: "note-value-readout", text: String(spec.value) });
      control = el("input", { type: "range", class: "note-value-range", min: String(spec.min), max: String(spec.max), step: String(spec.step),
        value: String(spec.value), "aria-label": spec.name, oninput: () => { readout.textContent = control.value; changed(Number(control.value)); } });
      chip.append(el("span", { class: "note-value-name", text: spec.name }), control, readout);
    } else {
      control = el("input", { type: "number", value: String(spec.value), step: "any", "aria-label": spec.name, class: "note-value-input",
        oninput: () => { if (control.value !== "" && Number.isFinite(Number(control.value))) changed(Number(control.value)); } });
    }
    if (!chip.firstChild) chip.append(el("span", { class: "note-value-name", text: spec.name }), control);
    chip.limaValue = () => spec.kind === "toggle" ? (control.checked ? 1 : 0)
      : spec.kind === "choice" ? spec.options.find(option => option.label === control.value)?.value ?? spec.value
      : Number(control.value);
    chip.limaLive = true;
    // Typing in the block mustn't move the note's caret or start a new line.
    control.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); control.blur(); } event.stopPropagation(); });
    return chip;
  }
  // A result: click (or Enter) copies it.
  const out = el("span", { class: "note-value-out", text: "…" });
  const chip = el("span", { class: "note-value result", contenteditable: "false", "data-value-source": text, role: "button", tabindex: "0",
    ...(spec.name ? { "data-result-name": spec.name } : {}) },
    spec.name ? el("span", { class: "note-value-name", text: spec.name }) : null, out);
  const copy = async () => {
    if (chip.hasAttribute("data-error")) return;
    try { await navigator.clipboard.writeText(out.textContent); chip.dataset.copied = "true"; } catch {}
    setTimeout(() => chip.removeAttribute("data-copied"), 1200);
  };
  chip.addEventListener("click", copy);
  chip.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); copy(); } });
  chip.limaLive = true;
  return chip;
}

const columnName = header => header.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
const cellNumber = text => {
  const clean = String(text).replace(/[$€£,\s%]/g, "").replace(/^\((.*)\)$/, "-$1");
  return /^-?\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : null;
};

/** Facts about the note itself: its checklist and its tables' number columns. */
export function noteFacts(root) {
  const facts = {};
  const boxes = [...root.querySelectorAll("li > input[type=checkbox], .interactive-checklist input[type=checkbox]")];
  facts.tasks = boxes.length;
  facts.done = boxes.filter(box => box.checked).length;
  for (const table of root.querySelectorAll("table:not(.calc-rows)")) {
    if (table.closest(".rich-artifact")) continue;
    const rows = [...table.rows];
    const headers = [...(rows.shift()?.cells ?? [])].map(cell => columnName(cell.textContent));
    headers.forEach((name, column) => {
      if (!/^[a-z_]/.test(name)) return;
      const values = rows.map(row => cellNumber(row.cells[column]?.textContent ?? "")).filter(value => value !== null);
      if (!values.length) return;
      const total = values.reduce((sum, value) => sum + value, 0);
      Object.assign(facts, { [`${name}_sum`]: total, [`${name}_avg`]: total / values.length, [`${name}_min`]: Math.min(...values),
        [`${name}_max`]: Math.max(...values), [`${name}_count`]: values.length });
    });
  }
  return facts;
}

/** Every named number in `root`: note facts, calculator inputs and rows, and value blocks. */
export function noteScope(root) {
  const scope = noteFacts(root);
  for (const figure of root.querySelectorAll("figure[data-artifact='calculator']")) Object.assign(scope, figure.limaValues ?? {});
  for (const chip of root.querySelectorAll(".note-value[data-define]")) {
    const value = chip.limaValue ? chip.limaValue() : parseValueSource(chip.dataset.valueSource).value;
    if (Number.isFinite(value)) scope[chip.dataset.define] = value;
  }
  for (const chip of root.querySelectorAll(".note-value[data-result-name]")) {
    if (Number.isFinite(chip.limaResult)) scope[chip.dataset.resultName] = chip.limaResult;
  }
  return scope;
}

/** Recomputes every result block in `root`. Named results feed later ones,
 * in whatever order they appear; a loop or a missing name shows why. */
export function evaluateValues(root) {
  const scope = noteScope(root);
  const results = [...root.querySelectorAll(".note-value.result")].map(chip => ({ chip, spec: parseValueSource(chip.dataset.valueSource) }));
  for (const { spec } of results) if (spec.name) delete scope[spec.name];
  let pending = results;
  const errors = new Map();
  while (pending.length) {
    const next = [];
    for (const item of pending) {
      try {
        const value = evaluateFormula(item.spec.formula, scope);
        item.value = value;
        if (item.spec.name) scope[item.spec.name] = value;
      } catch (error) { errors.set(item, error.message); next.push(item); }
    }
    if (next.length === pending.length) break;
    pending = next;
  }
  for (const item of results) {
    const { chip, spec } = item;
    const out = chip.querySelector(".note-value-out");
    if (item.value !== undefined) {
      chip.limaResult = item.value;
      out.textContent = formatValue(item.value, spec.format);
      chip.removeAttribute("data-error");
      chip.title = `${spec.formula} — click to copy`;
      chip.setAttribute("aria-label", `${spec.name ? `${spec.name}: ` : ""}${out.textContent}. Copy`);
    } else {
      chip.limaResult = NaN;
      out.textContent = "?";
      chip.dataset.error = "true";
      const reason = errors.get(item) ?? "Can't compute";
      chip.title = /Nothing is named/.test(reason) && spec.name && reason.includes(`“${spec.name}”`) ? "This result uses itself" : `${reason} in “${spec.formula}”`;
      chip.setAttribute("aria-label", `${spec.name ? `${spec.name}: ` : ""}${chip.title}`);
    }
  }
}

/** Keeps `root`'s results live as values, calculators, checklists and tables change. */
export function wireValues(root) {
  if (root.limaValuesWired) { root.limaRecalc?.(); return; }
  root.limaValuesWired = true;
  // One pass: calculators first (they may read values), then results.
  // Calculators announce their own changes; a pass already running ignores them.
  const run = () => {
    if (root.limaRecalculating) return;
    root.limaRecalculating = true;
    try {
      for (const calculator of root.querySelectorAll(".calculator")) calculator.limaCompute?.();
      evaluateValues(root);
      // A calculator may read a named result computed just now.
      if (root.querySelector(".calculator") && root.querySelector(".note-value[data-result-name]")) {
        for (const calculator of root.querySelectorAll(".calculator")) calculator.limaCompute?.();
        evaluateValues(root);
      }
    } finally { root.limaRecalculating = false; }
  };
  let timer = 0;
  root.limaRecalc = run;
  root.addEventListener("lima-recalc", run);
  root.addEventListener("input", event => {
    if (event.target.closest?.(".calculator, .note-value")) queueMicrotask(run);
    // Typing in a table or ticking a to-do changes the note's facts.
    else { clearTimeout(timer); timer = setTimeout(run, 150); }
  });
  root.addEventListener("change", event => { if (event.target.matches?.("input[type=checkbox]")) queueMicrotask(run); });
  run();
}
