// Toolbar popup: create/edit/pause alerts, watch what is running, browse saved matches.
const M = globalThis.MDS;
const { LIMITS, STATUS } = M;
const INTERVALS = [[15, "15 min"], [30, "30 min"], [60, "1 hour"], [180, "3 hours"], [360, "6 hours"], [720, "12 hours"], [1440, "24 hours"]];
const $ = (id) => document.getElementById(id);
const esc = M.escapeHtml;
const send = (msg) => new Promise((resolve) => {
  try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || null); }); } catch (_) { resolve(null); }
});

let feedUrl = null;
let alerts = [];
const ui = {};            // per-alert view state survives re-renders: { open, filter, editing, hist, hidden, scrollTop }
let lastRun = null;       // last runState snapshot from the worker
let stoppingJob = null;   // jobId we asked to stop — keeps "Stopping…" up until the worker confirms

// ---- helpers ----
function intervalSelect(sel, value) {
  sel.innerHTML = INTERVALS.map(([m, l]) => `<option value="${m}">${l}</option>`).join("") + '<option value="custom">Custom…</option>';
  const known = INTERVALS.some(([m]) => m === value);
  sel.value = known ? String(value) : (value ? "custom" : "60");
  return known;
}
function readInterval(sel, custom) {
  const v = sel.value === "custom" ? custom.value : sel.value;
  return M.clampInt(v, LIMITS.minIntervalMin, LIMITS.maxIntervalMin, 60);
}
function statusPill(a) {
  const st = a.enabled === false ? STATUS.paused : STATUS[a.lastStatus];
  if (!st) return "";
  return `<span class="pill ${st.tone}">${esc(st.label)}</span>`;
}
function alertLabel(a) { return a.name || (a.keywords || []).join(", "); }
// Two-step inline confirm for destructive buttons: "Clear 212 saved?" [Yes] [No], auto-reverts.
function confirmClick(btn, label, onYes) {
  if (btn.dataset.armed) return;
  const old = btn.textContent;
  btn.dataset.armed = "1"; btn.textContent = label; btn.disabled = true;
  const yes = document.createElement("button"); yes.type = "button"; yes.className = "sm danger"; yes.textContent = "Yes";
  const no = document.createElement("button"); no.type = "button"; no.className = "sm gray"; no.textContent = "No";
  btn.after(yes, no);
  const reset = () => { yes.remove(); no.remove(); btn.disabled = false; btn.textContent = old; delete btn.dataset.armed; };
  const t = setTimeout(reset, 5000);
  yes.onclick = () => { clearTimeout(t); reset(); onYes(); };
  no.onclick = () => { clearTimeout(t); reset(); };
  no.focus();
}
function thumb(m) {
  const span = document.createElement("span");
  span.className = "thumb";
  if (m.image) {
    const img = document.createElement("img");
    img.src = m.image; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
    img.onerror = () => { span.textContent = "🏠"; };
    span.appendChild(img);
  } else span.textContent = "🏠";
  return span;
}
function resultRow(m) {
  const a = document.createElement("a");
  a.className = "res" + (m.isNew ? " isnew" : "");
  a.href = m.url; a.target = "_blank"; a.rel = "noopener";
  const info = document.createElement("span");
  info.className = "info";
  info.innerHTML = `<span class="price">${esc(m.price || "")}${m.isNew ? '<span class="new">NEW</span>' : ""}</span><span class="ttl">${esc(m.title || "(untitled)")}</span>`;
  a.append(thumb(m), info);
  return a;
}

// ---- new-alert form ----
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const t = tabs && tabs[0];
  if (t && M.isFeedUrl(t.url)) { feedUrl = t.url; $("current").textContent = decodeURIComponent(t.url); }
});
intervalSelect($("interval"), 60);
$("interval").onchange = () => { $("interval-custom-wrap").hidden = $("interval").value !== "custom"; if (!$("interval-custom-wrap").hidden) $("interval-custom").focus(); };
$("new").onsubmit = async (e) => {
  e.preventDefault();
  const note = $("note");
  note.className = "note"; note.textContent = "";
  const kw = M.parseKeywords($("kw").value);
  if (!feedUrl) { note.textContent = "Go to a Marketplace search/category page first."; return; }
  if (!kw.include.length) { note.textContent = kw.exclude.length ? "Add at least one keyword to look for — exclusions alone aren't enough." : "Enter at least one keyword."; return; }
  const btn = $("save");
  btn.disabled = true;
  const r = await send({
    type: "createAlert", url: feedUrl, keywords: kw.include, exclude: kw.exclude,
    matchAll: $("all").checked, searchTitles: $("titles").checked, wholeWord: $("word").checked,
    concurrency: M.clampInt($("conc").value, 1, LIMITS.alertConcurrency, 2),
    intervalMin: readInterval($("interval"), $("interval-custom")),
    max: M.clampInt($("max").value, 1, LIMITS.alertMax, LIMITS.defaultMax),
    priceMin: $("pmin").value === "" ? null : $("pmin").value, priceMax: $("pmax").value === "" ? null : $("pmax").value,
    name: $("name").value,
  });
  btn.disabled = false;
  if (!r || !r.ok) { note.textContent = (r && r.error) || "Couldn't save the alert."; return; }
  note.className = "note ok";
  note.textContent = r.merged ? "You already had this alert — its settings were updated." : "Saved. A quiet baseline scan runs now; you'll be notified about listings that appear after it.";
  $("kw").value = ""; $("name").value = "";
  refresh();
};

// ---- alert cards ----
function editForm(a) {
  const f = document.createElement("form");
  f.className = "edit";
  f.innerHTML = `
    <label>Name <small>(optional)</small></label><input name="name" type="text" maxlength="60" value="${esc(a.name || "")}" />
    <label>Keywords <small>("quoted phrase" · -exclude)</small></label><input name="kw" type="text" value="${esc(M.formatKeywords(a.keywords, a.exclude))}" />
    <div class="row">
      <div><label>Check every</label><select name="interval"></select></div>
      <div class="custom" hidden><label>Minutes</label><input name="custom" type="number" min="${LIMITS.minIntervalMin}" max="${LIMITS.maxIntervalMin}" value="${a.intervalMin}" /></div>
      <div><label>Max scan</label><input name="max" type="number" min="1" max="${LIMITS.alertMax}" value="${a.max || LIMITS.defaultMax}" /></div>
      <div><label>Tabs</label><input name="conc" type="number" min="1" max="${LIMITS.alertConcurrency}" value="${Math.min(a.concurrency || 2, LIMITS.alertConcurrency)}" /></div>
    </div>
    <div class="row opts">
      <label><input name="all" type="checkbox" ${a.matchAll ? "checked" : ""}/> match all</label>
      <label><input name="titles" type="checkbox" ${a.searchTitles ? "checked" : ""}/> titles too</label>
      <label><input name="word" type="checkbox" ${a.wholeWord ? "checked" : ""}/> whole words</label>
    </div>
    <div class="row">
      <div><label>Price min</label><input name="pmin" type="number" min="0" value="${a.priceMin == null ? "" : a.priceMin}" placeholder="any" /></div>
      <div><label>Price max</label><input name="pmax" type="number" min="0" value="${a.priceMax == null ? "" : a.priceMax}" placeholder="any" /></div>
    </div>
    <div class="acts" style="margin-top:8px"><button type="submit" class="sm">Save changes</button><button type="button" class="sm gray" data-cancel>Cancel</button></div>
    <div class="note"></div>`;
  const sel = f.querySelector("[name=interval]"), customWrap = f.querySelector(".custom");
  customWrap.hidden = intervalSelect(sel, a.intervalMin);
  sel.onchange = () => { customWrap.hidden = sel.value !== "custom"; };
  f.querySelector("[data-cancel]").onclick = () => { ui[a.id].editing = false; render(alerts); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const note = f.querySelector(".note");
    const kw = M.parseKeywords(f.querySelector("[name=kw]").value);
    if (!kw.include.length) { note.textContent = "An alert needs at least one keyword."; return; }
    const g = (n) => f.querySelector(`[name=${n}]`);
    const r = await send({ type: "updateAlert", id: a.id, patch: {
      name: g("name").value, keywords: kw.include, exclude: kw.exclude,
      intervalMin: readInterval(sel, g("custom")), max: g("max").value, concurrency: g("conc").value,
      matchAll: g("all").checked, searchTitles: g("titles").checked, wholeWord: g("word").checked,
      priceMin: g("pmin").value === "" ? null : g("pmin").value, priceMax: g("pmax").value === "" ? null : g("pmax").value,
    } });
    if (!r || !r.ok) { note.textContent = (r && r.error) || "Couldn't save."; return; }
    ui[a.id].editing = false;
    refresh();
  };
  return f;
}
function card(a) {
  const st = ui[a.id] || (ui[a.id] = { open: false, filter: "all", editing: false, hist: null, hidden: 0, scrollTop: 0 });
  const div = document.createElement("div");
  div.className = "alert";
  const paused = a.enabled === false;
  const opts = [`every ${a.intervalMin} min`, `max ${a.max || LIMITS.defaultMax}`];
  if (a.matchAll) opts.push("match all"); if (a.searchTitles) opts.push("+titles"); if (a.wholeWord) opts.push("whole words");
  if (a.priceMin != null || a.priceMax != null) opts.push(`price ${a.priceMin == null ? "…" : a.priceMin}–${a.priceMax == null ? "…" : a.priceMax}`);
  const runBits = [];
  if (a.lastRun) {
    runBits.push(`last run ${M.timeAgo(a.lastRun)}`);
    if (a.lastDurationMs) runBits.push(M.fmtDuration(a.lastDurationMs));
    if (a.lastScanned != null) runBits.push(`${a.lastCached || 0} cached · ${a.lastFetched || 0} read`);
  } else if (a.primed === false) runBits.push("baseline scan pending");
  else runBits.push("not run yet");
  if (!paused && a.nextRun) runBits.push(`next ${M.timeUntil(a.nextRun)}`);
  const newCount = a.lastNew || 0, saved = a.histCount || 0;
  const tone = (STATUS[a.lastStatus] || {}).tone;
  div.innerHTML = `
    <div class="title"><b>${esc(alertLabel(a))}</b>${a.name ? `<span class="chip">${esc((a.keywords || []).join(", "))}</span>` : ""}${(a.exclude || []).map((x) => `<span class="chip ex">${esc(x)}</span>`).join("")}${statusPill(a)}</div>
    <div class="meta">${esc(opts.join(" · "))}</div>
    <div class="meta">${esc(runBits.join(" · "))}${a.lastRun ? ` · ${saved} saved, ${newCount} new` : ""}</div>
    ${a.lastError && (tone === "bad" || tone === "warn") ? `<div class="err">${esc(a.lastError)}</div>` : ""}
    <div class="meta prog" id="prog-${a.id}"></div>
    <div class="meta"><a href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.url)}">Open search ↗</a></div>
    <div class="acts">
      <button class="sm gray" type="button" data-results>Results (${saved})</button>
      <button class="sm gray" type="button" data-overlay>Fullscreen</button>
      <button class="sm gray" type="button" data-run>Run now</button>
      <button class="sm gray" type="button" data-edit>Edit</button>
      <button class="sm gray" type="button" data-pause>${paused ? "Resume" : "Pause"}</button>
      <button class="sm gray" type="button" data-del>Remove</button>
    </div>
    <div class="results" id="res-${a.id}" ${st.open ? "" : "hidden"}>
      <div class="resbar">
        <button type="button" class="${st.filter === "all" ? "active" : ""}" data-filter="all">All (${saved})</button>
        <button type="button" class="${st.filter === "new" ? "active" : ""}" data-filter="new">New (${newCount})</button>
        <span class="spacer"></span>
        <button type="button" data-opennew title="Open every NEW match in a background tab">Open new</button>
        <button type="button" data-copy title="Copy the links of the listed matches">Copy links</button>
        <button type="button" data-clearnew>Clear new</button>
        <button type="button" data-clearall>Clear all</button>
      </div>
      <div class="reslist ${st.filter === "new" ? "newonly" : ""}"></div>
    </div>`;
  if (st.editing) div.appendChild(editForm(a));
  const run = div.querySelector("[data-run]");
  if (lastRun && lastRun.kind === "alert" && lastRun.id === a.id) { run.textContent = "Running…"; run.disabled = true; }
  run.onclick = async () => {
    run.disabled = true; run.textContent = "Queued…";
    const r = await send({ type: "runAlert", id: a.id });
    if (r && r.queued === false) run.textContent = r.reason === "running" ? "Already running" : "Already queued";
    setTimeout(pollProgress, 300);
  };
  div.querySelector("[data-del]").onclick = (e) => confirmClick(e.currentTarget, `Remove alert${saved ? ` and ${saved} saved matches` : ""}?`, async () => { await send({ type: "removeAlert", id: a.id }); delete ui[a.id]; refresh(); });
  div.querySelector("[data-overlay]").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("gallery.html?id=" + encodeURIComponent(a.id)) }, () => window.close());
  div.querySelector("[data-edit]").onclick = () => { st.editing = !st.editing; render(alerts); };
  div.querySelector("[data-pause]").onclick = async () => { await send({ type: "updateAlert", id: a.id, patch: { enabled: paused } }); refresh(); };
  div.querySelector("[data-results]").onclick = () => { st.open = !st.open; div.querySelector(".results").hidden = !st.open; if (st.open) fillResults(a.id); };
  div.querySelectorAll("[data-filter]").forEach((b) => b.onclick = () => {
    st.filter = b.dataset.filter;
    div.querySelectorAll("[data-filter]").forEach((x) => x.classList.toggle("active", x === b));
    div.querySelector(".reslist").classList.toggle("newonly", st.filter === "new");
  });
  div.querySelector("[data-clearnew]").onclick = async () => { await send({ type: "clearNew", id: a.id }); refresh(); };
  div.querySelector("[data-clearall]").onclick = (e) => confirmClick(e.currentTarget, `Clear ${saved} saved?`, async () => { await send({ type: "clearAll", id: a.id }); refresh(); });
  div.querySelector("[data-opennew]").onclick = async () => {
    const hist = st.hist || [];
    const urls = hist.filter((m) => m.isNew).map((m) => m.url).slice(0, 25);
    if (!urls.length) return;
    await send({ type: "openUrls", urls });
    await send({ type: "clearNew", id: a.id });
    refresh();
  };
  div.querySelector("[data-copy]").onclick = async (e) => {
    const hist = (st.hist || []).filter((m) => st.filter !== "new" || m.isNew);
    try { await navigator.clipboard.writeText(hist.map((m) => m.url).join("\n")); e.currentTarget.textContent = "Copied"; }
    catch (_) { e.currentTarget.textContent = "Copy failed"; }
    setTimeout(() => refresh(), 1200);
  };
  if (st.open) fillResults(a.id);
  return div;
}
async function fillResults(id) {
  const st = ui[id], panel = $("res-" + id);
  if (!st || !panel) return;
  const r = await send({ type: "getHistory", id });
  st.hist = (r && r.history) || []; st.hidden = (r && r.hidden) || 0;
  const list = panel.querySelector(".reslist");
  if (!list) return;
  list.innerHTML = "";
  if (!st.hist.length) { const e = document.createElement("div"); e.className = "empty"; e.textContent = "No matches saved yet."; list.appendChild(e); }
  st.hist.forEach((m) => list.appendChild(resultRow(m)));
  if (st.hidden) { const e = document.createElement("div"); e.className = "empty"; e.textContent = `${st.hidden} hidden listing${st.hidden === 1 ? "" : "s"} not shown (manage in Fullscreen).`; list.appendChild(e); }
  list.scrollTop = st.scrollTop || 0;
  list.onscroll = () => { st.scrollTop = list.scrollTop; };
}
function render(list) {
  alerts = list || [];
  const box = $("alerts");
  box.innerHTML = "";
  if (!alerts.length) { box.innerHTML = "<small>None yet.</small>"; return; }
  alerts.forEach((a) => box.appendChild(card(a)));
}
async function refresh() {
  const r = await send({ type: "listAlerts" });
  if (!r) return;
  lastRun = r.runState || null;
  render(r.alerts);
  updateActivity(r.runState, r.queued || []);
}

// ---- live progress ----
function updateActivity(rs, queued) {
  const box = $("activity"), txt = $("act-txt"), stop = $("act-stop"), queueEl = $("act-queue");
  document.querySelectorAll(".prog").forEach((el) => { el.textContent = ""; });
  if (rs) {
    const who = rs.kind === "scan" ? "Page scan" : alertLabel(alerts.find((a) => a.id === rs.id) || { keywords: ["alert"] });
    const prog = rs.total ? `${rs.phase} ${rs.done}/${rs.total}` : rs.phase;
    if (stoppingJob === rs.jobId) { txt.textContent = `⏹ Stopping ${who}…`; stop.hidden = true; }
    else { txt.textContent = `▶ ${who}: ${prog}`; stop.hidden = false; stop.dataset.job = rs.jobId; stop.textContent = "Stop"; stop.disabled = false; }
    if (rs.kind === "alert") { const el = $("prog-" + rs.id); if (el) el.textContent = `▶ ${prog}`; }
  } else stoppingJob = null;
  const q = (queued || []).map((j) => (j.kind === "scan" ? "page scan" : alertLabel(alerts.find((a) => a.id === j.id) || { keywords: ["alert"] }) + (j.prime ? " (baseline)" : "")));
  queueEl.textContent = q.length ? "Queued: " + q.join(", ") : "";
  box.hidden = !rs && !q.length;
  if (!rs && q.length) { txt.textContent = "Waiting to start…"; stop.hidden = false; stop.dataset.job = ""; stop.textContent = "Clear queue"; }
}
$("act-stop").onclick = async () => {
  const job = $("act-stop").dataset.job;
  if (job) { stoppingJob = job; $("act-txt").textContent = "⏹ Stopping…"; $("act-stop").hidden = true; await send({ type: "cancelRun", jobId: job }); }
  else await send({ type: "cancelRun", all: true });
  setTimeout(pollProgress, 300);
};
async function pollProgress() {
  const r = await send({ type: "runState" });
  if (!r) return;
  const was = lastRun && lastRun.jobId;
  lastRun = r.runState || null;
  updateActivity(r.runState, r.queued || []);
  if (was && (!lastRun || lastRun.jobId !== was)) refresh();   // a run just finished — refresh counts
}

// Storage changes (a run finishing, the gallery clearing NEW, another popup) re-render
// without losing expanded panels or filters.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.alerts) refresh();
  for (const k of Object.keys(ch)) if (k.startsWith("hist:")) { const id = k.slice(5); if (ui[id] && ui[id].open) fillResults(id); }
});

refresh();
pollProgress();
setInterval(pollProgress, 1200);
