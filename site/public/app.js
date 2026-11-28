// lima.liamhosfeld.com: the live release details, the demos (which play when
// their slide appears, and stay still under Reduce Motion), and the page as
// click-through slides like Lima's own walkthrough.
(() => {
  "use strict";
  const FEED = "https://storage.googleapis.com/lima-updates-940267100054/stable/latest.json";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const wait = ms => new Promise(resolve => setTimeout(resolve, reduced ? 0 : ms));
  const svgIcon = name => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  };

  /* The site's CSP (style-src 'self') ignores style="" attributes in the
     markup, which carry the scenes' stagger (--i) and orbit angles (--a).
     Setting them through the CSSOM is allowed, so apply them here. */
  for (const node of $$("[style]")) node.style.cssText = node.getAttribute("style");

  /* Release: the version, date and size from the signed update feed. */
  fetch(FEED, { cache: "no-store" })
    .then(response => (response.ok ? response.json() : Promise.reject(response.status)))
    .then(feed => {
      if (!/^\d+\.\d+\.\d+$/.test(feed.version)) throw new Error("unexpected feed");
      const date = new Date(feed.publishedAt);
      const when = isNaN(date) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      const release = $("#release");
      if (release && document.documentElement.dataset.platform !== "other") {
        release.textContent = `Version ${feed.version}${when ? `, ${when}` : ""} · Free and open source · No Lima account · Apple Silicon · macOS 14 or later`;
      }
      for (const node of $$("[data-version]")) node.textContent = `Version ${feed.version}`;
      for (const node of $$("[data-version-plain]")) node.textContent = `${feed.version}${when ? ` (${when})` : ""}`;
      if (Number.isFinite(feed.bytes)) for (const node of $$("[data-size]")) node.textContent = `${Math.round(feed.bytes / 1e6)} MB`;
      for (const node of $$("[data-sums]")) { node.href = FEED.replace(/latest\.json$/, `${feed.version}/SHA256SUMS`); node.hidden = false; }
      for (const node of $$("[data-notes]")) node.href = `https://github.com/hosfeldli/lima/releases/tag/v${feed.version}`;
    })
    .catch(() => { /* The download still works: /download/mac always points at the newest build. */ });

  /* Not on a Mac: the download buttons offer to send the link to one. */
  const mac = /Macintosh|Mac OS X/.test(navigator.userAgent) && navigator.maxTouchPoints < 2;
  if (!mac) {
    document.documentElement.dataset.platform = "other";
    for (const note of $$("[data-platform-note]")) note.textContent = "Lima is for Macs with Apple Silicon. Send yourself the link.";
    for (const link of $$("[data-download]")) {
      const label = [...link.childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
      if (label) label.textContent = "Send to my Mac";
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

  /* Each demo plays when it scrolls into view. */
  function whenSeen(node, play) {
    if (!node) return;
    let running = false;
    new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && !running) { running = true; Promise.resolve(play()).finally(() => { running = false; }); }
      }
    }, { threshold: .4 }).observe(node);
  }
  const appear = node => node.animate?.([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
    { duration: 380, easing: "cubic-bezier(.16, 1, .3, 1)" });

  /* The session: an agent works through a task in its own workspace. */
  const TASKS = {
    trip: {
      workspace: "Japan Trip", ask: "Find a quiet hotel in Kyoto for March 14–18, under $250 a night.",
      steps: [
        { tab: ["globe", "Hotels in Kyoto"], url: "booking.example/kyoto", page: "Kyoto hotels · March 14–18", step: ["search", "Searched hotels in Kyoto"] },
        { tab: ["globe", "Gion · reviews"], url: "reviews.example/gion-ryokan", page: "Gion Ryokan · 412 reviews", step: ["globe", "Read reviews for 6 hotels"] },
        { tab: ["globe", "Map · Higashiyama"], url: "maps.example/higashiyama", page: "Quiet streets near Higashiyama", step: ["globe", "Checked each location on the map"] },
        { tab: ["note", "Kyoto shortlist"], url: "Lima note", page: "Kyoto shortlist", step: ["note", "Wrote a shortlist of 3 hotels"] },
      ],
      approval: "Reserve Gion Ryokan for $214 a night? (free cancellation)",
      done: "Shortlist ready. Reservation waits for your OK.",
    },
    site: {
      workspace: "Client Website", ask: "The checkout total is wrong when a gift card is used. Fix it and run the tests.",
      steps: [
        { tab: ["globe", "localhost:3000/checkout"], url: "localhost:3000/checkout", page: "Checkout · total $41.80", step: ["globe", "Reproduced the bug in the browser"] },
        { tab: ["file", "total.ts"], url: "src/checkout/total.ts", page: "total.ts", step: ["pencil", "Edited total.ts (+12 −3)"] },
        { tab: ["terminal", "npm test"], url: "Terminal", page: "48 tests passed", step: ["terminal", "Ran the tests: 48 passed"] },
        { tab: ["globe", "localhost:3000/checkout"], url: "localhost:3000/checkout", page: "Checkout · total $36.80", step: ["check", "Checked the fixed total in the browser"] },
      ],
      approval: "Push the fix to GitHub and open a pull request?",
      done: "Fixed and tested. The pull request waits for your OK.",
    },
    research: {
      workspace: "Heat Pumps", ask: "Compare heat pumps for a 1,800 sq ft house and draft a short report.",
      steps: [
        { tab: ["search", "Heat pump efficiency"], url: "energy.example/heat-pumps", page: "Heat pump efficiency, explained", step: ["search", "Found 9 sources"] },
        { tab: ["globe", "Rebates 2026"], url: "rebates.example/2026", page: "2026 rebates by state", step: ["globe", "Checked current rebates"] },
        { tab: ["folder", "Sources"], url: "Workspace folder", page: "Sources, sorted into folders", step: ["folder", "Filed the sources into folders"] },
        { tab: ["note", "Heat pump report"], url: "Lima note", page: "Heat pump report · draft", step: ["note", "Drafted a two-page report"] },
      ],
      approval: null,
      done: "Report drafted in a note, with every source linked.",
    },
  };
  const session = $('[data-demo="session"]');
  if (session) {
    const view = {
      name: $(".lw-ws-name", session), state: $(".lw-ws-state", session), dot: $(".lw-ws .dot", session), tabs: $(".lw-tabs", session),
      url: $(".lw-url span", session), title: $(".lw-page-title", session), ask: $(".lw-ask", session), steps: $(".lw-steps", session),
      approval: $(".lw-approval", session), question: $(".lw-approval-q", session), done: $(".lw-done", session),
    };
    let task = "trip";
    let run = 0;
    const setState = (state, label) => { view.dot.dataset.state = state; view.state.textContent = label; };
    async function play() {
      const token = ++run;
      const spec = TASKS[task];
      view.name.textContent = spec.workspace;
      view.tabs.replaceChildren();
      view.steps.replaceChildren();
      view.approval.hidden = true;
      view.done.hidden = true;
      view.url.textContent = "";
      view.title.textContent = "";
      view.ask.textContent = spec.ask;
      setState("working", "Working");
      for (const [index, item] of spec.steps.entries()) {
        await wait(index ? 1300 : 700);
        if (token !== run) return;
        for (const row of view.tabs.children) row.removeAttribute("aria-current");
        const row = document.createElement("li");
        row.setAttribute("aria-current", "true");
        const label = document.createElement("span");
        label.textContent = item.tab[1];
        row.append(svgIcon(item.tab[0]), label);
        view.tabs.append(row);
        view.url.textContent = item.url;
        view.title.textContent = item.page;
        appear(view.title);
        for (const step of view.steps.children) step.removeAttribute("data-live");
        const step = document.createElement("li");
        step.dataset.live = "";
        const text = document.createElement("span");
        text.textContent = item.step[1];
        step.append(svgIcon(item.step[0]), text);
        view.steps.append(step);
      }
      await wait(1100);
      if (token !== run) return;
      for (const step of view.steps.children) step.removeAttribute("data-live");
      if (spec.approval) {
        view.question.textContent = spec.approval;
        view.approval.hidden = false;
        setState("blocked", "Needs you");
      } else finish(token);
    }
    function finish(token, text) {
      if (token !== run) return;
      view.approval.hidden = true;
      $("span", view.done).textContent = text ?? TASKS[task].done;
      view.done.hidden = false;
      setState("complete", "Done");
    }
    for (const button of $$("[data-answer]", view.approval)) {
      button.addEventListener("click", () => finish(run, button.dataset.answer === "allow"
        ? "Approved. The agent finished the step and reported back." : "Declined. The agent won't do it, and the rest of its work is saved."));
    }
    for (const tab of $$("[data-task]", session)) {
      tab.addEventListener("click", () => {
        task = tab.dataset.task;
        for (const other of $$("[data-task]", session)) other.setAttribute("aria-selected", String(other === tab));
        play();
      });
    }
    $('[data-replay="session"]').addEventListener("click", play);
    let seen = false;
    whenSeen(session, () => { if (!seen) { seen = true; return play(); } });
    if (reduced) play();
  }

  /* Agent chat: the steps stream in. */
  const chat = $('[data-demo="chat"]');
  if (chat) {
    const sequence = [...$$(".steps li", chat), $(".bubble.agent", chat), $(".report", chat)];
    async function playChat() {
      if (reduced) return;
      for (const node of sequence) node.hidden = true;
      for (const node of sequence) {
        await wait(node.classList.contains("bubble") ? 900 : 650);
        node.hidden = false;
        appear(node);
      }
    }
    let played = false;
    whenSeen(chat, () => { if (!played) { played = true; return playChat(); } });
    $('[data-replay="chat"]').addEventListener("click", playChat);
  }

  /* Approval: the card waits for the visitor. */
  const card = $(".approval-card");
  if (card) {
    const result = $(".approval-result", card);
    for (const button of $$("[data-answer]", card)) {
      button.addEventListener("click", async () => {
        const allow = button.dataset.answer === "allow";
        card.dataset.state = "answered";
        card.dataset.answer = button.dataset.answer;
        result.replaceChildren(Object.assign(document.createElement("span"), {
          textContent: allow ? "Approved. Client Website picks up where it stopped…" : "Declined. The agent won't do it or look for a workaround.",
        }));
        if (allow) { await wait(1600); result.firstChild.textContent = "Published v2.4.1 · the agent reported back in its chat."; }
        setTimeout(() => {
          const again = document.createElement("button");
          again.type = "button";
          again.className = "button ghost again";
          again.textContent = "Ask again";
          again.addEventListener("click", () => { card.dataset.state = "open"; delete card.dataset.answer; result.replaceChildren(); $('[data-answer="allow"]', card).focus(); });
          result.append(" ", again);
        }, reduced ? 0 : 900);
      });
    }
  }

  /* The tour: Lima's welcome walkthrough. One step at a time sets the
     scene, which plays once at its own pace. On phones each step carries
     its own copy of its scene. */
  const tour = $(".tour");
  const tourSteps = tour ? $$(".tour-step", tour) : [];
  let setTourStep = () => {};
  if (tour) {
    const stage = $(".tour-stage", tour);
    const play = (node, scene) => {
      if (node.dataset.scene === scene && node.hasAttribute("data-play")) return;
      node.dataset.scene = scene;
      node.toggleAttribute("data-play", false);
      void node.offsetWidth; // restarts this scene's one-time animations
      node.toggleAttribute("data-play", true);
    };
    for (const step of tourSteps) {
      const inline = stage.cloneNode(true);
      inline.classList.add("inline");
      inline.dataset.scene = step.dataset.scene;
      step.prepend(inline);
    }
    setTourStep = index => {
      const step = tourSteps[Math.max(0, Math.min(index, tourSteps.length - 1))];
      for (const other of tourSteps) other.classList.toggle("is-active", other === step);
      play(stage, step.dataset.scene);
      const inline = $(".tour-stage.inline", step);
      if (inline) play(inline, step.dataset.scene);
    };
    setTourStep(0);
  }

  /* The page as slides, like Lima's own walkthrough: Back and Continue,
     a progress strip, arrow keys, and a scroll or swipe flips to the next
     slide. A slide taller than the window scrolls first; only a fresh
     scroll at its edge flips, so a trackpad's momentum never skips a slide.
     Without JavaScript the page stays one long scroll. */
  const main = $("main");
  if (main && !matchMedia("print").matches) {
    const root = document.documentElement;
    root.classList.add("deck");
    const foot = $("footer.foot");
    const sections = [...main.children].filter(node => node.matches("section"));
    const slides = sections.map((section, index) => {
      const slide = document.createElement("div");
      slide.className = "slide";
      slide.tabIndex = -1;
      slide.setAttribute("role", "group");
      slide.setAttribute("aria-roledescription", "slide");
      const heading = $("h1, h2", section);
      slide.setAttribute("aria-label", `${index + 1} of ${sections.length}${heading ? `: ${heading.textContent.trim()}` : ""}`);
      section.before(slide);
      slide.append(section);
      return slide;
    });
    if (foot) slides.at(-1).append(foot);
    // Each stop is a slide, or one step of the tour inside its slide.
    const stops = slides.flatMap((slide, index) => $(".tour", slide) && tourSteps.length
      ? tourSteps.map((_, step) => ({ index, step })) : [{ index, step: null }]);

    const label = (slide, index) => $(".eyebrow", slide)?.textContent.trim() || $("h1, h2", slide)?.textContent.trim() || `Part ${index + 1}`;
    const nav = document.createElement("nav");
    nav.className = "deck-nav";
    nav.setAttribute("aria-label", "Slides");
    const back = Object.assign(document.createElement("button"), { type: "button", className: "button ghost deck-back", textContent: "Back" });
    const next = Object.assign(document.createElement("button"), { type: "button", className: "button primary deck-next", textContent: "Continue" });
    const progress = document.createElement("ol");
    progress.className = "deck-progress";
    for (const [index, slide] of slides.entries()) {
      const item = document.createElement("li");
      const dot = Object.assign(document.createElement("button"), { type: "button", className: "deck-dot" });
      dot.setAttribute("aria-label", `Go to ${label(slide, index)}`);
      dot.append(document.createElement("span"));
      dot.addEventListener("click", () => go(stops.findIndex(stop => stop.index === index), { focus: true }));
      item.append(dot);
      progress.append(item);
    }
    const live = Object.assign(document.createElement("p"), { className: "deck-live" });
    live.setAttribute("aria-live", "polite");
    nav.append(back, progress, next, live);
    document.body.append(nav);

    // The slides fill the space between the top bar and the bottom bar.
    const fit = () => {
      root.style.setProperty("--deck-top", `${$(".topbar")?.offsetHeight ?? 61}px`);
      root.style.setProperty("--deck-bottom", `${nav.offsetHeight}px`);
    };
    fit();
    addEventListener("resize", fit);

    let current = -1;
    let animating = null;
    const DURATION = reduced ? 0 : 440;
    const show = (stop, { direction = 1, focus = false, instant = false } = {}) => {
      const target = stops[stop];
      const before = stops[current];
      const incoming = slides[target.index];
      const outgoing = before && slides[before.index];
      current = stop;
      if (target.step !== null) setTourStep(target.step);
      if (outgoing !== incoming) {
        animating?.();
        for (const slide of slides) if (slide !== outgoing) { slide.hidden = slide !== incoming; slide.inert = slide !== incoming; }
        incoming.scrollTop = direction > 0 || target.step !== null ? 0 : incoming.scrollHeight;
        if (outgoing && !instant && DURATION) {
          outgoing.inert = true;
          incoming.dataset.enter = direction > 0 ? "next" : "prev";
          outgoing.dataset.leave = direction > 0 ? "next" : "prev";
          const timer = setTimeout(() => (animating = null, settle()), DURATION);
          const settle = () => { outgoing.hidden = true; delete outgoing.dataset.leave; delete incoming.dataset.enter; };
          animating = () => { clearTimeout(timer); settle(); animating = null; };
        } else if (outgoing) { outgoing.hidden = true; outgoing.inert = true; }
      }
      // Progress, buttons and the address.
      for (const [index, item] of [...progress.children].entries()) {
        item.dataset.state = index < target.index ? "done" : index === target.index ? "current" : "";
        const dot = item.firstChild;
        if (index === target.index) dot.setAttribute("aria-current", "step"); else dot.removeAttribute("aria-current");
        if (index === target.index) item.style.setProperty("--fill", target.step === null ? 1 : (target.step + 1) / tourSteps.length);
      }
      back.disabled = stop === 0;
      const last = stop === stops.length - 1;
      // On the last slide Continue gives way but keeps its place, so the
      // progress strip doesn't shift.
      next.style.visibility = last ? "hidden" : "";
      next.disabled = last;
      next.textContent = stop === 0 ? "Take the tour" : target.step !== null && target.step < tourSteps.length - 1 ? "Next step" : "Continue";
      const id = incoming.firstElementChild?.id;
      history.replaceState(null, "", id && target.index ? `#${id}` : location.pathname + location.search);
      for (const link of $$(".topnav a")) {
        if (link.getAttribute("href") === `#${id}`) link.setAttribute("aria-current", "true"); else link.removeAttribute("aria-current");
      }
      live.textContent = target.step !== null ? $(".step-eyebrow", tourSteps[target.step])?.textContent ?? "" : incoming.getAttribute("aria-label");
      if (focus) incoming.focus({ preventScroll: true });
    };
    const go = (stop, options = {}) => {
      if (stop < 0 || stop >= stops.length || stop === current) return false;
      show(stop, { direction: stop > current ? 1 : -1, ...options });
      return true;
    };
    back.addEventListener("click", () => go(current - 1, { focus: true }));
    next.addEventListener("click", () => go(current + 1, { focus: true }));

    // Links within the page go to their slide.
    const stopFor = hash => {
      if (!hash || hash === "#" || hash === "#top") return 0;
      let target = null;
      try { target = document.getElementById(decodeURIComponent(hash.slice(1))); } catch {}
      const slide = target?.closest(".slide");
      return slide ? stops.findIndex(stop => stop.index === slides.indexOf(slide)) : -1;
    };
    document.addEventListener("click", event => {
      const link = event.target.closest?.('a[href^="#"]');
      if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const stop = stopFor(link.getAttribute("href"));
      if (stop < 0) return;
      event.preventDefault();
      go(stop, { focus: true });
    });

    // A slide scrolls on its own until its edge; return whether it can.
    const scrollable = (node, dy) => {
      for (let el = node; el && el !== document.body; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (!/(auto|scroll)/.test(style.overflowY) || el.scrollHeight <= el.clientHeight + 1) { if (el.classList.contains("slide")) break; continue; }
        if (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 2 : el.scrollTop > 2) return true;
        if (el.classList.contains("slide")) break;
      }
      return false;
    };
    const editing = node => node?.closest?.("input, textarea, select, [contenteditable], summary, .search-input");

    // Wheel and trackpad: one flip per gesture. A gesture that scrolled the
    // slide, or arrived mid-flip, never flips; the next one (after the wheel
    // has been quiet briefly, so momentum has ended) can.
    let gathered = 0, lastWheel = 0, spent = false;
    addEventListener("wheel", event => {
      if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      const now = performance.now();
      if (now - lastWheel > 180) { gathered = 0; spent = false; }
      lastWheel = now;
      const dy = event.deltaY * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? innerHeight : 1);
      if (scrollable(event.target, dy)) { spent = true; return; }
      event.preventDefault();
      if (spent || animating) { spent = true; return; }
      gathered += dy;
      if (Math.abs(gathered) < 36) return;
      spent = go(current + Math.sign(gathered));
      gathered = 0;
    }, { passive: false });

    // Keys: arrows, Page Up/Down, Space and Home/End, like the walkthrough.
    addEventListener("keydown", event => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || editing(event.target)) return;
      if (event.key === " " && event.target.closest?.("button, a")) return; // Space presses the focused button
      const slide = slides[stops[current].index];
      const down = ["ArrowDown", "PageDown"].includes(event.key) || (event.key === " " && !event.shiftKey);
      const up = ["ArrowUp", "PageUp"].includes(event.key) || (event.key === " " && event.shiftKey);
      let move = 0;
      if (event.key === "ArrowRight") move = 1;
      else if (event.key === "ArrowLeft") move = -1;
      else if (down && !scrollable(slide, 1)) move = 1;
      else if (up && !scrollable(slide, -1)) move = -1;
      else if (event.key === "Home") { event.preventDefault(); go(0, { focus: true }); return; }
      else if (event.key === "End") { event.preventDefault(); go(stops.length - 1, { focus: true }); return; }
      if (!move) return;
      event.preventDefault();
      go(current + move, { focus: true });
    });

    // Swipes: up or left for the next slide once the slide is at its edge.
    let touch = null;
    addEventListener("touchstart", event => {
      const point = event.touches[0];
      touch = { x: point.clientX, y: point.clientY, top: slides[stops[current].index].scrollTop, target: event.target };
    }, { passive: true });
    addEventListener("touchend", event => {
      if (!touch || animating) return;
      const point = event.changedTouches[0];
      const dx = touch.x - point.clientX, dy = touch.y - point.clientY;
      const slide = slides[stops[current].index];
      const moved = Math.abs(slide.scrollTop - touch.top) > 4;
      const start = touch;
      touch = null;
      if (moved || editing(start.target)) return;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) go(current + Math.sign(dx));
      else if (Math.abs(dy) > 60 && !scrollable(slide, dy)) go(current + Math.sign(dy));
    }, { passive: true });

    addEventListener("hashchange", () => { const stop = stopFor(location.hash); if (stop >= 0) go(stop); });
    const first = stopFor(location.hash);
    show(first >= 0 ? first : 0, { instant: true });
  }
})();
