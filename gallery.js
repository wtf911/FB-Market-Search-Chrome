// Standalone fullscreen view of one alert's saved matches. Opened in its own extension
// tab (no Facebook page loaded). Reads storage directly and re-renders on every change,
// so it stays live while runs finish or NEW flags are cleared elsewhere.
const M = globalThis.MDS;
const params = new URLSearchParams(location.search);
const alertId = params.get("id");
const HIST_KEY = "hist:" + alertId;
let filterNew = params.get("filter") === "new";
let sortMode = "newest";
let showHidden = false;
let toastTimer = null;
const esc = M.escapeHtml;
const send = (msg) => new Promise((resolve) => {
  try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || null); }); } catch (_) { resolve(null); }
});

async function load() {
  const s = await chrome.storage.local.get(["alerts", HIST_KEY, "dismissed"]);
  return { alert: (s.alerts || []).find((a) => a.id === alertId), hist: s[HIST_KEY] || [], dismissed: s.dismissed || {} };
}
const priceOf = (m) => (m.priceNum != null && m.priceNum > 0 ? m.priceNum : (m.descPriceNum != null ? m.descPriceNum : null));
function sorted(list) {
  const out = list.slice();
  if (sortMode === "price-asc") out.sort((a, b) => (priceOf(a) == null) - (priceOf(b) == null) || (priceOf(a) || 0) - (priceOf(b) || 0));
  if (sortMode === "price-desc") out.sort((a, b) => (priceOf(a) == null) - (priceOf(b) == null) || (priceOf(b) || 0) - (priceOf(a) || 0));
  return out;
}
function toast(text, undo) {
  document.querySelectorAll(".mds-gtoast").forEach((e) => e.remove());
  clearTimeout(toastTimer);
  const t = document.createElement("div");
  t.className = "mds-gtoast";
  t.textContent = text;
  if (undo) { const b = document.createElement("button"); b.textContent = "Undo"; b.onclick = () => { t.remove(); undo(); }; t.appendChild(b); }
  document.body.appendChild(t);
  toastTimer = setTimeout(() => t.remove(), 6000);
}
function confirmClick(btn, label, onYes) {
  if (btn.dataset.armed) return;
  const old = btn.textContent;
  btn.dataset.armed = "1"; btn.textContent = label + " Click again to confirm";
  const t = setTimeout(() => { btn.textContent = old; delete btn.dataset.armed; }, 4000);
  btn.onclick = () => { clearTimeout(t); btn.textContent = old; delete btn.dataset.armed; onYes(); };
}
function csvOf(list) {
  const cell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const rows = [["id", "title", "price", "priceNum", "url", "snippet", "new", "found"]];
  for (const m of list) rows.push([m.id, m.title, m.price, m.priceNum == null ? "" : m.priceNum, m.url, (m.snippet || "").replace(/^…/, ""), m.isNew ? "yes" : "", m.ts ? new Date(m.ts).toISOString() : ""]);
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

async function render() {
  const { alert, hist, dismissed } = await load();
  const root = document.getElementById("root");
  const prev = root.querySelector("#mds-gallery");
  const scrollTop = prev ? prev.scrollTop : 0;
  if (!alert) { root.innerHTML = '<div style="color:#fff;padding:24px;font:14px sans-serif">Alert not found.</div>'; return; }
  const kw = alert.keywords || [];
  const hiddenCount = hist.filter((m) => dismissed[m.id]).length;
  const visible = hist.filter((m) => showHidden || !dismissed[m.id]);
  const shown = sorted(filterNew ? visible.filter((m) => m.isNew) : visible);
  const newCount = visible.filter((m) => m.isNew).length;
  document.title = "Matches: " + (alert.name || kw.join(", "));
  root.innerHTML = `
    <div id="mds-gallery">
      <div id="mds-gallery-bar">
        <div class="mds-gbar-left"><span class="mds-gcount">${shown.length}</span>
          match${shown.length === 1 ? "" : "es"}${alert.name ? ` · ${esc(alert.name)}` : ""} <span class="mds-gkw">${esc(M.formatKeywords(kw, alert.exclude))}</span></div>
        <div class="mds-gbar-right">
          <button class="mds-gbtn ${filterNew ? "" : "active"}" data-f="all">All (${visible.length})</button>
          <button class="mds-gbtn ${filterNew ? "active" : ""}" data-f="new">New (${newCount})</button>
          <select class="mds-gsel" id="sort" aria-label="Sort"><option value="newest">Sort: newest</option><option value="price-asc">Sort: price ↑</option><option value="price-desc">Sort: price ↓</option></select>
          ${hiddenCount ? `<button class="mds-gbtn ${showHidden ? "active" : ""}" data-act="toggleHidden">${showHidden ? "Hide hidden" : `Show hidden (${hiddenCount})`}</button>` : ""}
          <button class="mds-gbtn" data-act="openNew" ${newCount ? "" : "disabled"}>Open new (${newCount})</button>
          <button class="mds-gbtn" data-act="copy">Copy links</button>
          <button class="mds-gbtn" data-act="csv">Export CSV</button>
          <button class="mds-gbtn" data-act="clearNew">Clear new</button>
          <button class="mds-gbtn danger" data-act="clearAll">Clear all</button>
        </div>
      </div>
      <div id="mds-gallery-grid"></div>
    </div>`;
  root.querySelector("#sort").value = sortMode;
  const grid = root.querySelector("#mds-gallery-grid");
  if (!shown.length) {
    const e = document.createElement("div");
    e.className = "mds-gempty";
    e.textContent = hist.length ? (filterNew ? "Nothing new — every saved match has been seen." : "All matches are hidden.") : "No matches saved yet.";
    grid.appendChild(e);
  }
  shown.forEach((mt) => {
    const isHidden = !!dismissed[mt.id];
    const card = document.createElement("a");
    card.className = "mds-gcard" + (mt.isNew ? " is-new" : "");
    card.dataset.id = mt.id;
    card.href = mt.url; card.target = "_blank"; card.rel = "noopener";
    if (isHidden) card.style.opacity = ".55";
    const th = document.createElement("div");
    th.className = "mds-gthumb";
    if (mt.isNew) { const n = document.createElement("span"); n.className = "mds-gnew"; n.textContent = "NEW"; th.appendChild(n); }
    if (mt.image) {
      const img = document.createElement("img");
      img.src = mt.image; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
      img.onerror = () => { img.replaceWith(Object.assign(document.createElement("span"), { className: "mds-gph", textContent: "🏠" })); };
      th.appendChild(img);
    } else { const ph = document.createElement("span"); ph.className = "mds-gph"; ph.textContent = "🏠"; th.appendChild(ph); }
    const x = document.createElement("button");
    x.className = "mds-ghide"; x.textContent = isHidden ? "↺" : "×";
    x.title = isHidden ? "Show this listing again" : "Hide this listing from all scans and alerts";
    x.setAttribute("aria-label", x.title);
    x.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      await send({ type: "dismiss", id: mt.id, undo: isHidden });
      if (!isHidden) toast("Hidden — it won't appear in scans or alerts again.", async () => { await send({ type: "dismiss", id: mt.id, undo: true }); });
    };
    th.appendChild(x);
    const meta = document.createElement("div");
    meta.className = "mds-gmeta";
    meta.innerHTML = `<div class="mds-gprice">${esc(mt.price || "")}</div><div class="mds-gtitle">${esc(mt.title || "")}</div>
      <div class="mds-gsnip">${M.highlightSnippet(mt.snippet, (mt.hits && mt.hits.length) ? mt.hits : kw)}</div>`;
    card.append(th, meta);
    grid.appendChild(card);
  });
  root.querySelectorAll("[data-f]").forEach((b) => b.onclick = () => { filterNew = b.dataset.f === "new"; render(); });
  root.querySelector("#sort").onchange = (e) => { sortMode = e.target.value; render(); };
  const act = async (name) => { await send({ type: name, id: alertId }); };
  root.querySelectorAll("[data-act]").forEach((b) => {
    const a = b.dataset.act;
    if (a === "clearAll") b.onclick = () => confirmClick(b, `Delete ${hist.length} saved matches?`, () => act("clearAll"));
    else if (a === "clearNew") b.onclick = () => act("clearNew");
    else if (a === "toggleHidden") b.onclick = () => { showHidden = !showHidden; render(); };
    else if (a === "openNew") b.onclick = async () => {
      const urls = visible.filter((m) => m.isNew).map((m) => m.url).slice(0, 25);
      if (!urls.length) return;
      await send({ type: "openUrls", urls });
      await act("clearNew");
    };
    else if (a === "copy") b.onclick = async () => {
      try { await navigator.clipboard.writeText(shown.map((m) => m.url).join("\n")); toast(`Copied ${shown.length} link${shown.length === 1 ? "" : "s"}.`); }
      catch (_) { toast("Couldn't copy to the clipboard."); }
    };
    else if (a === "csv") b.onclick = () => {
      const blob = new Blob([csvOf(shown)], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `marketplace-matches-${(alert.name || kw.join("-") || alertId).replace(/[^\w-]+/g, "_")}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
  });
  root.querySelector("#mds-gallery").scrollTop = scrollTop;
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && (ch.alerts || ch[HIST_KEY] || ch.dismissed)) render();
});
render();
