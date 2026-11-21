// Shows the release the signed feed currently points at. The feed's
// signature is checked by Lima itself; this page only displays it.
(() => {
  const FEED = "https://storage.googleapis.com/lima-updates-940267100054/stable/latest.json";
  const button = document.getElementById("download");
  const release = document.getElementById("release");

  fetch(FEED, { cache: "no-store" })
    .then(response => (response.ok ? response.json() : Promise.reject(response.status)))
    .then(feed => {
      if (!/^\d+\.\d+\.\d+$/.test(feed.version)) throw new Error("unexpected feed");
      const date = new Date(feed.publishedAt);
      const when = isNaN(date) ? "" : ` · ${date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`;
      release.textContent = `Version ${feed.version}${when}`;
      button.removeAttribute("aria-disabled");
      document.getElementById("engine").textContent = String(feed.engine || "").replace(/^zen /, "");
      document.getElementById("sums").href = FEED.replace(/latest\.json$/, `${feed.version}/SHA256SUMS`);
      document.getElementById("verify").hidden = false;
    })
    .catch(() => {
      release.textContent = "The first release is on its way. Check back soon.";
      button.textContent = "Coming soon";
      button.removeAttribute("href");
    });
})();
