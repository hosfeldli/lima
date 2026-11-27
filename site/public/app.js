// lima.liamhosfeld.com: the live release details, and the demos, which play
// when they scroll into view (and stay still under Reduce Motion).
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

  /* The tour: the step in the middle of the screen sets the scene, which
     plays once at its own pace (scroll only chooses which). On phones each
     step carries its own copy of its scene. */
  const tour = $(".tour");
  if (tour) {
    const stage = $(".tour-stage", tour);
    const steps = $$(".tour-step", tour);
    const play = (node, scene) => {
      if (node.dataset.scene === scene && node.hasAttribute("data-play")) return;
      node.dataset.scene = scene;
      node.toggleAttribute("data-play", false);
      void node.offsetWidth; // restarts this scene's one-time animations
      node.toggleAttribute("data-play", true);
    };
    for (const step of steps) {
      const inline = stage.cloneNode(true);
      inline.classList.add("inline");
      inline.dataset.scene = step.dataset.scene;
      step.prepend(inline);
    }
    const setActive = step => {
      for (const other of steps) other.classList.toggle("is-active", other === step);
      play(stage, step.dataset.scene);
    };
    if ("IntersectionObserver" in window) {
      const pick = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) setActive(entry.target);
      }, { rootMargin: "-45% 0px -45% 0px" });
      for (const step of steps) pick.observe(step);
      const inlinePlay = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) play(entry.target, entry.target.dataset.scene);
      }, { threshold: .5 });
      for (const inline of $$(".tour-stage.inline", tour)) inlinePlay.observe(inline);
    }
    setActive(steps[0]);
  }

  /* Sections ease in as they arrive (content stays visible without JS). */
  if (!reduced && "IntersectionObserver" in window) {
    document.documentElement.classList.add("reveal-ready");
    const reveal = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add("seen"); reveal.unobserve(entry.target); }
    }, { rootMargin: "0px 0px -10% 0px" });
    for (const section of $$(".section")) {
      if (section.getBoundingClientRect().top < innerHeight) section.classList.add("seen");
      else reveal.observe(section);
    }
  }
})();
