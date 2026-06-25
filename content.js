// Content script. Facebook is a single-page app, so navigating Marketplace
// changes the URL without a reload. This script runs on all of facebook.com,
// watches (by pathname) for navigation, and shows the panel on Marketplace
// feed/search/category pages.

(function () {
  if (window.__mds_router) return;
  window.__mds_router = true;

  const ITEM_RE = /\/marketplace\/item\/(\d+)/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let matchedIds = new Set();
  let filtering = false;
  let lastKw = [];
  let escHandler = null;
  let feedThumbs = {};   // id -> the listing's own card image, captured during collection

  function isFeedPage() {
    const p = location.pathname;
    return /\/marketplace\b/.test(p) && !/\/marketplace\/item\//.test(p);
  }
  function withNewestSort(url) {
    try {
      const u = new URL(url, location.origin);
      // set (not append) — keeps latitude/longitude/radius and every other filter intact
      u.searchParams.set("sortBy", "creation_time_descend");
      return u.toString();
    } catch (_) {
      if (/sortBy=/.test(url)) return url;
      return url + (url.includes("?") ? "&" : "?") + "sortBy=creation_time_descend";
    }
  }

  const q = (sel) => document.querySelector(sel);
  function setStatus(t) { const s = q("#mds-status"); if (s) s.textContent = t; }
  function escapeHtml(s) {
    return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Brief overlay shown WHILE collecting listings, so the user doesn't watch the
  // page scroll to lazy-load (very noticeable on the tall map view).
  function showOverlay(t) {
    let o = document.getElementById("mds-overlay");
    if (!o) {
      o = document.createElement("div");
      o.id = "mds-overlay";
      o.innerHTML = '<div id="mds-overlay-box"><div class="mds-spin"></div><div id="mds-overlay-txt"></div></div>';
      document.documentElement.appendChild(o);
    }
    o.querySelector("#mds-overlay-txt").textContent = t || "";
    o.style.display = "flex";
  }
  function setOverlay(t) { const e = document.getElementById("mds-overlay-txt"); if (e) e.textContent = t; }
  function hideOverlay() { const o = document.getElementById("mds-overlay"); if (o) o.style.display = "none"; }

  // The single card cell wrapping one listing link (robust across layouts).
  function cardOf(a) {
    let el = a;
    while (el.parentElement) {
      if (el.parentElement.querySelectorAll("a[href*='/marketplace/item/']").length > 1) return el;
      el = el.parentElement;
    }
    return a;
  }

  async function collectIds(max) {
    const found = new Set();
    feedThumbs = {};
    const grab = () => document.querySelectorAll("a[href*='/marketplace/item/']")
      .forEach((a) => {
        const m = a.href.match(ITEM_RE);
        if (!m) return;
        found.add(m[1]);
        // capture the largest image WITHIN this listing's own card link, so the
        // thumbnail is always that listing's photo (never an ad elsewhere on the page)
        let best = "", bestA = 0;
        a.querySelectorAll("img").forEach((img) => {
          const s = img.currentSrc || img.src || "";
          if (!/^https?:/.test(s)) return;
          const ar = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
          if (ar >= bestA) { bestA = ar; best = s; }
        });
        if (best) feedThumbs[m[1]] = best;
      });
    const y0 = window.scrollY;
    grab();
    const needScroll = found.size < max;            // skip scrolling if we already have enough
    if (needScroll) showOverlay(`Loading listings… ${found.size} / ${max}`);
    let stable = 0;
    const start = Date.now();
    while (found.size < max && stable < 12 && Date.now() - start < 180000) {
      const before = found.size;
      window.scrollBy(0, Math.max(900, Math.floor(window.innerHeight * 0.9)));
      window.dispatchEvent(new Event("scroll"));
      setOverlay(`Loading listings… ${found.size} / ${max}`);
      setStatus(`Loading listings… found ${found.size} / ${max}`);
      await sleep(900);
      grab();
      stable = found.size === before ? stable + 1 : 0;
    }
    window.scrollTo(0, y0);
    if (needScroll) hideOverlay();
    return Array.from(found).slice(0, max);
  }

  function addResult(c) {
    const box = q("#mds-results");
    if (!box) return;
    const div = document.createElement("div");
    div.className = "mds-result";
    div.innerHTML = `<a href="${c.url}" target="_blank">${escapeHtml(c.title)}</a>
      <span class="mds-price">${escapeHtml(c.price || "")}</span>`;
    box.appendChild(div);
  }

  // In-feed match highlight: a border drawn INSIDE the card (a child element),
  // so it's clipped only by the card itself and shows on all four edges — unlike
  // a CSS outline, which an ancestor's overflow can clip.
  function badgeCard(card) {
    if (!card || card.querySelector(":scope > .mds-badge")) return;
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    const b = document.createElement("div");
    b.className = "mds-badge";
    card.appendChild(b);
  }
  function outlineMatch(id) {
    const a = q(`a[href*='/marketplace/item/${id}']`);
    if (a) badgeCard(cardOf(a));
  }
  function clearOutlines() { document.querySelectorAll(".mds-badge").forEach((e) => e.remove()); }

  // Best thumbnail for a listing: the largest <img> inside its card.
  function thumbFor(id) {
    const a = q(`a[href*='/marketplace/item/${id}']`);
    if (!a) return "";
    let best = "", bestArea = 0;
    cardOf(a).querySelectorAll("img").forEach((img) => {
      const src = img.currentSrc || img.src || "";
      if (!/^https?:/.test(src)) return;
      const area = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
      if (area >= bestArea) { bestArea = area; best = src; }
    });
    return best;
  }
  function highlightSnippet(snip, hits) {
    let html = escapeHtml((snip || "").slice(0, 200));
    (hits || []).forEach((k) => {
      if (!k) return;
      const re = new RegExp("(" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
      html = html.replace(re, "<mark>$1</mark>");
    });
    return html + "…";
  }

  // --- "Show only matches" = a polished overlay gallery of the matches, layered
  // over the page. Background scroll is locked while it's open, so the underlying
  // feed can't lazy-load. Esc or "Show all listings" closes it. ---
  function showGallery(matches) {
    removeGallery();
    document.documentElement.style.overflow = "hidden";   // lock background scroll
    const g = document.createElement("div");
    g.id = "mds-gallery";
    const kwChip = lastKw.length ? `<span class="mds-gkw">${escapeHtml(lastKw.join(", "))}</span>` : "";
    g.innerHTML = `
      <div id="mds-gallery-bar">
        <div class="mds-gbar-left"><span class="mds-gcount">${matches.length}</span>
          match${matches.length === 1 ? "" : "es"} in descriptions ${kwChip}</div>
        <button id="mds-gallery-close">✕ Show all listings</button>
      </div>
      <div id="mds-gallery-grid"></div>`;
    document.documentElement.appendChild(g);
    const grid = g.querySelector("#mds-gallery-grid");
    matches.forEach((mt) => {
      // prefer the listing's own card image captured during collection; then the
      // image carried on the match; then a fresh feed-DOM lookup.
      const thumb = feedThumbs[mt.id] || mt.image || thumbFor(mt.id);
      const card = document.createElement("a");
      card.className = "mds-gcard";
      card.href = mt.url; card.target = "_blank"; card.rel = "noopener";
      card.innerHTML = `
        <div class="mds-gthumb">${mt.isNew ? '<span class="mds-gnew">NEW</span>' : ''}${thumb ? `<img src="${thumb}" loading="lazy" referrerpolicy="no-referrer">` : '<span class="mds-gph">🏠</span>'}</div>
        <div class="mds-gmeta">
          <div class="mds-gprice">${escapeHtml(mt.price || "")}</div>
          <div class="mds-gtitle">${escapeHtml(mt.title || "")}</div>
          <div class="mds-gsnip">${highlightSnippet(mt.snippet, mt.hits)}</div>
        </div>`;
      grid.appendChild(card);
    });
    g.querySelector("#mds-gallery-close").onclick = () => { stopFilter(); setStatus("Showing all listings."); };
    escHandler = (e) => { if (e.key === "Escape") { stopFilter(); setStatus("Showing all listings."); } };
    document.addEventListener("keydown", escHandler);
    window.scrollTo(0, 0);
  }
  function removeGallery() {
    const g = document.getElementById("mds-gallery");
    if (g) g.remove();
    document.documentElement.style.overflow = "";
    if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
  }
  function stopFilter() { filtering = false; removeGallery(); }
  function clearMarks() { stopFilter(); clearOutlines(); }

  function readOpts() {
    return {
      kw: q("#mds-kw").value.split(",").map((s) => s.trim()).filter(Boolean),
      max: Math.max(1, Math.min(1000, parseInt(q("#mds-max").value, 10) || 40)),
      matchAll: q("#mds-all").checked,
      searchTitles: q("#mds-title").checked,
      concurrency: Math.max(1, Math.min(5, parseInt(q("#mds-conc").value, 10) || 3))
    };
  }

  async function doScan() {
    const o = readOpts();
    if (!o.kw.length) { setStatus("Enter at least one keyword."); return; }
    lastKw = o.kw;
    chrome.storage.local.set({ kw: q("#mds-kw").value });
    q("#mds-results").innerHTML = "";
    matchedIds = new Set();
    clearMarks();
    setStatus("Loading listings…");
    const ids = await collectIds(o.max);
    if (!ids.length) { setStatus("No listings found on this page."); return; }
    setStatus(`Scanning ${ids.length} descriptions with ${o.concurrency} tabs…`);
    chrome.runtime.sendMessage({ type: "scan", ids, keywords: o.kw, matchAll: o.matchAll, searchTitles: o.searchTitles, concurrency: o.concurrency });
  }

  function doSaveAlert() {
    const o = readOpts();
    if (!o.kw.length) { setStatus("Enter keyword(s) first, then Save as alert."); return; }
    const intervalMin = parseInt(prompt("Check this search every how many minutes? (e.g. 60)", "60"), 10);
    if (!intervalMin || intervalMin < 5) { setStatus("Alert cancelled (minimum 5 minutes)."); return; }
    chrome.runtime.sendMessage({
      type: "createAlert", url: location.href, keywords: o.kw,
      matchAll: o.matchAll, searchTitles: o.searchTitles, intervalMin, max: o.max, concurrency: o.concurrency
    }, () => setStatus(`Alert saved — notifying you of new matches every ${intervalMin} min (newest-first). Manage via the toolbar icon.`));
  }

  function doSortNewest() { location.href = withNewestSort(location.href); }

  // Reflect whether the CURRENT url is already newest-sorted. Re-runnable so the
  // button re-enables after navigating to a different (un-sorted) marketplace link.
  function updateSortBtn() {
    const b = q("#mds-sort");
    if (!b) return;
    if (/sortBy=creation_time_descend/.test(location.href)) {
      b.textContent = "✓ Sorted newest first"; b.disabled = true;
    } else {
      b.textContent = "↻ Sort newest first"; b.disabled = false;
    }
  }

  function buildPanel() {
    if (q("#mds-panel")) return;
    const panel = document.createElement("div");
    panel.id = "mds-panel";
    panel.innerHTML = `
      <div id="mds-head">🔎 Description Search <span id="mds-min">–</span></div>
      <div id="mds-body">
        <label>Keyword(s) in description <small>(comma-separated)</small></label>
        <input id="mds-kw" type="text" placeholder="e.g. one, two" />
        <div class="mds-row">
          <label><input id="mds-all" type="checkbox" /> match all</label>
          <label><input id="mds-hide" type="checkbox" checked /> show only matches</label>
        </div>
        <div class="mds-row">
          <label><input id="mds-title" type="checkbox" /> search titles too</label>
        </div>
        <div class="mds-row">
          <label>Max listings <input id="mds-max" type="number" value="60" min="1" max="1000" /></label>
          <label>Parallel tabs <input id="mds-conc" type="number" value="3" min="1" max="5" /></label>
        </div>
        <button id="mds-sort" title="Reload this search sorted newest-first">↻ Sort newest first</button>
        <button id="mds-go">Scan descriptions</button>
        <button id="mds-show" title="Close the matches gallery">Show all listings</button>
        <button id="mds-alert" title="Re-scan this page on a schedule and notify you of new matches">＋ Save as alert</button>
        <div id="mds-status"></div>
        <div id="mds-results"></div>
      </div>`;
    document.documentElement.appendChild(panel);
    panel.querySelector("#mds-min").onclick = () => panel.classList.toggle("mds-collapsed");
    panel.querySelector("#mds-head").onclick = (e) => { if (e.target.id === "mds-head") panel.classList.toggle("mds-collapsed"); };
    panel.querySelector("#mds-sort").onclick = doSortNewest;
    panel.querySelector("#mds-go").onclick = doScan;
    panel.querySelector("#mds-show").onclick = () => { stopFilter(); setStatus("Showing all listings."); };
    panel.querySelector("#mds-alert").onclick = doSaveAlert;
    updateSortBtn();
    chrome.storage.local.get(["kw"], (s) => { if (s.kw) panel.querySelector("#mds-kw").value = s.kw; });
  }
  function removePanel() { const p = q("#mds-panel"); if (p) p.remove(); }
  function route() { if (isFeedPage()) buildPanel(); else removePanel(); }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "progress") {
      const c = msg.current;
      setStatus(`Checked ${msg.done}/${msg.total}… (${matchedIds.size} match${matchedIds.size === 1 ? "" : "es"})`);
      if (c && c.matched) { matchedIds.add(c.id); addResult(c); outlineMatch(c.id); }
    } else if (msg.type === "complete") {
      const n = msg.matches.length;
      const hide = q("#mds-hide");
      if (hide && hide.checked && n > 0) {
        filtering = true;
        showGallery(msg.matches);
        setStatus(`Done. ${n} match${n === 1 ? "" : "es"} — click "Show all listings" to close.`);
      } else {
        setStatus(`Done. ${n} match${n === 1 ? "" : "es"} found in descriptions.`);
      }
    }
  });

  // ---- detect single-page-app navigation (poll pathname; ignore map URL churn) ----
  function onNav() {
    stopFilter();
    clearOutlines();
    matchedIds = new Set();
    const r = q("#mds-results"); if (r) r.innerHTML = "";
    route();
  }
  let lastPath = location.pathname;
  let lastHref = location.href;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; onNav(); }
    else if (isFeedPage() && !document.getElementById("mds-panel")) buildPanel();
    // query string can change without a path change (different search / sort removed) — refresh button
    if (location.href !== lastHref) { lastHref = location.href; updateSortBtn(); }
  }, 1000);
  route();
})();
