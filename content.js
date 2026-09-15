// Content script. Facebook is a single-page app, so navigating Marketplace changes the
// URL without a reload. This script runs on all of facebook.com, watches for navigation,
// and shows the panel on Marketplace feed/search/category pages. The UI lives in a
// closed shadow root so Facebook's own scripts can neither read the keyword box nor
// restyle it; the in-feed badges are the only thing added to the page DOM.
(function () {
  if (window.__mds_router) return;
  window.__mds_router = true;
  const M = globalThis.MDS;
  const { LIMITS } = M;
  const INTERVALS = [[15, "15 min"], [30, "30 min"], [60, "1 hour"], [180, "3 hours"], [360, "6 hours"], [720, "12 hours"], [1440, "24 hours"]];

  // ---- state ----
  let host = null, root = null;
  const q = (sel) => (root ? root.querySelector(sel) : null);
  const defaults = { kw: "", max: 60, conc: 3, matchAll: false, searchTitles: false, hide: true, wholeWord: false, fresh: false, intervalMin: 60, collapsed: false, pos: null };
  let opts = { ...defaults };
  let runSeq = 0, currentRun = 0;        // generation token for the collection loop (0 = idle)
  let scanning = false, bgPhase = false, scanId = null, pendingConfirm = 0, scanTotal = 0;
  const hidden = new Set();            // listing ids the user hid this session (the worker persists them)
  let results = [], matchedIds = new Set(), feedThumbs = {}, lastScanHref = null, lastKw = [];
  let lastStats = null, pendingGallery = false, galleryOpener = null, origTitle = null, sortMode = "match";
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  const send = (msg) => chrome.runtime.sendMessage(msg);

  // ---- persisted panel options ----
  let saveTimer = null;
  function saveOpts() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { chrome.storage.local.set({ panelOpts: opts }); } catch (_) {} }, 150);
  }
  const optsReady = new Promise((resolve) => {
    try {
      chrome.storage.local.get(["panelOpts", "kw"], (s) => {
        opts = { ...defaults, ...((s && s.panelOpts) || {}) };
        if (!opts.kw && s && s.kw) opts.kw = s.kw;
        resolve();
      });
    } catch (_) { resolve(); }
  });

  const isFeedPage = () => M.isFeedUrl(location.href);
  function setStatus(t) { const s = q("#mds-status"); if (s) s.textContent = t || ""; }
  function setStatusWithUndo(t, onUndo) {
    const s = q("#mds-status");
    if (!s) return;
    s.textContent = t;
    const b = document.createElement("button");
    b.textContent = "Undo";
    b.onclick = onUndo;
    s.appendChild(b);
  }
  function dead() {
    scanning = false; bgPhase = false; currentRun = 0; scanId = null;
    setBusyUI(false); hideToast();
    setStatus("Description Search was updated — refresh this page to keep using it.");
  }

  // ---- in-feed highlight (page DOM): a border drawn INSIDE the card so it can't be clipped ----
  function cardOf(a) {
    let el = a;
    while (el.parentElement) {
      if (el.parentElement.querySelectorAll(M.ITEM_LINK_SEL).length > 1) return el;
      el = el.parentElement;
    }
    return a;
  }
  function badgeCard(card) {
    if (!card || card.querySelector(":scope > .mds-badge")) return;
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    const b = document.createElement("div");
    b.className = "mds-badge";
    card.appendChild(b);
  }
  function outlineMatch(id) {
    const a = document.querySelector(`a[href*='/marketplace/item/${id}']`);
    if (a) badgeCard(cardOf(a));
  }
  function clearOutlines() { document.querySelectorAll(".mds-badge").forEach((e) => e.remove()); }
  // After SPA navigation the cards render a little later than the URL changes.
  function reoutline() {
    let tries = 0;
    const t = setInterval(() => { visibleResults().forEach((m) => outlineMatch(m.id)); if (++tries > 8) clearInterval(t); }, 500);
  }

  // ---- collection toast (non-modal, bottom-centre) ----
  function showToast(p) {
    let t = q("#mds-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "mds-toast";
      t.innerHTML = '<div class="mds-spin"></div><div><div id="mds-toast-txt"></div><div id="mds-toast-hint"></div></div><button id="mds-toast-cancel">✕ Cancel</button>';
      t.querySelector("#mds-toast-cancel").onclick = cancelScan;
      root.appendChild(t);
    }
    t.hidden = false;
    t.querySelector("#mds-toast-txt").textContent = `Loading listings… ${p.found} / ${p.max} · ${Math.round(p.elapsedMs / 1000)} s`;
    t.querySelector("#mds-toast-hint").textContent = p.stable >= 4 ? `No new listings for ${Math.round(p.stable * 0.95)} s — finishing soon. Esc cancels.` : "You can keep using the page. Esc cancels.";
  }
  function hideToast() { const t = q("#mds-toast"); if (t) t.hidden = true; }

  // ---- progress in the header (visible even when collapsed) ----
  function setProgress(done, total) {
    const h = q("#mds-hprog"), bar = q("#mds-bar");
    if (h) h.textContent = total ? `${done}/${total}` : "";
    if (bar) { bar.hidden = !total; bar.firstElementChild.style.width = total ? Math.round((done / total) * 100) + "%" : "0"; }
    if (origTitle == null) origTitle = document.title;
    if (total) document.title = `[${done}/${total}] ${origTitle}`;
  }
  function clearProgress() {
    setProgress(0, 0);
    if (origTitle != null) { document.title = origTitle; origTitle = null; }
  }
  function setBusyUI(on) {
    const go = q("#mds-go"), c = q("#mds-cancel");
    if (go) { go.disabled = on; go.textContent = on ? "Scanning…" : "Scan descriptions"; }
    if (c) c.hidden = !on;
    if (!on) clearProgress();
  }

  // ---- results list ----
  const visibleResults = () => results.filter((m) => !hidden.has(m.id));
  function thumbFor(m) { return feedThumbs[m.id] || m.image || ""; }
  function resultRow(m) {
    const div = document.createElement("div");
    div.className = "mds-result";
    div.dataset.id = m.id;
    const th = document.createElement("span");
    th.className = "mds-rthumb";
    const src = thumbFor(m);
    if (src) { const img = document.createElement("img"); img.src = src; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.onerror = () => { img.replaceWith(document.createTextNode("🏠")); }; th.appendChild(img); }
    else th.textContent = "🏠";
    const info = document.createElement("div");
    info.className = "mds-rinfo";
    const a = document.createElement("a");
    a.href = m.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = m.title || "(untitled)";
    const price = document.createElement("span");
    price.className = "mds-price"; price.textContent = m.price || "";
    const snip = document.createElement("div");
    snip.className = "mds-rsnip";
    snip.innerHTML = M.highlightSnippet(m.snippet, m.hits);
    info.append(a, price, snip);
    const x = document.createElement("button");
    x.className = "mds-hide"; x.title = "Hide this listing from future scans"; x.textContent = "×";
    x.onclick = () => hideListing(m);
    div.append(th, info, x);
    return div;
  }
  function renderResults() {
    const box = q("#mds-results"), head = q("#mds-reshead"), count = q("#mds-rescount");
    if (!box) return;
    box.innerHTML = "";
    const vis = visibleResults();
    vis.forEach((m) => box.appendChild(resultRow(m)));
    if (head) head.hidden = !vis.length;
    if (count) count.textContent = `${vis.length} match${vis.length === 1 ? "" : "es"}`;
    updateShowBtn();
  }
  function addResult(m) {
    if (matchedIds.has(m.id)) return;
    matchedIds.add(m.id);
    results.push(m);
    if (hidden.has(m.id)) return;
    const box = q("#mds-results");
    if (box) { box.appendChild(resultRow(m)); const head = q("#mds-reshead"), count = q("#mds-rescount"); if (head) head.hidden = false; if (count) count.textContent = `${visibleResults().length} match${visibleResults().length === 1 ? "" : "es"}`; }
    outlineMatch(m.id);
    updateShowBtn();
  }
  function clearResults() {
    results = []; matchedIds = new Set(); feedThumbs = {}; lastStats = null;
    clearOutlines();
    renderResults();
    setStatus("");
  }
  async function hideListing(m) {
    if (!alive()) return dead();
    hidden.add(m.id);
    try { await send({ type: "dismiss", id: m.id }); } catch (_) {}
    renderResults();
    const card = document.querySelector(`a[href*='/marketplace/item/${m.id}']`);
    if (card) { const b = cardOf(card).querySelector(":scope > .mds-badge"); if (b) b.remove(); }
    const g = q("#mds-gallery-grid");
    if (g) { const c = g.querySelector(`[data-id="${m.id}"]`); if (c) c.remove(); updateGalleryCount(); }
    setStatusWithUndo("Hidden — it won't show up in future scans or alerts.", async () => {
      hidden.delete(m.id);
      try { await send({ type: "dismiss", id: m.id, undo: true }); } catch (_) {}
      renderResults(); outlineMatch(m.id);
      if (q("#mds-gallery")) showGallery();
      setStatus("Listing restored.");
    });
  }

  // ---- gallery: a full-screen grid of the matches, layered over the page ----
  function showGallery() {
    removeGallery(false);
    galleryOpener = galleryOpener || root.activeElement || null;
    document.documentElement.style.overflow = "hidden";        // lock background scroll (feed can't lazy-load)
    const g = document.createElement("div");
    g.id = "mds-gallery";
    g.setAttribute("role", "dialog"); g.setAttribute("aria-modal", "true"); g.setAttribute("aria-label", "Matching listings");
    const kwChip = lastKw.length ? `<span class="mds-gkw">${M.escapeHtml(lastKw.join(", "))}</span>` : "";
    g.innerHTML = `
      <div id="mds-gallery-bar">
        <div class="mds-gbar-left"><span class="mds-gcount" id="mds-gcount"></span><span id="mds-glabel"></span> ${kwChip}</div>
        <div class="mds-gbar-right">
          <select class="mds-gsel" id="mds-gsort" aria-label="Sort">
            <option value="match">Sort: as found</option><option value="price-asc">Sort: price ↑</option><option value="price-desc">Sort: price ↓</option>
          </select>
          <button class="mds-gbtn" id="mds-gopen">Open all</button>
          <button class="mds-gbtn" id="mds-gcopy">Copy links</button>
          <button id="mds-gallery-close">✕ Show all listings</button>
        </div>
      </div>
      <div id="mds-gallery-grid"></div>`;
    root.appendChild(g);
    const sel = g.querySelector("#mds-gsort");
    sel.value = sortMode;
    sel.onchange = () => { sortMode = sel.value; fillGallery(); };
    g.querySelector("#mds-gallery-close").onclick = () => { stopFilter(); setStatus("Showing all listings."); };
    g.querySelector("#mds-gopen").onclick = async () => {
      if (!alive()) return dead();
      const urls = sortedVisible().map((m) => m.url).slice(0, 25);
      try { await send({ type: "openUrls", urls }); } catch (_) {}
    };
    g.querySelector("#mds-gcopy").onclick = async () => {
      try { await navigator.clipboard.writeText(sortedVisible().map((m) => m.url).join("\n")); flashGalleryButton("#mds-gcopy", "Copied"); }
      catch (_) { flashGalleryButton("#mds-gcopy", "Copy failed"); }
    };
    fillGallery();
    g.querySelector("#mds-gallery-close").focus();
  }
  function flashGalleryButton(sel, text) { const b = q(sel); if (!b) return; const old = b.textContent; b.textContent = text; setTimeout(() => { b.textContent = old; }, 1400); }
  function sortedVisible() {
    const vis = visibleResults().slice();
    const n = (m) => (m.priceNum != null && m.priceNum > 0 ? m.priceNum : (m.descPriceNum != null ? m.descPriceNum : null));
    if (sortMode === "price-asc") vis.sort((a, b) => (n(a) == null) - (n(b) == null) || (n(a) || 0) - (n(b) || 0));
    if (sortMode === "price-desc") vis.sort((a, b) => (n(a) == null) - (n(b) == null) || (n(b) || 0) - (n(a) || 0));
    return vis;
  }
  function updateGalleryCount() {
    const n = visibleResults().length;
    const c = q("#mds-gcount"), l = q("#mds-glabel");
    if (c) c.textContent = String(n);
    if (l) l.textContent = ` match${n === 1 ? "" : "es"} in descriptions`;
  }
  function fillGallery() {
    const grid = q("#mds-gallery-grid");
    if (!grid) return;
    grid.innerHTML = "";
    updateGalleryCount();
    const vis = sortedVisible();
    if (!vis.length) { const e = document.createElement("div"); e.className = "mds-gempty"; e.textContent = "No matches to show."; grid.appendChild(e); return; }
    vis.forEach((mt) => {
      const card = document.createElement("a");
      card.className = "mds-gcard";
      card.dataset.id = mt.id;
      card.href = mt.url; card.target = "_blank"; card.rel = "noopener";
      const th = document.createElement("div");
      th.className = "mds-gthumb";
      if (mt.titleHits && mt.titleHits.length && !mt.hits.some((h) => !mt.titleHits.includes(h))) { const t = document.createElement("span"); t.className = "mds-gtitlehit"; t.textContent = "matched in title"; th.appendChild(t); }
      const src = thumbFor(mt);
      if (src) { const img = document.createElement("img"); img.src = src; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.onerror = () => { img.replaceWith(Object.assign(document.createElement("span"), { className: "mds-gph", textContent: "🏠" })); }; th.appendChild(img); }
      else { const ph = document.createElement("span"); ph.className = "mds-gph"; ph.textContent = "🏠"; th.appendChild(ph); }
      const x = document.createElement("button");
      x.className = "mds-ghide"; x.title = "Hide this listing"; x.textContent = "×"; x.setAttribute("aria-label", "Hide this listing");
      x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); hideListing(mt); };
      th.appendChild(x);
      const meta = document.createElement("div");
      meta.className = "mds-gmeta";
      meta.innerHTML = `<div class="mds-gprice">${M.escapeHtml(mt.price || "")}</div><div class="mds-gtitle">${M.escapeHtml(mt.title || "")}</div><div class="mds-gsnip">${M.highlightSnippet(mt.snippet, mt.hits)}</div>`;
      card.append(th, meta);
      grid.appendChild(card);
    });
  }
  function removeGallery(restoreFocus) {
    const g = q("#mds-gallery");
    if (g) g.remove();
    document.documentElement.style.overflow = "";
    if (restoreFocus !== false && galleryOpener && galleryOpener.isConnected) { try { galleryOpener.focus(); } catch (_) {} }
    galleryOpener = null;
  }
  let filtering = false;
  function stopFilter() { filtering = false; removeGallery(true); updateShowBtn(); }
  function updateShowBtn() {
    const b = q("#mds-show");
    if (!b) return;
    const n = visibleResults().length;
    b.hidden = !filtering && !n;
    b.textContent = filtering ? "Show all listings" : `Show matches (${n})`;
  }
  function openGallery() { filtering = true; showGallery(); updateShowBtn(); }

  // ---- options <-> controls ----
  function readOpts() {
    const v = (sel) => q(sel).value;
    opts.kw = v("#mds-kw");
    opts.max = M.clampInt(v("#mds-max"), 1, LIMITS.manualMax, 60);
    opts.conc = M.clampInt(v("#mds-conc"), 1, LIMITS.maxConcurrency, 3);
    opts.matchAll = q("#mds-all").checked;
    opts.searchTitles = q("#mds-titles").checked;
    opts.hide = q("#mds-hide").checked;
    opts.wholeWord = q("#mds-word").checked;
    opts.fresh = q("#mds-fresh").checked;
    opts.intervalMin = parseInt(v("#mds-interval"), 10) || 60;
    return opts;
  }
  function applyOpts() {
    const panel = q("#mds-panel");
    if (!panel) return;
    q("#mds-kw").value = opts.kw || "";
    q("#mds-max").value = opts.max; q("#mds-conc").value = opts.conc;
    q("#mds-all").checked = !!opts.matchAll; q("#mds-titles").checked = !!opts.searchTitles;
    q("#mds-hide").checked = opts.hide !== false; q("#mds-word").checked = !!opts.wholeWord; q("#mds-fresh").checked = !!opts.fresh;
    q("#mds-interval").value = String(INTERVALS.some(([m]) => m === opts.intervalMin) ? opts.intervalMin : 60);
    setCollapsed(!!opts.collapsed);
    if (opts.pos) setPos(opts.pos.left, opts.pos.top);
  }
  function setCollapsed(c) {
    const panel = q("#mds-panel"), btn = q("#mds-min");
    if (!panel) return;
    panel.classList.toggle("mds-collapsed", c);
    btn.textContent = c ? "+" : "–";
    btn.title = c ? "Expand" : "Collapse";
    btn.setAttribute("aria-expanded", String(!c));
  }
  function setPos(left, top) {
    const p = q("#mds-panel");
    if (!p) return;
    left = Math.max(0, Math.min(window.innerWidth - p.offsetWidth, left));
    top = Math.max(0, Math.min(window.innerHeight - 40, top));
    p.style.left = left + "px"; p.style.top = top + "px"; p.style.right = "auto";
  }
  function makeDraggable(panel, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; dragging = true; moved = false;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 4) moved = true;
      if (moved) setPos(ox + e.clientX - sx, oy + e.clientY - sy);
    });
    handle.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) { opts.pos = { left: panel.offsetLeft, top: panel.offsetTop }; saveOpts(); }
      else { opts.collapsed = !opts.collapsed; setCollapsed(opts.collapsed); saveOpts(); }
    });
  }

  // ---- scanning ----
  async function doScan() {
    if (!alive()) return dead();
    if (scanning) return;
    const o = readOpts();
    saveOpts();
    const kw = M.parseKeywords(o.kw);
    if (!kw.include.length) { setStatus(kw.exclude.length ? "Add at least one keyword to look for — exclusions alone aren't enough." : "Enter at least one keyword."); return; }
    if (o.max > LIMITS.confirmScanAbove && pendingConfirm !== o.max) {
      pendingConfirm = o.max;
      setStatus(`Large scan: up to ${o.max} listings (roughly ${Math.ceil((o.max * 4) / o.conc / 60)} min if none are cached). Click "Scan descriptions" again to confirm.`);
      return;
    }
    pendingConfirm = 0;
    lastKw = kw.include;
    const run = ++runSeq;
    currentRun = run;
    scanning = true; bgPhase = false; scanId = crypto.randomUUID(); scanTotal = 0;
    stopFilter();
    clearResults();
    setBusyUI(true);
    setStatus("Loading listings…");
    const col = await window.__mdsCollect(o.max, { isCancelled: () => currentRun !== run, onProgress: showToast, restoreScroll: true });
    if (currentRun !== run) return;                   // cancelled during collection — cancelScan() reset the UI
    hideToast();
    if (col.state !== "ok") return finishLocal("Facebook is showing a login or checkpoint page — log in and try again.");
    feedThumbs = col.thumbs;
    if (!col.ids.length) return finishLocal("No listings found on this page.");
    lastScanHref = location.href;
    scanTotal = col.ids.length;
    setStatus(`Scanning ${col.ids.length} descriptions with ${o.conc} tabs…`);
    bgPhase = true;
    let r;
    try {
      r = await send({ type: "scan", scanId, ids: col.ids, include: kw.include, exclude: kw.exclude, matchAll: o.matchAll, searchTitles: o.searchTitles,
        wholeWord: o.wholeWord, concurrency: o.conc, noCache: o.fresh });
    } catch (_) { return dead(); }
    if (currentRun !== run) return;
    if (!r || !r.ok) return finishLocal("Couldn't start the scan: " + ((r && r.error) || "no response"));
    if (r.queued) setStatus(`Queued — another scan or alert is using the tab pool; yours starts when it finishes (${r.position} ahead).`);
  }
  function finishLocal(msg) {
    scanning = false; bgPhase = false; currentRun = 0; scanId = null;
    setBusyUI(false);
    setStatus(msg);
  }
  // Cancel a running scan. During collection only the local loop is stopped (nothing has
  // reached the worker yet); once the worker owns the scan, ask it to stop its tabs.
  function cancelScan() {
    const wasBg = bgPhase, sid = scanId;
    currentRun = 0; runSeq++;
    scanning = false; bgPhase = false; scanId = null;
    setBusyUI(false); hideToast();
    setStatus("Scan cancelled.");
    if (!wasBg) return;
    if (!alive()) return dead();
    try { send({ type: "cancelRun", scanId: sid }).catch(() => {}); } catch (_) { dead(); }
  }
  function statsText(st) {
    if (!st) return "";
    const bits = [];
    if (st.cached) bits.push(`${st.cached} from cache`);
    if (st.noDesc) bits.push(`${st.noDesc} without a description`);
    if (st.unavailable) bits.push(`${st.unavailable} unavailable`);
    if (st.skipped) bits.push(`${st.skipped} hidden`);
    if (st.errors) bits.push(`${st.errors} failed`);
    return bits.length ? " (" + bits.join(", ") + ")" : "";
  }
  function finishScan(msg) {
    scanning = false; bgPhase = false; scanId = null; currentRun = 0;
    setBusyUI(false);
    (msg.matches || []).forEach(addResult);
    lastStats = msg.stats || null;
    const n = visibleResults().length, es = n === 1 ? "" : "es";
    if (msg.cancelled) { setStatus(msg.dropped ? "Scan was cancelled before it started." : `Scan cancelled — ${n} match${es} before stopping.`); return; }
    if (msg.error) { setStatus("Scan failed: " + msg.error); return; }
    if (msg.aborted === "login") { setStatus(`Stopped: Facebook is showing a login page. Log in and scan again. ${n} match${es} so far.`); return; }
    if (msg.aborted === "blocked") { setStatus(`Stopped: Facebook is temporarily limiting this account — try again later. ${n} match${es} so far.`); return; }
    const onPage = location.href === lastScanHref && isFeedPage();
    if (opts.hide && n > 0) {
      if (onPage) { openGallery(); setStatus(`Done. ${n} match${es}${statsText(lastStats)} — Esc or "Show all listings" closes the gallery.`); }
      else pendingGallery = true;
    } else setStatus(`Done. ${n} match${es} found in descriptions${statsText(lastStats)}.`);
    updateShowBtn();
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !scanId || msg.scanId !== scanId) return;          // stale job (cancelled/previous scan) or not ours
    if (msg.type === "started") { setStatus(`Scanning ${scanTotal} descriptions…`); return; }
    if (msg.type === "progress") {
      setProgress(msg.done, msg.total);
      const st = msg.stats || {};
      setStatus(`Checked ${msg.done}/${msg.total}… (${visibleResults().length} match${visibleResults().length === 1 ? "" : "es"}${st.cached ? `, ${st.cached} from cache` : ""})`);
      const c = msg.current;
      if (c && c.matched) addResult(c);
      return;
    }
    if (msg.type === "complete") finishScan(msg);
  });

  // ---- alerts ----
  async function doSaveAlert() {
    if (!alive()) return dead();
    const o = readOpts();
    saveOpts();
    const kw = M.parseKeywords(o.kw);
    if (!kw.include.length) { setStatus("Enter keyword(s) first, then Save as alert."); return; }
    if (!isFeedPage()) { setStatus("Alerts need a Marketplace search or category page."); return; }
    const btn = q("#mds-alert");
    btn.disabled = true;
    try {
      const r = await send({ type: "createAlert", url: location.href, keywords: kw.include, exclude: kw.exclude, matchAll: o.matchAll, searchTitles: o.searchTitles,
        wholeWord: o.wholeWord, intervalMin: o.intervalMin, max: Math.min(o.max, LIMITS.alertMax), concurrency: Math.min(o.conc, LIMITS.alertConcurrency) });
      if (!r || !r.ok) setStatus("Couldn't save the alert: " + ((r && r.error) || "no response"));
      else if (r.merged) setStatus(`Updated your existing alert for this search — checking every ${r.alert.intervalMin} min.`);
      else setStatus(`Alert saved — a quiet baseline scan runs now, then you're notified of new matches every ${r.alert.intervalMin} min. Manage alerts via the toolbar icon.`);
    } catch (_) { dead(); }
    finally { if (btn.isConnected) btn.disabled = false; }
  }
  function doSortNewest() { location.href = M.withNewestSort(location.href); }
  function updateSortBtn() {
    const b = q("#mds-sort");
    if (!b) return;
    if (/sortBy=creation_time_descend/.test(location.href)) { b.textContent = "✓ Sorted newest first"; b.disabled = true; }
    else { b.textContent = "↻ Sort newest first"; b.disabled = false; }
  }

  // ---- panel ----
  function ensureHost() {
    if (host && host.isConnected) return;
    document.querySelectorAll("#mds-host, #mds-panel, #mds-overlay, #mds-gallery").forEach((e) => e.remove());   // leftovers from an older script instance
    host = document.createElement("div");
    host.id = "mds-host";
    root = host.attachShadow({ mode: "closed" });
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("panel.css");
    root.appendChild(link);
    document.documentElement.appendChild(host);
  }
  function buildPanel() {
    ensureHost();
    if (q("#mds-panel")) return;
    const panel = document.createElement("div");
    panel.id = "mds-panel";
    panel.innerHTML = `
      <div id="mds-head"><span id="mds-title">🔎 Description Search</span><span id="mds-hprog"></span>
        <button id="mds-min" type="button" aria-expanded="true" aria-controls="mds-body" title="Collapse">–</button></div>
      <div id="mds-bar" hidden><i></i></div>
      <div id="mds-body">
        <label for="mds-kw">Keywords in description <small>(comma-separated · "quoted phrase" · -exclude)</small></label>
        <input id="mds-kw" type="text" placeholder='e.g. sea view, "15,000", -agent' autocomplete="off" />
        <div class="mds-row">
          <label><input id="mds-all" type="checkbox" /> match all</label>
          <label><input id="mds-hide" type="checkbox" checked /> show only matches</label>
        </div>
        <div class="mds-row">
          <label><input id="mds-titles" type="checkbox" /> search titles too</label>
          <label><input id="mds-word" type="checkbox" /> whole words</label>
        </div>
        <div class="mds-row">
          <label>Max listings <input id="mds-max" type="number" value="60" min="1" max="${LIMITS.manualMax}" /></label>
          <label>Parallel tabs <input id="mds-conc" type="number" value="3" min="1" max="${LIMITS.maxConcurrency}" /></label>
        </div>
        <div class="mds-row"><label><input id="mds-fresh" type="checkbox" /> re-read listings cached in the last 12 h</label></div>
        <button id="mds-sort" type="button" title="Reload this search sorted newest-first">↻ Sort newest first</button>
        <button id="mds-go" type="button">Scan descriptions</button>
        <button id="mds-cancel" type="button" hidden title="Stop the scan and close its background tabs">✕ Cancel scan</button>
        <button id="mds-show" type="button" hidden>Show matches</button>
        <div class="mds-row mds-alertrow">
          <select id="mds-interval" aria-label="Alert interval">${INTERVALS.map(([m, l]) => `<option value="${m}">${l}</option>`).join("")}</select>
          <button id="mds-alert" type="button" title="Re-scan this page on a schedule and notify you of new matches">＋ Save as alert</button>
        </div>
        <div id="mds-status" role="status" aria-live="polite"></div>
        <div id="mds-reshead" hidden><span id="mds-rescount"></span><button id="mds-clear" type="button">Clear</button></div>
        <div id="mds-results"></div>
      </div>`;
    root.appendChild(panel);
    panel.querySelector("#mds-min").onclick = () => { opts.collapsed = !opts.collapsed; setCollapsed(opts.collapsed); saveOpts(); };
    makeDraggable(panel, panel.querySelector("#mds-head"));
    panel.querySelector("#mds-sort").onclick = doSortNewest;
    panel.querySelector("#mds-go").onclick = doScan;
    panel.querySelector("#mds-cancel").onclick = cancelScan;
    panel.querySelector("#mds-show").onclick = () => { if (filtering) { stopFilter(); setStatus("Showing all listings."); } else openGallery(); };
    panel.querySelector("#mds-alert").onclick = doSaveAlert;
    panel.querySelector("#mds-clear").onclick = clearResults;
    panel.querySelector("#mds-kw").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doScan(); } });
    panel.querySelector("#mds-body").addEventListener("change", () => { readOpts(); saveOpts(); pendingConfirm = 0; });
    panel.querySelector("#mds-kw").addEventListener("input", () => { opts.kw = q("#mds-kw").value; saveOpts(); });
    optsReady.then(() => { applyOpts(); updateSortBtn(); });
    updateSortBtn();
    if (scanning) { setBusyUI(true); if (scanTotal) setStatus(location.href === lastScanHref ? `Scanning ${scanTotal} descriptions…` : "Still scanning the previous search — Cancel to stop it."); }
    renderResults();
  }
  function removePanel() { const p = q("#mds-panel"); if (p) p.remove(); }
  function route() { if (isFeedPage()) buildPanel(); else removePanel(); }

  // ---- keyboard: Esc closes the gallery, or cancels a running scan ----
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (q("#mds-gallery")) { stopFilter(); setStatus("Showing all listings."); }
    else if (scanning) cancelScan();
  });

  // ---- SPA navigation ----
  // A scan belongs to the page it was started on. Navigating away keeps it running in the
  // worker; results are shown again when the user comes back to that same URL.
  function onNav() {
    removeGallery(false); filtering = false;
    clearOutlines();
    route();
    if (results.length && location.href === lastScanHref && isFeedPage()) {
      renderResults(); reoutline();
      if (pendingGallery) { pendingGallery = false; openGallery(); }
    } else if (!scanning && location.href !== lastScanHref) {
      results = []; matchedIds = new Set(); renderResults();
    }
  }
  let lastPath = location.pathname, lastHref = location.href;
  function checkNav() {
    if (location.pathname !== lastPath) { lastPath = location.pathname; lastHref = location.href; onNav(); }
    else if (location.href !== lastHref) { lastHref = location.href; updateSortBtn(); }   // query churn (map pans) — just refresh the button
    else if (isFeedPage() && !q("#mds-panel")) buildPanel();
  }
  if (window.navigation && window.navigation.addEventListener) window.navigation.addEventListener("navigatesuccess", () => setTimeout(checkNav, 0));
  window.addEventListener("popstate", () => setTimeout(checkNav, 0));
  setInterval(() => { if (location.pathname.startsWith("/marketplace")) checkNav(); }, 3000);   // slow fallback
  route();
})();
