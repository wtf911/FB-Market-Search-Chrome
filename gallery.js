// Standalone fullscreen view of one alert's saved matches. Opened in its own
// extension tab (no Facebook page loaded). Reuses the gallery styles from
// panel.css and offers the same controls as the alert window: All / New filter
// and Clear new / Clear all.

const alertId = new URLSearchParams(location.search).get("id");
let filterNew = false;

function esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function highlightSnippet(snip, hits) {
  let html = esc((snip || "").slice(0, 200));
  (hits || []).forEach((k) => {
    if (!k) return;
    const re = new RegExp("(" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
    html = html.replace(re, "<mark>$1</mark>");
  });
  return html + "…";
}
function getAlert(cb) {
  chrome.storage.local.get(["alerts"], (s) => cb((s.alerts || []).find((a) => a.id === alertId)));
}

function render() {
  getAlert((alert) => {
    const root = document.getElementById("root");
    if (!alert) { root.innerHTML = '<div style="color:#fff;padding:24px;font:14px sans-serif">Alert not found.</div>'; return; }
    const matches = alert.history || [];
    const kw = alert.keywords || [];
    const newCount = matches.filter((m) => m.isNew).length;
    document.title = "Matches: " + kw.join(", ");
    const kwChip = kw.length ? `<span class="mds-gkw">${esc(kw.join(", "))}</span>` : "";
    root.innerHTML = `
      <div id="mds-gallery">
        <div id="mds-gallery-bar">
          <div class="mds-gbar-left"><span class="mds-gcount">${matches.length}</span>
            match${matches.length === 1 ? "" : "es"} ${kwChip}</div>
          <div class="mds-gbar-right">
            <button class="mds-gbtn ${filterNew ? "" : "active"}" data-f="all">All (${matches.length})</button>
            <button class="mds-gbtn ${filterNew ? "active" : ""}" data-f="new">New (${newCount})</button>
            <button class="mds-gbtn" data-act="clearAll">Clear all</button>
            <button class="mds-gbtn" data-act="clearNew">Clear new</button>
          </div>
        </div>
        <div id="mds-gallery-grid" class="${filterNew ? "newonly" : ""}"></div>
      </div>`;
    const grid = root.querySelector("#mds-gallery-grid");
    if (!matches.length) {
      grid.innerHTML = '<div style="color:#9aa3ad;padding:20px;font:14px sans-serif">No matches saved yet.</div>';
    }
    matches.forEach((mt) => {
      const card = document.createElement("a");
      card.className = "mds-gcard" + (mt.isNew ? " is-new" : "");
      card.href = mt.url; card.target = "_blank"; card.rel = "noopener";
      const thumb = mt.image || "";
      card.innerHTML = `
        <div class="mds-gthumb">${mt.isNew ? '<span class="mds-gnew">NEW</span>' : ""}${
          thumb ? `<img src="${esc(thumb)}" loading="lazy" referrerpolicy="no-referrer">` : '<span class="mds-gph">🏠</span>'
        }</div>
        <div class="mds-gmeta">
          <div class="mds-gprice">${esc(mt.price || "")}</div>
          <div class="mds-gtitle">${esc(mt.title || "")}</div>
          <div class="mds-gsnip">${highlightSnippet(mt.snippet, (mt.hits && mt.hits.length) ? mt.hits : kw)}</div>
        </div>`;
      grid.appendChild(card);
    });
    root.querySelectorAll("[data-f]").forEach((b) =>
      b.onclick = () => { filterNew = b.dataset.f === "new"; render(); });
    root.querySelectorAll("[data-act]").forEach((b) =>
      b.onclick = () => chrome.runtime.sendMessage({ type: b.dataset.act, id: alertId }, () => render()));
  });
}

render();
