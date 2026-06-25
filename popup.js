let feedUrl = null;
let lastRunningId = null;

function isFeed(url) {
  return /facebook\.com\/marketplace\//.test(url || "") &&
         (/\/search\//.test(url) || /\/category\//.test(url) ||
          /\/marketplace\/\d+\//.test(url) || /\/marketplace\/[a-z]+\/?($|\?)/.test(url));
}
function esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const t = tabs[0];
  if (t && isFeed(t.url)) {
    feedUrl = t.url;
    document.getElementById("current").textContent = decodeURIComponent(t.url);
  }
});

function resultRow(m) {
  const img = m.image
    ? `<img src="${esc(m.image)}" referrerpolicy="no-referrer" loading="lazy">`
    : "🏠";
  const badge = m.isNew ? '<span class="new">NEW</span>' : "";
  return `<a class="res ${m.isNew ? "isnew" : ""}" href="${esc(m.url)}" target="_blank" rel="noopener">
    <span class="thumb">${img}</span>
    <span class="info">
      <span class="price">${esc(m.price || "")}${badge}</span>
      <span class="title">${esc(m.title || "(untitled)")}</span>
    </span></a>`;
}

function render(alerts) {
  const box = document.getElementById("alerts");
  if (!alerts || !alerts.length) { box.innerHTML = "<small>None yet.</small>"; return; }
  box.innerHTML = "";
  alerts.forEach((a) => {
    const div = document.createElement("div");
    div.className = "alert";
    const last = a.lastRun ? new Date(a.lastRun).toLocaleString() : "not yet";
    const results = a.history || [];
    const newCount = a.lastNew != null ? a.lastNew : results.filter((m) => m.isNew).length;
    const countMeta = a.lastRun ? ` · ${results.length} saved, ${newCount} new` : "";
    div.innerHTML = `
      <div><b>${esc(a.keywords.join(", "))}</b> · every ${a.intervalMin} min${a.searchTitles ? " · +titles" : ""}</div>
      <div class="meta">last run: ${esc(last)}${countMeta}</div>
      <div class="meta prog" id="prog-${a.id}"></div>
      <div class="meta"><a href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.url)}">Open search ↗</a></div>
      <div class="acts">
        <button class="sm gray" data-results="${a.id}">Results (${results.length})</button>
        <button class="sm gray" data-overlay="${a.id}">View fullscreen</button>
        <button class="sm gray" data-run="${a.id}">Run now</button>
        <button class="sm gray" data-del="${a.id}">Remove</button>
      </div>
      <div class="results" id="res-${a.id}" hidden>
        <div class="resbar">
          <button class="active" data-filter="all">All (${results.length})</button>
          <button data-filter="new">New (${newCount})</button>
          <span class="spacer"></span>
          <button data-clearall="${a.id}">Clear all</button>
          <button data-clearnew="${a.id}">Clear new</button>
        </div>
        <div class="reslist">${
          results.length ? results.map(resultRow).join("")
                         : '<div class="empty">No matches saved yet.</div>'
        }</div>
      </div>`;
    box.appendChild(div);
  });

  box.querySelectorAll("[data-del]").forEach((b) =>
    b.onclick = () => chrome.runtime.sendMessage({ type: "removeAlert", id: b.dataset.del }, refresh));
  box.querySelectorAll("[data-run]").forEach((b) =>
    b.onclick = () => { b.textContent = "Queued…"; chrome.runtime.sendMessage({ type: "runAlert", id: b.dataset.run }, () => setTimeout(refresh, 400)); });
  box.querySelectorAll("[data-overlay]").forEach((b) =>
    b.onclick = () => {
      const url = chrome.runtime.getURL("gallery.html?id=" + encodeURIComponent(b.dataset.overlay));
      chrome.tabs.create({ url }, () => window.close());
    });
  box.querySelectorAll("[data-results]").forEach((b) =>
    b.onclick = () => { const p = document.getElementById("res-" + b.dataset.results); p.hidden = !p.hidden; });
  box.querySelectorAll("[data-clearnew]").forEach((b) =>
    b.onclick = () => chrome.runtime.sendMessage({ type: "clearNew", id: b.dataset.clearnew }, refresh));
  box.querySelectorAll("[data-clearall]").forEach((b) =>
    b.onclick = () => chrome.runtime.sendMessage({ type: "clearAll", id: b.dataset.clearall }, refresh));
  // All / New filter toggle (only the filter buttons, not the clear buttons)
  box.querySelectorAll(".resbar [data-filter]").forEach((b) =>
    b.onclick = () => {
      const bar = b.parentElement;
      bar.querySelectorAll("[data-filter]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      bar.nextElementSibling.classList.toggle("newonly", b.dataset.filter === "new");
    });
}

// Live progress of the currently-running alert, polled without re-rendering the
// list (so expanded result panels and filters aren't disturbed).
function pollProgress() {
  chrome.runtime.sendMessage({ type: "runState" }, (r) => {
    if (chrome.runtime.lastError) return;
    const rs = r && r.runState;
    document.querySelectorAll(".prog").forEach((el) => { el.textContent = ""; });
    if (rs && rs.id) {
      const el = document.getElementById("prog-" + rs.id);
      if (el) el.textContent = rs.total ? `▶ ${rs.phase} ${rs.done}/${rs.total}` : `▶ ${rs.phase}`;
    }
    const nowId = rs && rs.id ? rs.id : null;
    if (lastRunningId && !nowId) refresh();   // a run just finished — refresh counts/history
    lastRunningId = nowId;
  });
}

function refresh() { chrome.runtime.sendMessage({ type: "listAlerts" }, (r) => render(r && r.alerts)); }

document.getElementById("save").onclick = () => {
  const note = document.getElementById("note");
  note.textContent = "";
  const kw = document.getElementById("kw").value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!feedUrl) { note.textContent = "Go to a Marketplace search/category page first."; return; }
  if (!kw.length) { note.textContent = "Enter at least one keyword."; return; }
  chrome.runtime.sendMessage({
    type: "createAlert",
    url: feedUrl,
    keywords: kw,
    matchAll: document.getElementById("all").checked,
    searchTitles: document.getElementById("titles").checked,
    concurrency: Math.max(1, Math.min(5, parseInt(document.getElementById("conc").value, 10) || 3)),
    intervalMin: parseInt(document.getElementById("interval").value, 10),
    max: Math.max(1, Math.min(200, parseInt(document.getElementById("max").value, 10) || 40))
  }, () => { document.getElementById("kw").value = ""; refresh(); });
};

refresh();
pollProgress();
setInterval(pollProgress, 1200);
