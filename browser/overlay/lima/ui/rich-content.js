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
    // Shown only inside a note being edited (CSS): change the numbers and formulas as JSON.
    article.append(node, el("button", { type: "button", class: "ghost artifact-edit", onclick: () => editArtifact(article, kind, source, el) }, "Edit"));
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

/** Swaps a block for its JSON in a text box; Save re-renders it in place. */
function editArtifact(article, kind, source, el) {
  let pretty = source;
  try { pretty = JSON.stringify(JSON.parse(source), null, 2); } catch {}
  const box = el("textarea", { class: "artifact-source", rows: Math.min(18, pretty.split("\n").length + 1), spellcheck: "false", "aria-label": "Calculator settings" });
  box.value = pretty;
  const error = el("p", { class: "artifact-error", role: "alert", hidden: true });
  const save = () => {
    let next;
    try { next = JSON.stringify(JSON.parse(box.value)); } catch { error.hidden = false; error.textContent = "That isn't valid JSON yet."; return; }
    const fresh = artifactFromBlock(kind, next, el);
    if (!fresh) { error.hidden = false; error.textContent = "Add at least one input (id, label, value) and one row (label, value)."; return; }
    article.replaceWith(fresh);
    fresh.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const original = [...article.childNodes];
  article.replaceChildren(
    el("p", { class: "artifact-hint", text: "Inputs are number boxes (id, label, value). Each row's value is a formula using input ids, such as 250 * servings / 4." }),
    box, error,
    el("div", { class: "row" }, el("button", { type: "button", class: "primary", onclick: save }, "Save"),
      el("button", { type: "button", class: "ghost", onclick: () => article.replaceChildren(...original) }, "Cancel")));
  box.focus();
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

/* Calculators: number boxes and rows computed from them, such as a recipe
 * whose ingredients scale with the servings you enter. Formulas are plain
 * arithmetic read by a small parser (no script runs): numbers, the ids of
 * inputs and earlier rows, + − × ÷ % ^, parentheses, and round, ceil,
 * floor, min, max, abs and sqrt. */
const CALC_FUNCTIONS = {
  round: (x, digits = 0) => { const f = 10 ** Math.max(0, Math.min(6, Math.trunc(digits))); return Math.round(x * f) / f; },
  ceil: Math.ceil, floor: Math.floor, min: Math.min, max: Math.max, abs: Math.abs, sqrt: Math.sqrt,
};

export function evaluateFormula(source, scope) {
  const text = String(source ?? "");
  if (!text.trim() || text.length > 300) throw new Error("formula");
  const tokens = [];
  const pattern = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/%^(),×÷]))/y;
  let match;
  while (pattern.lastIndex < text.length && (match = pattern.exec(text))) {
    if (match[1] !== undefined) tokens.push({ number: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ name: match[2] });
    else tokens.push({ op: match[3] === "×" ? "*" : match[3] === "÷" ? "/" : match[3] });
    if (tokens.length > 200) throw new Error("formula");
  }
  if (text.slice(pattern.lastIndex).trim()) throw new Error("formula");
  let at = 0;
  const peek = () => tokens[at];
  const take = op => (peek()?.op === op ? (at++, true) : false);
  const expect = op => { if (!take(op)) throw new Error("formula"); };
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
    if (!token) throw new Error("formula");
    if (token.number !== undefined) return token.number;
    if (token.op === "(") { const value = expression(); expect(")"); return value; }
    if (token.name !== undefined) {
      if (peek()?.op === "(") {
        const fn = Object.hasOwn(CALC_FUNCTIONS, token.name) ? CALC_FUNCTIONS[token.name] : null;
        if (!fn) throw new Error("formula");
        at++;
        const args = [];
        if (!take(")")) { do args.push(expression()); while (take(",")); expect(")"); }
        return fn(...args);
      }
      if (!Object.hasOwn(scope, token.name)) throw new Error("formula");
      return scope[token.name];
    }
    throw new Error("formula");
  }
  const value = expression();
  if (at !== tokens.length || !Number.isFinite(value)) throw new Error("formula");
  return value;
}

const CALC_ID = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** The calculator's own state from its JSON, or null when it's unusable. */
export function calculatorSpec(spec) {
  const inputs = (Array.isArray(spec.inputs) ? spec.inputs : []).slice(0, 8).filter(input => CALC_ID.test(input?.id ?? "")).map(input => ({
    id: input.id, label: typeof input.label === "string" ? input.label.slice(0, 80) : input.id,
    value: Number.isFinite(input.value) ? input.value : 1,
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
  const boxes = calc.inputs.map(input => el("input", { type: "number", value: String(input.value), step: String(input.step),
    ...(input.min !== undefined ? { min: String(input.min) } : {}), ...(input.max !== undefined ? { max: String(input.max) } : {}),
    "aria-label": input.label, oninput: () => compute() }));
  function compute() {
    const scope = {};
    calc.inputs.forEach((input, index) => {
      const value = Number(boxes[index].value);
      scope[input.id] = Number.isFinite(value) && boxes[index].value !== "" ? value : input.value;
    });
    calc.rows.forEach((row, index) => {
      try {
        const value = evaluateFormula(row.formula, scope);
        if (row.id) scope[row.id] = value;
        outputs[index].textContent = formatNumber(value, row.decimals);
        outputs[index].removeAttribute("data-error");
      } catch {
        outputs[index].textContent = "—";
        outputs[index].dataset.error = "true";
        outputs[index].title = `Can't read the formula “${row.formula}”`;
      }
    });
  }
  const node = el("div", { class: "calculator" },
    el("div", { class: "calc-inputs" }, calc.inputs.map((input, index) =>
      el("label", { class: "calc-input" }, el("span", { text: input.label }), boxes[index], input.unit ? el("span", { class: "calc-unit", text: input.unit }) : null))),
    el("table", { class: "calc-rows" }, el("tbody", {}, calc.rows.map((row, index) =>
      el("tr", {}, el("th", { scope: "row", text: row.label }), el("td", {}, outputs[index], row.unit ? el("span", { class: "calc-unit", text: ` ${row.unit}` }) : null))))),
    calc.note ? el("p", { class: "calc-note", text: calc.note }) : null);
  compute();
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
