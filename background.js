// Service worker.
//   * Manual scan: the on-page panel (content.js) collects listing IDs itself and hands
//     them over; we read each listing in a pooled background tab.
//   * Scheduled alerts: re-scan a saved feed (newest-first) on a timer and notify on
//     NEW description matches.
// Descriptions aren't in a listing's raw HTML (Facebook renders them with JS), so we
// open each listing in a background tab and read the rendered DOM, through a small
// pool of tabs in parallel. Every listing we read is cached by id (LIMITS.cacheTtlMs)
// so repeat runs only open what is actually new.
//
// Lifetime: Chrome kills this worker after 30 s without an extension API call, and
// whenever one call runs longer than 5 minutes. Every step of a run is an API call
// (each resets the idle timer) and the longest single call — the feed collector
// injection — is capped at ~3 minutes, so runs survive. Keep both invariants when
// changing timings, and keep anything that must outlive the worker in chrome.storage
// (see trackTabs, armAlarm, migrate).
importScripts("shared.js");
const { LIMITS, STATUS, itemUrl, matchText, snippetAround, withNewestSort, isFeedUrl,
        priceInRange, extractPrice, descPriceNum, alertKey, clampInt } = MDS;

const pool = [];          // helper tab ids — mutated in place ONLY (push/splice), never reassigned:
                          // a cancel-initiated closePool and the next job's getPool can overlap
let parkedTab = null;     // keep-alive tab (parked.html) left when closing the last helper would quit Chrome
let busy = false;
let jobQueue = [];        // { jobId, kind: "scan"|"alert", src?, id?, manual?, prime?, scanId?, run? }
let currentJob = null;    // the job pumpQueue is executing (carries its cancel token)
let runState = null;      // { kind, id, jobId, tabId, phase, done, total } for popup progress
let collectorTab = null;  // feed tab of the active run, so cancel can close it mid-scroll
const ALARM_PREFIX = "mds-alert-";
const WATCHDOG = "mds-watchdog";
const BLOCK_RULE_ID = 7001;
const PARK_URL = chrome.runtime.getURL("parked.html");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.random() * (hi - lo);
const warn = (...a) => console.warn("[mds]", ...a);
function withTimeout(p, ms, label) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error((label || "operation") + " timed out")), ms); })])
    .finally(() => clearTimeout(t));
}

// ===================== STORAGE =====================
const store = chrome.storage.local;
const getAlerts = async () => (await store.get("alerts")).alerts || [];
const setAlerts = (a) => store.set({ alerts: a });
const histKey = (id) => "hist:" + id;
const getHist = async (id) => (await store.get(histKey(id)))[histKey(id)] || [];
async function setHist(id, arr) {
  try { await store.set({ [histKey(id)]: arr }); }
  catch (e) {
    warn("history write failed, keeping the newest half", e);
    if (arr.length > 10) await store.set({ [histKey(id)]: arr.slice(0, Math.floor(arr.length / 2)) });
    else throw e;
  }
}
// Every read-modify-write of alert data goes through one chain, so a finishing run, the
// popup and the gallery can't overwrite each other's changes.
let chain = Promise.resolve();
function withStore(fn) {
  const p = chain.then(fn, fn);
  chain = p.then(() => {}, () => {});
  return p;
}
const mutateAlerts = (fn) => withStore(async () => { const alerts = await getAlerts(); const r = await fn(alerts); await setAlerts(alerts); return r; });
const patchAlert = (id, patch) => mutateAlerts((alerts) => { const a = alerts.find((x) => x.id === id); if (a) Object.assign(a, patch); return a || null; });

const loadCache = async () => (await store.get("descCache")).descCache || {};
async function saveCache(cache) {
  const ids = Object.keys(cache);
  if (ids.length > LIMITS.cacheMax) {
    ids.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
    for (const id of ids.slice(0, ids.length - LIMITS.cacheMax)) delete cache[id];
  }
  try { await store.set({ descCache: cache }); } catch (e) { warn("cache write failed", e); }
}
const loadDismissed = async () => (await store.get("dismissed")).dismissed || {};

// Rolling per-hour page-load budget shared by every run (storage.session survives worker
// restarts but not a browser restart, which is the right scope).
async function budgetCount() {
  const { budget } = await chrome.storage.session.get("budget");
  return budget && Date.now() - budget.start <= 3600e3 ? budget.count : 0;
}
async function budgetAdd(n) {
  try {
    const { budget } = await chrome.storage.session.get("budget");
    const b = budget && Date.now() - budget.start <= 3600e3 ? budget : { start: Date.now(), count: 0 };
    b.count += n;
    await chrome.storage.session.set({ budget: b });
  } catch (_) {}
}

// ===================== QUEUE =====================
// One global FIFO so alert runs and in-page scans never overlap (shared tab pool).
function queuedSummary() {
  return jobQueue.map((j) => ({ jobId: j.jobId, kind: j.kind, id: j.id || null, src: j.src || null, manual: !!j.manual, prime: !!j.prime }));
}
function enqueueJob(job) {
  job.jobId = job.jobId || crypto.randomUUID();
  if (job.kind === "alert") {
    const same = (j) => j.kind === "alert" && j.id === job.id;
    if (jobQueue.some(same)) return { queued: false, reason: "queued" };
    if (currentJob && same(currentJob)) return { queued: false, reason: "running" };
  }
  jobQueue.push(job);
  pumpQueue();
  return { queued: true, jobId: job.jobId, position: jobQueue.length };
}
async function pumpQueue() {
  if (busy || !jobQueue.length) return;
  busy = true;
  await startup;
  const job = jobQueue.shift();
  if (!job) { busy = false; return; }          // cancelled while we waited for startup
  job.cancel = { requested: false };           // fresh token — a cancel only ever stops THIS job
  currentJob = job;
  try {
    if (job.kind === "alert") await runAlertById(job);
    else await job.run(job);
  } catch (e) { console.error("[mds] job failed", job.kind, job.id || job.src, e); }
  finally { currentJob = null; busy = false; pumpQueue(); }
}
// Targeted cancel: queued jobs matching pred are dropped (their panels are told), and a
// matching RUNNING job gets its token flagged and its tabs closed right away — workers
// check the token before recreating a tab, so nothing reopens.
async function cancelJobs(pred) {
  const dropped = jobQueue.filter(pred);
  jobQueue = jobQueue.filter((j) => !pred(j));
  for (const j of dropped) {
    if (j.kind === "scan" && j.src != null)
      chrome.tabs.sendMessage(j.src, { type: "complete", scanId: j.scanId, matches: [], cancelled: true, dropped: true }).catch(() => {});
  }
  if (currentJob && pred(currentJob) && !currentJob.cancel.requested) {
    currentJob.cancel.requested = true;
    const c = collectorTab;
    collectorTab = null;
    if (c != null) await safeCloseTab(c);     // breaks the in-tab scroll loop instantly
    await closePool();
    return { cancelled: true, dropped: dropped.length };
  }
  return { cancelled: false, dropped: dropped.length };
}

// ===================== TAB POOL =====================
const muteTab = (id) => chrome.tabs.update(id, { muted: true }).catch(() => {});
// Mirror the tabs we own into session storage so a worker restart mid-run (extension
// reload, crash) can close them at the next start instead of leaving them open.
async function trackTabs() {
  try { await chrome.storage.session.set({ helperTabs: [...pool, collectorTab, parkedTab].filter((x) => x != null) }); } catch (_) {}
}
async function reconcileOrphans() {
  try {
    const { helperTabs = [] } = await chrome.storage.session.get("helperTabs");
    for (const id of helperTabs) if (!pool.includes(id) && id !== parkedTab) await safeCloseTab(id);
    await chrome.storage.session.set({ helperTabs: [] });
  } catch (_) {}
}
// Close a helper tab, but NEVER close the last remaining tab — that quits Chrome, which
// stops scheduled alerts. Park it on our explainer page instead and reuse it next run.
async function safeCloseTab(id) {
  if (id == null) return;
  try {
    const all = await chrome.tabs.query({ windowType: "normal" });
    if (all.length <= 1) { await chrome.tabs.update(id, { url: PARK_URL }); parkedTab = id; return; }
  } catch (_) {}
  for (let i = 0; i < 4; i++) {
    try { await chrome.tabs.remove(id); break; }
    catch (e) { if (/No tab with id/i.test(String(e))) break; await delay(250); }  // Chrome refuses during tab-strip drags; retry briefly
  }
  if (parkedTab === id) parkedTab = null;
}
// Pool tabs never need photos or video: block them so pages settle sooner and use less
// memory. The feed collector is not in the pool (its thumbnails come from the cards).
async function applyBlockRules() {
  if (!chrome.declarativeNetRequest) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [BLOCK_RULE_ID],
      addRules: pool.length ? [{ id: BLOCK_RULE_ID, priority: 1, action: { type: "block" },
        condition: { tabIds: pool.slice(), resourceTypes: ["image", "media"] } }] : [],
    });
  } catch (e) { warn("declarativeNetRequest", e); }
}
async function getPool(n, shouldAbort) {
  n = Math.max(1, Math.min(LIMITS.maxConcurrency, n || 3));
  if (parkedTab != null) {
    // adopt the parked keep-alive tab only if it is still ours (the user may have typed a URL into it)
    try { const t = await chrome.tabs.get(parkedTab); if (t.url === PARK_URL && !pool.includes(parkedTab)) pool.push(parkedTab); } catch (_) {}
    parkedTab = null;
  }
  const alive = [];
  for (const id of pool) { try { await chrome.tabs.get(id); alive.push(id); } catch (_) {} }
  pool.splice(0, pool.length, ...alive);
  while (pool.length < n && !(shouldAbort && shouldAbort())) {
    const t = await chrome.tabs.create({ url: "about:blank", active: false });
    pool.push(t.id);
    muteTab(t.id);
  }
  await trackTabs();
  await applyBlockRules();
  return pool.slice(0, n);
}
async function closePool() {
  const ids = pool.splice(0);
  for (const id of ids) await safeCloseTab(id);
  await applyBlockRules();
  await trackTabs();
}
// Return a live tab id; if the given one was closed, make a fresh one (unless aborting).
async function ensureTab(tabId, shouldAbort) {
  try { await chrome.tabs.get(tabId); return tabId; }
  catch (_) {
    if (shouldAbort && shouldAbort()) throw new Error("aborted");
    const t = await chrome.tabs.create({ url: "about:blank", active: false });
    pool.push(t.id);
    muteTab(t.id);
    await trackTabs();
    await applyBlockRules();
    return t.id;
  }
}

function waitForTab(tabId, test, timeoutMs) {
  return new Promise((resolve) => {
    const finish = (ok) => {
      chrome.tabs.onUpdated.removeListener(upd);
      chrome.tabs.onRemoved.removeListener(gone);
      clearTimeout(timer);
      resolve(ok);
    };
    const upd = (id, info, tab) => { if (id === tabId && test(info, tab)) finish(true); };
    const gone = (id) => { if (id === tabId) finish(false); };      // closed (e.g. cancel) — don't wait out the timeout
    chrome.tabs.onUpdated.addListener(upd);
    chrome.tabs.onRemoved.addListener(gone);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
const waitForComplete = (tabId, ms = 20000) => waitForTab(tabId, (info) => info.status === "complete", ms);
// Resolve as soon as the navigation to the listing has committed (URL changed), or the
// page finished loading somewhere else (a login redirect) — not the load event, which
// waits for every photo. scrapePage verifies where the tab actually landed.
const waitForItem = (tabId, id, ms = 20000) =>
  waitForTab(tabId, (info) => (info.url && info.url.includes("/marketplace/item/" + id)) || info.status === "complete", ms);

// Global pacing across all workers so navigations never fire in a metronomic burst.
const pacer = {
  next: 0,
  async acquire() {
    const now = Date.now();
    const wait = Math.max(0, this.next - now);
    this.next = Math.max(now, this.next) + jitter(1000, 2000);
    if (wait) await delay(wait);
  },
};

// ---- runs INSIDE a listing tab (injected as early as possible; it waits for the
// description itself). Self-contained: MDS is not available this early.
function scrapePage(id) {
  return new Promise((resolve) => {
    const started = Date.now(), deadline = started + 12000;
    const DESC = ["Description", "Beschreibung", "Descripción", "Descrição", "Descrizione", "Beschrijving", "Opis", "Popis",
      "Leírás", "Beskrivelse", "Beskrivning", "Kuvaus", "Açıklama", "Описание", "Περιγραφή", "תיאור", "الوصف", "รายละเอียด",
      "Deskripsi", "Paglalarawan", "Mô tả", "説明", "설명", "描述", "詳細資料"];
    const END = ["Seller information", "Seller details", "Today's picks", "Location is approximate", "More like this", "Sponsored",
      "Verkäuferinformationen", "Información del vendedor", "Informações do vendedor", "Informations sur le vendeur",
      "Informazioni sul venditore", "ข้อมูลผู้ขาย", "Informasi penjual", "Thông tin người bán"];
    const MORE = ["See more", "Mehr anzeigen", "Ver más", "Ver mais", "Voir plus", "Mostra altro", "Meer weergeven", "Zobacz więcej",
      "ดูเพิ่มเติม", "Lihat selengkapnya", "Xem thêm", "もっと見る", "더 보기", "查看更多", "Daha fazla gör", "Ещё", "Visa mer", "Vis mere", "Näytä lisää"];
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const DESC_RE = new RegExp("\\n(?:" + DESC.map(esc).join("|") + ")\\n", "i");
    const END_RE = new RegExp("\\n(?:" + END.map(esc).join("|") + ")\\n", "i");
    const MORE_RE = new RegExp("^(?:" + MORE.map(esc).join("|") + ")$", "i");
    const meta = (p) => { const el = document.querySelector('meta[property="' + p + '"]'); return el ? (el.content || "") : ""; };
    let clicked = false;
    function pageState(body) {
      const p = location.pathname;
      if (/^\/(login|checkpoint|recover|two_step_verification)/.test(p) || document.querySelector('form[action*="/login"]')) return "login";
      if (/temporarily blocked|we limit how often|you can't use this feature/i.test(body.slice(0, 3000))) return "blocked";
      if (!p.includes("/marketplace/item/" + id)) return "wrong-page";
      return "ok";
    }
    // Expand "See more" once — inside role=button elements only, never anchors (a "See more"
    // link in a sidebar module would navigate the tab away).
    function expand() {
      if (clicked) return false;
      clicked = true;
      let did = false;
      document.querySelectorAll('div[role="button"], span[role="button"], span').forEach((e) => {
        if (!MORE_RE.test((e.textContent || "").trim()) || e.closest("a[href]")) return;
        try { e.click(); did = true; } catch (_) {}
      });
      return did;
    }
    function read() {
      const body = (document.body ? document.body.innerText : "") || "";
      const m = body.search(DESC_RE);
      const headingFound = m > -1;
      let desc = "", header = body.slice(0, 600);
      if (headingFound) {
        header = body.slice(0, m);
        const rest = body.slice(m).replace(/^\n[^\n]*\n/, "");
        // Search with a leading newline so an END marker directly after the heading
        // (blank description) is found instead of being read as the description.
        const end = ("\n" + rest).search(END_RE);
        desc = (end > -1 ? rest.slice(0, Math.max(0, end - 1)) : rest.slice(0, 4000)).trim();
      }
      return { body, desc, header, headingFound };
    }
    function finish(r, source, state) {
      const title = (document.title || "").replace(/\s*\|\s*Facebook\s*$/i, "").replace(/^Marketplace\s*[–\-]\s*/i, "").trim()
        || meta("og:title") || "(untitled listing)";
      const og = meta("og:image");
      resolve({ state: state || pageState(r.body), descFound: !!r.desc, description: r.desc, source, title, header: r.header,
        image: /^https?:/.test(og) ? og : "", href: location.href, ms: Date.now() - started });
    }
    function attempt() {
      const r = read();
      const st = pageState(r.body);
      if (st !== "ok") { r.desc = ""; return finish(r, "none", st); }
      if (r.desc) {
        // First sight of the description: expand "See more" and re-read after the
        // re-render, so long descriptions are searched in full.
        if (expand()) return setTimeout(attempt, 400);
        return finish(r, "marker");
      }
      const og = meta("og:description");
      const unavailable = /isn't available|no longer available|content isn't available|has been removed/i.test(r.body.slice(0, 2500));
      const elapsed = Date.now() - started;
      if (unavailable && elapsed > 1500) return finish(r, "none", "unavailable");
      if (r.headingFound && elapsed > 1500) return finish(r, "blank");   // heading rendered, section empty: the seller wrote nothing
      // No heading (blank description, or a UI language we don't have a marker for):
      // fall back to og:description after a short grace period rather than the whole page.
      if (Date.now() >= deadline || (og && elapsed > 4000)) {
        if (og) { r.desc = og.trim(); return finish(r, "og"); }
        return finish(r, "none");
      }
      setTimeout(attempt, 350);
    }
    attempt();
  });
}

function judgeListing(id, d, o) {
  const r = matchText({ description: d.description, title: d.title }, o);
  let matched = r.matched;
  if (matched && (o.priceMin != null || o.priceMax != null)) {
    const n = d.priceNum != null && d.priceNum > 0 ? d.priceNum : (d.descPriceNum != null ? d.descPriceNum : d.priceNum);
    matched = priceInRange(n, o.priceMin, o.priceMax);
  }
  return { id, url: itemUrl(id), matched, hits: r.hits, titleHits: r.titleHits, excludedBy: r.excludedBy,
    title: d.title, price: d.price || "", priceNum: d.priceNum == null ? null : d.priceNum, descPriceNum: d.descPriceNum == null ? null : d.descPriceNum,
    snippet: snippetAround(d.description, r.hits), image: d.image || "", noDesc: !d.descFound, source: d.source };
}
function cacheEntry(d) {
  const p = extractPrice(d.header || "");
  return { ts: Date.now(), state: d.state, description: d.description, descFound: d.descFound, source: d.source, title: d.title,
    price: p.price, priceNum: p.priceNum, descPriceNum: descPriceNum(d.description), image: d.image };
}
async function scanOneInTab(tabId, id, o) {
  const url = itemUrl(id);
  try {
    await pacer.acquire();
    const nav = waitForItem(tabId, id);
    await chrome.tabs.update(tabId, { url, active: false });
    if (!(await nav)) return { id, url, error: "timeout" };
    const [res] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, func: scrapePage, args: [id], injectImmediately: true }), 30000, "scrape");
    const d = res && res.result;
    if (!d) return { id, url, error: "no data" };
    if (d.state === "unavailable") return { id, url, state: "unavailable", matched: false, entry: { ts: Date.now(), state: "unavailable" } };
    if (d.state !== "ok") return { id, url, state: d.state, error: d.state };
    const entry = cacheEntry(d);
    return { entry, ...judgeListing(id, entry, o) };
  } catch (e) { return { id, url, error: String(e && e.message || e) }; }
}

// Parallel scan across a pool of tabs. Cached and dismissed ids never open a tab.
// ctx: { concurrency, onProgress(done,total,result,stats), shouldAbort, cache, dismissed, noCache }
async function scanIds(ids, opts, ctx) {
  const out = { matches: [], scanned: 0, fetched: 0, cached: 0, skipped: 0, errors: 0, noDesc: 0, unavailable: 0, aborted: null };
  const cache = ctx.cache || {}, dismissed = ctx.dismissed || {};
  const report = (r) => ctx.onProgress && ctx.onProgress(out.scanned, ids.length - out.skipped, r, out);
  const toFetch = [];
  for (const id of ids) {
    if (dismissed[id]) { out.skipped++; continue; }
    const c = cache[id];
    const fresh = c && !ctx.noCache && Date.now() - c.ts < LIMITS.cacheTtlMs;
    if (fresh && c.state === "ok") {
      out.scanned++; out.cached++;
      const r = judgeListing(id, c, opts);
      r.fromCache = true;
      if (r.noDesc) out.noDesc++;
      if (r.matched) out.matches.push(r);
      report(r);
      continue;
    }
    if (fresh && c.state === "unavailable") { out.scanned++; out.cached++; out.unavailable++; report({ id, state: "unavailable", fromCache: true }); continue; }
    toFetch.push(id);
  }
  if (!toFetch.length || (ctx.shouldAbort && ctx.shouldAbort())) return out;
  const tabs = await getPool(Math.min(ctx.concurrency || 3, toFetch.length), ctx.shouldAbort);
  if (!tabs.length) { out.aborted = "cancelled"; return out; }
  let next = 0, consecutiveBad = 0, stop = false;
  const abort = () => stop || (ctx.shouldAbort && ctx.shouldAbort());
  async function worker(tabId) {
    let n = 0;
    while (!abort()) {
      const i = next++;
      if (i >= toFetch.length) return;
      const id = toFetch[i];
      tabId = await ensureTab(tabId, abort);
      let r = await scanOneInTab(tabId, id, opts);
      if (r.error && !r.state && !abort()) {           // one retry for transient failures (timeout, tab closed)
        tabId = await ensureTab(tabId, abort);
        r = await scanOneInTab(tabId, id, opts);
      }
      if (abort()) return;
      out.scanned++; out.fetched++;
      const entry = r.entry;
      delete r.entry;
      if (r.state === "login" || r.state === "blocked") {
        out.errors++;
        // Three in a row means the session is gone — stop instead of walking the whole list.
        if (++consecutiveBad >= 3) { out.aborted = r.state; stop = true; report(r); return; }
      } else {
        consecutiveBad = 0;
        if (entry) cache[id] = entry;
        if (r.state === "unavailable") out.unavailable++;
        else if (r.error) out.errors++;
        else { if (r.noDesc) out.noDesc++; if (r.matched) out.matches.push(r); }
      }
      report(r);
      await delay(++n % 15 === 0 ? jitter(3000, 7000) : jitter(300, 900));
    }
  }
  const settled = await Promise.allSettled(tabs.map((t) => worker(t)));
  for (const s of settled) if (s.status === "rejected" && !/aborted/.test(String(s.reason))) { warn("worker failed", s.reason); out.errors++; }
  return out;
}

// Inject the shared collector into a feed tab. This is a single API call that can run
// for ~3 minutes — keep it under the worker's 5-minute per-call cap (see header).
async function collectFrom(tabId, max) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "collector.js"] });
    const [res] = await withTimeout(chrome.scripting.executeScript({
      target: { tabId }, func: (m) => globalThis.__mdsCollect(m, { restoreScroll: false }), args: [max],
    }), 200000, "collect");
    const o = (res && res.result) || {};
    return { ids: o.ids || [], thumbs: o.thumbs || {}, scrolled: !!o.scrolled, scrollable: !!o.scrollable, state: o.state || "ok", href: o.href || "", error: null };
  } catch (e) { return { ids: [], thumbs: {}, scrolled: false, scrollable: false, state: "ok", href: "", error: String(e && e.message || e) }; }
}

// Chrome won't render tabs in an occluded/minimised window, so Facebook never lazy-loads
// there. Foregrounding the collector fixes that — but it yanks the user's focus, so it is
// allowed only for a manual "Run now" or while the user has been idle for 2 minutes.
async function mayForeground(manual) {
  if (manual) return true;
  try { return (await chrome.idle.queryState(120)) !== "active"; } catch (_) { return false; }
}
async function foregroundCollector(collector, prevFocusedId) {
  let winState = null, prevActiveId = null;
  const winId = collector.windowId;
  try {
    const win = await chrome.windows.get(winId);
    winState = win.state;
    const [prevActive] = await chrome.tabs.query({ active: true, windowId: winId });
    prevActiveId = prevActive && prevActive.id;
    if (winState === "minimized") await chrome.windows.update(winId, { state: "normal" });
    await chrome.windows.update(winId, { focused: true });
    await chrome.tabs.update(collector.id, { active: true });
  } catch (_) {}
  return {
    // give the user their tab and window back as soon as collection is done…
    restoreFocus: async () => {
      try {
        if (prevActiveId != null) await chrome.tabs.update(prevActiveId, { active: true });
        if (prevFocusedId != null && prevFocusedId !== winId) await chrome.windows.update(prevFocusedId, { focused: true });
      } catch (_) {}
    },
    // …but keep the window un-minimised (rendering) until the per-item scrape is over.
    restoreWindow: async () => { try { if (winState === "minimized") await chrome.windows.update(winId, { state: "minimized" }); } catch (_) {} },
  };
}

// Open a feed, collect ids (newest first if caller passed a sorted URL), scan.
// o: { feedUrl, max, concurrency, match, noCache }; ctx: { manual, cancel, cache, dismissed, onProgress }
async function runFeedScan(o, ctx) {
  const cancelled = () => !!(ctx.cancel && ctx.cancel.requested);
  const res = { matches: [], ids: [], thumbs: {}, state: "ok", error: null, scanned: 0, fetched: 0, cached: 0, skipped: 0,
    errors: 0, noDesc: 0, unavailable: 0, aborted: null, partial: false, foregrounded: false };
  if (cancelled()) { res.state = "cancelled"; return res; }
  const prevFocused = await chrome.windows.getLastFocused().catch(() => null);
  let collector;
  try { collector = await chrome.tabs.create({ url: o.feedUrl, active: false }); }
  catch (e) { res.state = "error"; res.error = "Could not open a tab: " + (e && e.message || e); return res; }
  collectorTab = collector.id;
  await trackTabs();
  muteTab(collector.id);
  let restoreFocus = null, restoreWindow = null;
  try {
    await waitForComplete(collector.id);
    if (cancelled()) { res.state = "cancelled"; return res; }
    let out = await collectFrom(collector.id, o.max);
    if (!cancelled() && !out.error && out.state === "ok" && out.ids.length < o.max && !out.scrolled && out.scrollable) {
      if (await mayForeground(ctx.manual)) {
        const fg = await foregroundCollector(collector, prevFocused && prevFocused.id);
        restoreFocus = fg.restoreFocus; restoreWindow = fg.restoreWindow; res.foregrounded = true;
        out = await collectFrom(collector.id, o.max);
      } else res.partial = true;   // user is active: take what we got, don't steal focus
    }
    if (collectorTab === collector.id) { await safeCloseTab(collector.id); collectorTab = null; await trackTabs(); }
    if (restoreFocus) { await restoreFocus(); restoreFocus = null; }
    if (cancelled()) { res.state = "cancelled"; return res; }
    if (out.error) { res.state = "error"; res.error = out.error; return res; }
    if (out.state !== "ok") { res.state = out.state; return res; }
    res.ids = out.ids; res.thumbs = out.thumbs;
    if (!out.ids.length) { res.state = "empty"; return res; }
    const scan = await scanIds(out.ids, o.match, { concurrency: o.concurrency, onProgress: ctx.onProgress, shouldAbort: cancelled,
      cache: ctx.cache, dismissed: ctx.dismissed, noCache: o.noCache });
    Object.assign(res, scan);
    if (cancelled()) res.state = "cancelled";
    else if (scan.aborted) res.state = scan.aborted;
    // Prefer the feed thumbnail (the listing's own card image) over the item-page og:image.
    for (const m of res.matches) if (out.thumbs[m.id]) m.image = out.thumbs[m.id];
    return res;
  } finally {
    if (collectorTab === collector.id) { await safeCloseTab(collector.id); collectorTab = null; await trackTabs(); }
    if (restoreFocus) await restoreFocus();
    if (restoreWindow) await restoreWindow();
    if (res.fetched) budgetAdd(res.fetched);
  }
}

// ===================== ALERTS =====================
const matchOpts = (a) => ({ include: a.keywords || [], exclude: a.exclude || [], matchAll: !!a.matchAll, searchTitles: !!a.searchTitles,
  wholeWord: !!a.wholeWord, priceMin: a.priceMin == null ? null : a.priceMin, priceMax: a.priceMax == null ? null : a.priceMax });
const historyEntry = (m, isNew) => ({ id: m.id, url: m.url, title: m.title, price: m.price, priceNum: m.priceNum, snippet: m.snippet,
  image: m.image || "", hits: m.hits || [], isNew, ts: Date.now() });

// One-shot alarms re-armed from the END of each run, so long runs never chain
// back-to-back and alerts that share an interval drift apart instead of firing in lockstep.
async function armAlarm(alert, minutes) {
  const when = Date.now() + Math.max(1, minutes) * 60e3 + jitter(0, 60e3);
  await chrome.alarms.create(ALARM_PREFIX + alert.id, { when });
  await patchAlert(alert.id, { nextRun: when });
}
async function reRegisterAllAlarms() {
  const alerts = await getAlerts();
  const existing = await chrome.alarms.getAll();
  const have = new Set(existing.filter((a) => a.name.startsWith(ALARM_PREFIX)).map((a) => a.name.slice(ALARM_PREFIX.length)));
  for (const a of alerts) {
    if (a.enabled === false) { if (have.has(a.id)) await chrome.alarms.clear(ALARM_PREFIX + a.id); continue; }
    if (have.has(a.id)) continue;
    // Missing alarm (worker died before re-arming, or a fresh profile): resume the cadence
    // from the last run rather than firing everything one minute after startup.
    const due = (a.lastRun || 0) + (a.intervalMin || 60) * 60e3;
    await armAlarm(a, Math.max(1, (due - Date.now()) / 60e3));
  }
  const ids = new Set(alerts.map((a) => a.id));
  for (const id of have) if (!ids.has(id)) await chrome.alarms.clear(ALARM_PREFIX + id);   // orphans from removed alerts
  if (!existing.some((a) => a.name === WATCHDOG)) await chrome.alarms.create(WATCHDOG, { periodInMinutes: 30 });
}

async function refreshBadge() {
  try {
    const alerts = await getAlerts();
    const bad = alerts.some((a) => a.enabled !== false && ["login", "blocked", "error", "empty"].includes(a.lastStatus));
    const n = alerts.reduce((s, a) => s + (a.lastNew || 0), 0);
    await chrome.action.setBadgeText({ text: bad ? "!" : n ? String(n) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: bad ? "#c0392b" : "#1877f2" });
  } catch (_) {}
}

function statusMessage(res) {
  switch (res.state) {
    case "login": return "Facebook showed a login page. Log in to Facebook, then run the alert again.";
    case "blocked": return "Facebook is temporarily limiting this account. The alert backs off and retries later.";
    case "empty": return "No listings were found on the feed (filters too narrow, the page didn't render, or Facebook changed its layout).";
    case "wrong-page": return "Facebook redirected away from the listings.";
    case "error": return res.error || "The run failed.";
    default: return res.error || res.state;
  }
}
function notifyMatches(alert, fresh, manual) {
  const label = alert.name || alert.keywords.join(", ");
  const base = { type: "basic", iconUrl: "icon128.png", priority: 1 };
  if (!fresh.length) {
    if (manual) chrome.notifications.create("mds-none-" + alert.id, { ...base, priority: 0, title: "No new matches", message: 'Nothing new for "' + label + '".' });
    return;
  }
  if (fresh.length <= 3) {
    for (const m of fresh)
      chrome.notifications.create("mds-item-" + alert.id + "-" + m.id, { ...base, title: "Marketplace match: " + label,
        message: (m.title || "Listing") + (m.price ? "  " + m.price : ""), contextMessage: (m.snippet || "").replace(/^…/, "").slice(0, 110) });
  } else {
    // A burst of matches becomes one digest instead of a wall of toasts.
    chrome.notifications.create("mds-sum-" + alert.id, { ...base, title: fresh.length + " new matches: " + label,
      message: fresh.slice(0, 3).map((m) => (m.title || "Listing") + (m.price ? " · " + m.price : "")).join("\n"),
      contextMessage: "and " + (fresh.length - 3) + " more — click to open the gallery" });
  }
}
function notifyProblem(alert, state, msg) {
  chrome.notifications.create("mds-err-" + alert.id, { type: "basic", iconUrl: "icon128.png", priority: 1,
    title: "Alert problem: " + ((STATUS[state] || {}).label || state), message: msg.slice(0, 150), contextMessage: alert.name || alert.keywords.join(", ") });
}
// Stateless: the destination is encoded in the notification id, so clicks work long
// after this worker instance is gone.
chrome.notifications.onClicked.addListener((nid) => {
  let m;
  if ((m = /^mds-item-\d+-(\d+)$/.exec(nid))) chrome.tabs.create({ url: itemUrl(m[1]) });
  else if ((m = /^mds-sum-(\d+)$/.exec(nid))) chrome.tabs.create({ url: chrome.runtime.getURL("gallery.html?id=" + m[1] + "&filter=new") });
  else if (/^mds-err-/.test(nid)) chrome.tabs.create({ url: "https://www.facebook.com/marketplace/" });
  chrome.notifications.clear(nid);
});

// job: { id, manual, prime, cancel, jobId }
//   manual = user clicked "Run now" (show a "nothing new" toast if empty).
//   The first COMPLETED run of an alert is the silent baseline: it records current matches
//   as seen with no notifications. That is a property of the alert (`primed`), not of a
//   queued job, so a stopped or lost baseline run can't turn into a notification storm.
async function runAlertById(job) {
  const { id, manual, cancel } = job;
  const alert = (await getAlerts()).find((a) => a.id === id);
  if (!alert) { await chrome.alarms.clear(ALARM_PREFIX + id); return; }
  if (alert.enabled === false && !manual) return;
  const started = Date.now();
  // Arm the next alarm up front so a worker death mid-run can't silence the alert; it is
  // re-armed from the end of the run below.
  if (!manual) await armAlarm(alert, alert.intervalMin);
  if (!manual && (await budgetCount()) >= LIMITS.loadsPerHour) {
    await patchAlert(id, { lastStatus: "budget", lastError: "Skipped: this hour's page-load budget (" + LIMITS.loadsPerHour + ") was already used by other runs.", lastRunEnded: Date.now() });
    refreshBadge();
    return;
  }
  const silent = job.prime || alert.primed !== true;
  const phase = (p) => { runState = { kind: "alert", id, jobId: job.jobId, phase: p, done: 0, total: 0 }; };
  phase(silent ? "Baseline scan…" : "Loading listings…");
  const cache = await loadCache(), dismissed = await loadDismissed();
  let res;
  try {
    res = await runFeedScan({
      feedUrl: withNewestSort(alert.url), max: clampInt(alert.max, 1, LIMITS.alertMax, LIMITS.defaultMax),
      concurrency: Math.min(alert.concurrency || 2, LIMITS.alertConcurrency), match: matchOpts(alert), noCache: false,
    }, { manual, cancel, cache, dismissed,
      onProgress: (done, total) => { runState = { kind: "alert", id, jobId: job.jobId, phase: silent ? "Baseline scan" : "Scanning", done, total }; } });
  } finally {
    await closePool();
    runState = null;
    await saveCache(cache);
  }
  const dur = Date.now() - started;
  if (cancel.requested || res.state === "cancelled") {
    await patchAlert(id, { lastStatus: "cancelled", lastRunEnded: Date.now(), lastDurationMs: dur });
    if (!manual) await armAlarm(alert, alert.intervalMin);
    refreshBadge();
    return;
  }
  if (res.state !== "ok") {
    const failCount = (alert.failCount || 0) + 1;
    const msg = statusMessage(res);
    await patchAlert(id, { lastStatus: res.state, lastError: msg, lastRunEnded: Date.now(), lastDurationMs: dur, failCount,
      lastScanned: res.scanned, lastFetched: res.fetched, lastCached: res.cached });
    // Back off — double the interval per consecutive failure (max 6 h) instead of loading
    // a login page every 15 minutes — and tell the user once per failure streak.
    if (!manual) await armAlarm(alert, Math.min(alert.intervalMin * Math.pow(2, Math.min(failCount, 5)), 360));
    if (failCount === 1 || manual) notifyProblem(alert, res.state, msg);
    refreshBadge();
    return;
  }
  const matches = res.matches;
  const fresh = await withStore(async () => {
    const alerts = await getAlerts();
    const a = alerts.find((x) => x.id === id);
    if (!a) return null;                                  // removed mid-run: drop the results
    const hist = await getHist(id);
    const seen = new Set(a.seen || []), known = new Set(hist.map((m) => m.id));
    const fresh = matches.filter((m) => !seen.has(m.id) && !known.has(m.id));
    for (const m of matches) {
      if (known.has(m.id)) continue;
      hist.unshift(historyEntry(m, !silent && !seen.has(m.id)));   // NEW is sticky until "Clear new"
      known.add(m.id);
    }
    if (hist.length > LIMITS.historyMax) hist.length = LIMITS.historyMax;
    a.seen = Array.from(new Set([...matches.map((m) => m.id), ...(a.seen || [])])).slice(0, LIMITS.seenMax);
    Object.assign(a, {
      primed: true, lastRun: Date.now(), lastRunEnded: Date.now(), failCount: 0,
      lastStatus: res.partial ? "partial" : "ok",
      lastError: res.partial ? "The window was hidden, so only " + res.ids.length + " listings could be loaded this time." : null,
      lastScanned: res.scanned, lastFetched: res.fetched, lastCached: res.cached, lastNoDesc: res.noDesc, lastMatched: matches.length,
      lastDurationMs: dur, lastNew: hist.filter((m) => m.isNew).length, histCount: hist.length,
    });
    await setHist(id, hist);
    await setAlerts(alerts);
    return fresh;
  });
  if (fresh == null) return;
  if (!manual) await armAlarm(alert, alert.intervalMin);
  if (!silent) notifyMatches(alert, fresh, manual);
  refreshBadge();
}

// ===================== STARTUP =====================
async function migrate() {
  const { schemaVersion = 1 } = await store.get("schemaVersion");
  if (schemaVersion >= 2) return;
  await withStore(async () => {
    const all = (await store.get("alerts")).alerts || [];
    for (const a of all) {
      if (Array.isArray(a.history)) {          // histories move to their own keys
        await setHist(a.id, a.history);
        a.histCount = a.history.length;
        a.lastNew = a.history.filter((m) => m.isNew).length;
        delete a.history;
      }
      a.exclude = a.exclude || [];
      a.wholeWord = !!a.wholeWord;
      a.enabled = a.enabled !== false;
      if (a.primed == null) a.primed = a.lastRun != null;
      a.seen = Array.from(new Set(a.seen || [])).slice(0, LIMITS.seenMax);
      if (a.lastStatus == null) a.lastStatus = a.lastRun ? "ok" : null;
      delete a.lastCount;
    }
    await store.set({ alerts: all, schemaVersion: 2 });
  });
  const { kw, panelOpts } = await store.get(["kw", "panelOpts"]);
  if (kw && !(panelOpts && panelOpts.kw)) await store.set({ panelOpts: { ...(panelOpts || {}), kw } });
  // v1 used periodic alarms; reRegisterAllAlarms recreates them as one-shots from lastRun.
  for (const al of await chrome.alarms.getAll()) if (al.name.startsWith(ALARM_PREFIX)) await chrome.alarms.clear(al.name);
}
// Runs on every worker start; the queue waits for it so orphan cleanup can't race a new run.
const startup = (async () => {
  try { await migrate(); } catch (e) { warn("migrate", e); }
  try {
    const parked = await chrome.tabs.query({ url: PARK_URL });
    if (parked.length) { parkedTab = parked[0].id; for (const t of parked.slice(1)) chrome.tabs.remove(t.id).catch(() => {}); }
  } catch (_) {}
  await reconcileOrphans();
  refreshBadge();
})();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG) { startup.then(reRegisterAllAlarms).catch(warn); return; }
  if (alarm.name.startsWith(ALARM_PREFIX))
    enqueueJob({ kind: "alert", id: alarm.name.slice(ALARM_PREFIX.length), manual: false, prime: false });
});
chrome.runtime.onInstalled.addListener(() => startup.then(reRegisterAllAlarms).catch(warn));
chrome.runtime.onStartup.addListener(() => startup.then(reRegisterAllAlarms).catch(warn));

// ===================== MESSAGES =====================
const strs = (arr, max) => (Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean).slice(0, max || 50);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const str = (v, max) => (v == null ? "" : String(v)).trim().slice(0, max || 100);
const scanOptsOf = (msg) => ({ include: strs(msg.include), exclude: strs(msg.exclude), matchAll: !!msg.matchAll, searchTitles: !!msg.searchTitles,
  wholeWord: !!msg.wholeWord, priceMin: num(msg.priceMin), priceMax: num(msg.priceMax) });
const statsOf = (o) => ({ scanned: o.scanned, fetched: o.fetched, cached: o.cached, skipped: o.skipped, errors: o.errors, noDesc: o.noDesc, unavailable: o.unavailable, aborted: o.aborted || null });

const HANDLERS = {
  // In-page scan: the panel already collected the ids.
  async scan(msg, sender) {
    const src = sender.tab && sender.tab.id;
    if (src == null) return { ok: false, error: "Scans can only start from a Facebook tab." };
    const ids = (Array.isArray(msg.ids) ? msg.ids : []).map(String).filter((id) => /^\d{1,20}$/.test(id)).slice(0, LIMITS.manualMax);
    const opts = scanOptsOf(msg);
    if (!ids.length) return { ok: false, error: "No listing ids." };
    if (!opts.include.length) return { ok: false, error: "Enter at least one keyword." };
    const concurrency = clampInt(msg.concurrency, 1, LIMITS.maxConcurrency, 3);
    const scanId = str(msg.scanId, 64);
    const job = { kind: "scan", src, scanId, run: async (job) => {
      const { cancel } = job;
      let srcGone = false, fails = 0;
      const onRemoved = (tabId) => { if (tabId === src) srcGone = true; };
      chrome.tabs.onRemoved.addListener(onRemoved);
      const send = (m) => { if (!srcGone) chrome.tabs.sendMessage(src, { scanId, ...m }).catch(() => { if (++fails >= 3) srcGone = true; }); };
      // The tab may have been closed or navigated off Facebook while queued — nobody to show results to.
      try { const t = await chrome.tabs.get(src); if (!t.url || !/^https:\/\/[^/]*facebook\.com\//.test(t.url)) srcGone = true; } catch (_) { srcGone = true; }
      if (srcGone) { chrome.tabs.onRemoved.removeListener(onRemoved); return; }
      send({ type: "started" });
      runState = { kind: "scan", id: null, jobId: job.jobId, tabId: src, phase: "Scanning page listings", done: 0, total: ids.length };
      const cache = await loadCache(), dismissed = await loadDismissed();
      let res = null, error = null;
      try {
        res = await scanIds(ids, opts, { concurrency, cache, dismissed, noCache: !!msg.noCache, shouldAbort: () => srcGone || cancel.requested,
          onProgress: (done, total, r, o) => {
            runState = { kind: "scan", id: null, jobId: job.jobId, tabId: src, phase: "Scanning page listings", done, total };
            send({ type: "progress", done, total, current: r, stats: statsOf(o) });
          } });
      } catch (e) { error = String(e && e.message || e); }
      finally {
        chrome.tabs.onRemoved.removeListener(onRemoved);
        await closePool();
        runState = null;
        await saveCache(cache);
        if (res && res.fetched) budgetAdd(res.fetched);
      }
      send({ type: "complete", matches: res ? res.matches : [], cancelled: cancel.requested, error, stats: res ? statsOf(res) : null, aborted: res && res.aborted });
    } };
    const q = enqueueJob(job);
    return { ok: true, jobId: job.jobId, queued: currentJob !== job, position: q.position || 0 };
  },
  // Targeted cancel: the panel cancels its own tab's job; the popup names an alert or job.
  async cancelRun(msg, sender) {
    const src = sender.tab && sender.tab.id;
    let pred;
    if (msg.all) pred = () => true;
    else if (msg.jobId) pred = (j) => j.jobId === msg.jobId;
    else if (msg.alertId) pred = (j) => j.kind === "alert" && j.id === msg.alertId;
    else if (src != null) pred = (j) => j.kind === "scan" && j.src === src && (!msg.scanId || j.scanId === msg.scanId);
    else return { ok: false, error: "Nothing to cancel." };
    return { ok: true, ...(await cancelJobs(pred)) };
  },
  async runState() { return { ok: true, runState, queued: queuedSummary() }; },
  async listAlerts() { return { ok: true, alerts: await getAlerts(), runState, queued: queuedSummary() }; },
  async getHistory(msg) {
    const hist = await getHist(String(msg.id));
    if (msg.includeHidden) return { ok: true, history: hist };
    const dismissed = await loadDismissed();
    return { ok: true, history: hist.filter((m) => !dismissed[m.id]), hidden: hist.filter((m) => dismissed[m.id]).length };
  },
  async clearNew(msg) {
    const id = String(msg.id);
    await withStore(async () => {
      const hist = await getHist(id);
      hist.forEach((m) => { m.isNew = false; });
      await setHist(id, hist);
      const alerts = await getAlerts();
      const a = alerts.find((x) => x.id === id);
      if (a) { a.lastNew = 0; a.histCount = hist.length; }
      await setAlerts(alerts);
    });
    refreshBadge();
    return { ok: true };
  },
  async clearAll(msg) {
    const id = String(msg.id);
    await withStore(async () => {
      await setHist(id, []);                    // keep `seen` so old listings don't re-notify
      const alerts = await getAlerts();
      const a = alerts.find((x) => x.id === id);
      if (a) { a.lastNew = 0; a.histCount = 0; }
      await setAlerts(alerts);
    });
    refreshBadge();
    return { ok: true };
  },
  async createAlert(msg) {
    if (!isFeedUrl(msg.url)) return { ok: false, error: "Open a Marketplace search or category page first." };
    const include = strs(msg.keywords), exclude = strs(msg.exclude);
    if (!include.length) return { ok: false, error: "Enter at least one keyword." };
    const base = { url: String(msg.url), keywords: include, exclude, matchAll: !!msg.matchAll, searchTitles: !!msg.searchTitles, wholeWord: !!msg.wholeWord,
      priceMin: num(msg.priceMin), priceMax: num(msg.priceMax),
      intervalMin: clampInt(msg.intervalMin, LIMITS.minIntervalMin, LIMITS.maxIntervalMin, 60),
      max: clampInt(msg.max, 1, LIMITS.alertMax, LIMITS.defaultMax), concurrency: clampInt(msg.concurrency, 1, LIMITS.maxConcurrency, 2), name: str(msg.name, 60) };
    const key = alertKey(base);
    const r = await mutateAlerts((alerts) => {
      const dup = alerts.find((a) => alertKey(a) === key);
      if (dup) {   // same feed + same terms: update the existing alert instead of scanning twice
        Object.assign(dup, { intervalMin: base.intervalMin, max: base.max, concurrency: base.concurrency, priceMin: base.priceMin, priceMax: base.priceMax, name: base.name || dup.name || "", enabled: true });
        return { alert: dup, merged: true };
      }
      const alert = { id: String(Date.now()), ...base, enabled: true, primed: false, seen: [], lastRun: null, lastStatus: null, histCount: 0, lastNew: 0, createdAt: Date.now() };
      alerts.push(alert);
      return { alert, merged: false };
    });
    await armAlarm(r.alert, r.alert.intervalMin);
    if (!r.merged) enqueueJob({ kind: "alert", id: r.alert.id, manual: false, prime: true });   // silent baseline
    refreshBadge();
    return { ok: true, alert: r.alert, merged: r.merged };
  },
  async updateAlert(msg) {
    const patch = msg.patch || {};
    const r = await mutateAlerts((alerts) => {
      const a = alerts.find((x) => x.id === String(msg.id));
      if (!a) return null;
      const before = { key: alertKey(a), interval: a.intervalMin, enabled: a.enabled !== false };
      if ("keywords" in patch) a.keywords = strs(patch.keywords);
      if ("exclude" in patch) a.exclude = strs(patch.exclude);
      for (const k of ["matchAll", "searchTitles", "wholeWord"]) if (k in patch) a[k] = !!patch[k];
      if ("priceMin" in patch) a.priceMin = num(patch.priceMin);
      if ("priceMax" in patch) a.priceMax = num(patch.priceMax);
      if ("intervalMin" in patch) a.intervalMin = clampInt(patch.intervalMin, LIMITS.minIntervalMin, LIMITS.maxIntervalMin, a.intervalMin || 60);
      if ("max" in patch) a.max = clampInt(patch.max, 1, LIMITS.alertMax, a.max || LIMITS.defaultMax);
      if ("concurrency" in patch) a.concurrency = clampInt(patch.concurrency, 1, LIMITS.maxConcurrency, a.concurrency || 2);
      if ("name" in patch) a.name = str(patch.name, 60);
      if ("enabled" in patch) a.enabled = !!patch.enabled;
      if (!a.keywords.length) throw new Error("An alert needs at least one keyword.");
      const rebaseline = alertKey(a) !== before.key;
      if (rebaseline) a.primed = false;          // new terms: next run is a quiet baseline, history is kept
      return { a, rebaseline, intervalChanged: a.intervalMin !== before.interval, enabledChanged: (a.enabled !== false) !== before.enabled };
    });
    if (!r) return { ok: false, error: "Alert not found." };
    const a = r.a;
    if (a.enabled === false) {
      await chrome.alarms.clear(ALARM_PREFIX + a.id);
      await patchAlert(a.id, { nextRun: null });
      await cancelJobs((j) => j.kind === "alert" && j.id === a.id);
    } else if (r.enabledChanged || r.intervalChanged) await armAlarm(a, r.enabledChanged ? 1 : a.intervalMin);
    if (r.rebaseline && a.enabled !== false) enqueueJob({ kind: "alert", id: a.id, manual: false, prime: true });
    refreshBadge();
    return { ok: true, alert: a };
  },
  async removeAlert(msg) {
    const id = String(msg.id);
    await cancelJobs((j) => j.kind === "alert" && j.id === id);
    await withStore(async () => {
      await setAlerts((await getAlerts()).filter((a) => a.id !== id));
      await store.remove(histKey(id));
    });
    await chrome.alarms.clear(ALARM_PREFIX + id);
    refreshBadge();
    return { ok: true };
  },
  async runAlert(msg) {
    const q = enqueueJob({ kind: "alert", id: String(msg.id), manual: true, prime: false });
    return { ok: true, queued: q.queued, reason: q.reason || null, position: q.position || 0 };
  },
  async dismiss(msg) {
    const id = String(msg.id);
    await withStore(async () => {
      const d = await loadDismissed();
      if (msg.undo) delete d[id]; else d[id] = Date.now();
      const ids = Object.keys(d);
      if (ids.length > LIMITS.dismissedMax) { ids.sort((x, y) => d[x] - d[y]); for (const k of ids.slice(0, ids.length - LIMITS.dismissedMax)) delete d[k]; }
      await store.set({ dismissed: d });
    });
    return { ok: true };
  },
  async openUrls(msg) {
    const urls = strs(msg.urls, 50).filter((u) => /^https:\/\/www\.facebook\.com\/marketplace\/item\/\d+\/?$/.test(u));
    for (const url of urls) await chrome.tabs.create({ url, active: false });
    return { ok: true, opened: urls.length };
  },
};
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  const h = HANDLERS[msg.type];
  if (!h) return false;
  Promise.resolve().then(() => h(msg, sender))
    .then((r) => sendResponse(r || { ok: true }), (e) => { warn("handler", msg.type, e); sendResponse({ ok: false, error: String(e && e.message || e) }); });
  return true;
});
