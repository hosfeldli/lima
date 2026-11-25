// lima.liamhosfeld.com. The sidebar is the navigation: it follows the scroll,
// filters features, and its demo workspaces react to the demos on the page.
(() => {
  "use strict";
  const FEED = "https://storage.googleapis.com/lima-updates-940267100054/stable/latest.json";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const wait = ms => new Promise(resolve => setTimeout(resolve, reduced ? 0 : ms));

  /* Release: the signed feed's version. Lima verifies the signature itself. */
  fetch(FEED, { cache: "no-store" })
    .then(response => (response.ok ? response.json() : Promise.reject(response.status)))
    .then(feed => {
      if (!/^\d+\.\d+\.\d+$/.test(feed.version)) throw new Error("unexpected feed");
      const date = new Date(feed.publishedAt);
      const when = isNaN(date) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      if (document.documentElement.dataset.platform !== "other") $("#release").textContent = `Version ${feed.version}${when ? ` · ${when}` : ""} · Free · Apple Silicon · macOS 14 or later`;
      for (const node of $$("[data-version]")) node.textContent = `Version ${feed.version}`;
      const engine = String(feed.engine || "").replace(/^zen /i, "");
      if (engine) $("#engine").textContent = engine;
      $("#sums").href = FEED.replace(/latest\.json$/, `${feed.version}/SHA256SUMS`);
      $("#verify").hidden = false;
    })
    .catch(() => {
      // The download link still works: /download always points at the newest build.
    });

  /* Sidebar: the selected tab follows the section in view. */
  const tabs = $$("[data-tab]");
  const list = $(".features");
  const pill = document.createElement("span");
  pill.className = "selection";
  pill.setAttribute("aria-hidden", "true");
  list.prepend(pill);
  let current = "";
  function select(id) {
    if (id === current) return;
    current = id;
    for (const tab of tabs) {
      const on = tab.hash === `#${id}`;
      tab.toggleAttribute("aria-current", on);
      if (on) tab.setAttribute("aria-current", "true");
    }
    placePill();
    const active = tabs.find(tab => tab.hash === `#${id}`);
    // On narrow screens the strip scrolls the selected feature into view.
    if (active && list.scrollWidth > list.clientWidth) {
      list.scrollTo({ left: active.parentElement.offsetLeft - 12, behavior: reduced ? "auto" : "smooth" });
    }
  }
  function placePill() {
    const active = tabs.find(tab => tab.getAttribute("aria-current") === "true" && !tab.hidden);
    pill.style.opacity = active ? "1" : "0";
    if (active) pill.style.transform = `translateY(${active.parentElement.offsetTop}px)`;
  }
  const panes = $$(".pane");
  const spy = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible[0]) select(visible[0].target.id);
  }, { rootMargin: "-35% 0px -60% 0px" });
  panes.forEach(pane => spy.observe(pane));
  select(location.hash.slice(1) || "overview");
  addEventListener("resize", placePill);

  /* Demo workspaces in the sidebar. */
  // The demo that last claimed a row owns it; older demos stop updating it.
  const owners = {};
  const claim = id => (owners[id] = (owners[id] ?? 0) + 1);
  function workspace(id, state, label = "", token) {
    const row = $(`.ws[data-ws="${id}"]`);
    if (!row || (token !== undefined && token !== owners[id])) return;
    row.dataset.state = state;
    $(".ws-state", row).textContent = label;
    if (!reduced) { row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 900); }
  }

  /* Each demo plays when it scrolls into view, once per visit to it. */
  function whenSeen(node, play) {
    let running = false;
    new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && !running) { running = true; Promise.resolve(play()).finally(() => { running = false; }); }
      }
    }, { threshold: .45 }).observe(node);
  }

  /* Hero: Claude Code fixes the checkout total in its own tab. The tab's
   * dot, the agent line and the sidebar's Client Website row move together. */
  const handoff = $('[data-demo="handoff"]');
  const typed = $(".typed", handoff);
  const agentText = $(".agent-text", handoff);
  const dots = $$(".dot", handoff);
  const diff = $(".agent-diff", handoff);
  const total = $(".now", handoff);
  let handedOff = false;
  const step = (state, text, phase) => {
    for (const dot of dots) dot.dataset.state = state;
    agentText.textContent = text;
    handoff.dataset.phase = phase;
    if (!reduced) agentText.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(.16, 1, .3, 1)" });
  };
  async function playHandoff() {
    if (handedOff) return;
    handedOff = true;
    const text = typed.dataset.text;
    handoff.dataset.phase = "typing";
    if (reduced) typed.textContent = text;
    else for (let i = 1; i <= text.length; i++) { typed.textContent = text.slice(0, i); await wait(text[i - 1] === " " ? 50 : 28); }
    await wait(450);
    const token = claim("client");
    step("working", "Claude Code · Reading checkout.ts", "reading");
    workspace("client", "working", "Reading checkout.ts", token);
    await wait(1500);
    step("working", "Claude Code · Editing total.ts", "editing");
    diff.hidden = false;
    workspace("client", "working", "Editing total.ts", token);
    await wait(1600);
    step("working", "Claude Code · Reloading the page", "reloading");
    await wait(700);
    total.textContent = "$72.00";
    handoff.dataset.fixed = "";
    workspace("client", "working", "Running tests", token);
    step("working", "Claude Code · Running npm test", "testing");
    await wait(1700);
    step("complete", "Done · the discount applies · 48 tests passed", "done");
    workspace("client", "complete", "Done", token);
  }
  if (reduced) playHandoff();
  else setTimeout(() => whenSeen(handoff, playHandoff), 500);

  /* Not on a Mac: the download button offers to send the link to one. */
  const mac = /Macintosh|Mac OS X/.test(navigator.userAgent) && navigator.maxTouchPoints < 2;
  if (!mac) {
    document.documentElement.dataset.platform = "other";
    for (const note of $$("[data-platform-note]")) note.textContent = "Lima is for Macs with Apple Silicon. Send yourself the link.";
    for (const link of $$("[data-download]")) {
      const label = [...link.childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
      if (label) label.textContent = link.classList.contains("download-compact") ? "Get it" : "Send to my Mac";
      link.addEventListener("click", async event => {
        event.preventDefault();
        const url = `${location.origin}/`;
        try {
          if (navigator.share) await navigator.share({ title: "Lima for Mac", url });
          else { await navigator.clipboard.writeText(url); if (label) label.textContent = "Link copied"; }
        } catch {}
      });
    }
  }

  /* Agent chat: the steps stream in. */
  const chat = $('[data-demo="chat"]');
  const sequence = [...$$(".steps li", chat), $(".bubble.agent", chat), $(".report", chat)];
  async function playChat() {
    if (reduced) return;
    for (const node of sequence) node.hidden = true;
    for (const node of sequence) {
      await wait(node.classList.contains("bubble") ? 900 : 650);
      node.hidden = false;
      node.animate([{ opacity: 0, transform: "translateY(6px)", filter: "blur(2px)" }, { opacity: 1, transform: "none", filter: "none" }],
        { duration: 420, easing: "cubic-bezier(.16, 1, .3, 1)" });
    }
  }
  let chatPlayed = false;
  whenSeen(chat, () => { if (!chatPlayed) { chatPlayed = true; return playChat(); } });
  $('[data-replay="chat"]').addEventListener("click", playChat);

  /* Approval: the card waits for the visitor. */
  const card = $(".approval-card");
  const result = $(".approval-result", card);
  whenSeen(card, () => { if (card.dataset.state === "open") workspace("client", "blocked", "Needs you", claim("client")); });
  for (const button of $$("[data-answer]", card)) {
    button.addEventListener("click", async () => {
      const allow = button.dataset.answer === "allow";
      card.dataset.state = "answered";
      card.dataset.answer = button.dataset.answer;
      result.replaceChildren(Object.assign(document.createElement("span"), {
        textContent: allow ? "Approved. Client Website picks up where it stopped…" : "Declined. The agent won't do it or look for a workaround.",
      }));
      const token = claim("client");
      workspace("client", allow ? "working" : "idle", allow ? "Publishing" : "", token);
      if (!allow) return resetLater();
      await wait(1600);
      result.firstChild.textContent = "Published v2.4.1 · the agent reported back in its chat.";
      workspace("client", "complete", "Done", token);
      resetLater();
    });
  }
  function resetLater() {
    setTimeout(() => {
      const again = document.createElement("button");
      again.type = "button";
      again.className = "button ghost again";
      again.textContent = "Ask again";
      again.addEventListener("click", () => { card.dataset.state = "open"; delete card.dataset.answer; result.replaceChildren(); workspace("client", "blocked", "Needs you", claim("client")); $('[data-answer="allow"]', card).focus(); });
      result.append(" ", again);
    }, reduced ? 0 : 900);
  }

  /* Search: a working recreation over demo results. */
  const RESULTS = [
    { kind: "tab", title: "Checkout · Client Website", sub: "localhost:3000/checkout · open tab", icon: "i-globe" },
    { kind: "workspace", title: "Client Website", sub: "Workspace · Claude Code · working", icon: "i-agent" },
    { kind: "note", title: "Payment edge cases", sub: "Note · Client Website", icon: "i-note" },
    { kind: "tab", title: "Stripe Docs: Discounts", sub: "docs.stripe.com · open tab", icon: "i-globe" },
    { kind: "workspace", title: "Lima Browser", sub: "Workspace · Codex · running tests", icon: "i-agent" },
    { kind: "note", title: "Japan trip packing list", sub: "Note · Japan Trip", icon: "i-note" },
    { kind: "tab", title: "Flights to Tokyo", sub: "google.com/travel · history", icon: "i-globe" },
    { kind: "note", title: "Weekly report: Nov 21", sub: "Note · Friday report", icon: "i-note" },
  ];
  const input = $("#search-try");
  const resultsList = $("#search-results");
  let scope = "all";
  let selected = 0;
  const ICON = id => `<svg class="icon" aria-hidden="true"><use href="#${id}"/></svg>`;
  const escape = text => text.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const highlight = (text, query) => {
    if (!query) return escape(text);
    const at = text.toLowerCase().indexOf(query);
    return at < 0 ? escape(text) : `${escape(text.slice(0, at))}<mark>${escape(text.slice(at, at + query.length))}</mark>${escape(text.slice(at + query.length))}`;
  };
  function renderSearch() {
    const query = input.value.trim().toLowerCase();
    const hits = RESULTS.filter(row => (scope === "all" || row.kind === scope) && (!query || `${row.title} ${row.sub}`.toLowerCase().includes(query)));
    const rows = [];
    if (scope === "all" || scope === "web") {
      rows.push({ title: query ? `Search the web for “${input.value.trim()}”` : "Search the web, open something, or ask Lima", sub: "Your search engine", icon: "i-search", head: "Best Match" });
      if (query.length > 3) rows.push({ title: `Ask Lima: ${input.value.trim()}`, sub: "Answer streams here · ⌘↩ hands it to an agent", icon: "i-sparkle" });
    }
    if (scope !== "web") hits.slice(0, 6).forEach((row, index) => rows.push({ ...row, head: index === 0 ? "Your Browser & Lima" : undefined }));
    selected = Math.min(selected, Math.max(rows.length - 1, 0));
    resultsList.innerHTML = rows.length
      ? rows.map((row, index) => `${row.head ? `<li class="heading" role="presentation">${row.head}</li>` : ""}<li class="r" role="option" aria-selected="${index === selected}" data-index="${index}">${ICON(row.icon)}<span class="r-text"><span class="r-title">${highlight(row.title, query)}</span><span class="r-sub">${escape(row.sub)}</span></span><kbd>↩</kbd></li>`).join("")
      : `<li class="empty">Nothing in ${escape(scope)}s matches. Lima would search the web instead.</li>`;
    resultsList.setAttribute("role", "listbox");
  }
  input.addEventListener("input", () => { selected = 0; renderSearch(); });
  input.addEventListener("keydown", event => {
    const count = $$(".r", resultsList).length;
    if (event.key === "ArrowDown") { event.preventDefault(); selected = (selected + 1) % Math.max(count, 1); renderSearch(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); selected = (selected - 1 + count) % Math.max(count, 1); renderSearch(); }
    else if (event.key === "Escape") { input.value = ""; renderSearch(); }
    else if (/^[1-5]$/.test(event.key) && event.metaKey) { event.preventDefault(); $$(".scopes button")[Number(event.key) - 1].click(); }
  });
  resultsList.addEventListener("mousemove", event => {
    const row = event.target.closest(".r");
    if (row && Number(row.dataset.index) !== selected) {
      selected = Number(row.dataset.index);
      for (const node of $$(".r", resultsList)) node.setAttribute("aria-selected", String(node === row));
    }
  });
  for (const button of $$(".scopes button")) {
    button.addEventListener("click", () => {
      scope = button.dataset.scope;
      for (const other of $$(".scopes button")) other.setAttribute("aria-selected", String(other === button));
      selected = 0;
      renderSearch();
    });
  }
  renderSearch();
  // It types a query itself the first time, until the visitor takes over.
  let searchTouched = false;
  input.addEventListener("focus", () => { searchTouched = true; });
  whenSeen($('[data-demo="search"]'), async () => {
    if (searchTouched || input.value) return;
    for (const ch of "checkout") {
      if (searchTouched) return;
      input.value += ch;
      renderSearch();
      await wait(110);
    }
  });

  /* Sections reveal as they arrive (content stays visible without JS). */
  if (!reduced && "IntersectionObserver" in window) {
    document.documentElement.classList.add("reveal-ready");
    const reveal = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add("seen"); reveal.unobserve(entry.target); }
    }, { rootMargin: "0px 0px -12% 0px" });
    panes.forEach(pane => {
      if (pane.getBoundingClientRect().top < innerHeight) pane.classList.add("seen");
      else reveal.observe(pane);
    });
  }
})();
