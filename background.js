// Service worker.
//   * Manual scan: triggered by the on-page panel (content.js) with a list of IDs.
//   * Scheduled alerts: re-scan a saved feed (newest-first) on a timer and
//     notify on NEW description matches.
// Descriptions aren't in a listing's raw HTML (Facebook loads them with JS), so
// we open each listing in a background tab and read the rendered DOM. To go
// faster we use a small pool of tabs in parallel (configurable).

let pool = [];          // reusable background tab IDs
let parkedTab = null;   // a single about:blank we keep so closing helpers never quits Chrome
let busy = false;       // a scan (alert or in-page) is using the tab pool — owned by the queue
let jobQueue = [];      // serialized work: {kind:'alert',id,manual,prime} | {kind:'scan',run}
let runState = null;    // { id, phase, done, total } while an alert runs (for popup progress)
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// One global FIFO so alert runs and in-page scans never overlap (shared tab pool)
// and nothing is silently dropped while another run is in flight.
function enqueueJob(job) {
  if (job.kind === "alert" && !job.manual &&
      jobQueue.some((j) => j.kind === "alert" && j.id === job.id)) return;  // dedup scheduled re-runs
  jobQueue.push(job);
  pumpQueue();
}
async function pumpQueue() {
  if (busy || !jobQueue.length) return;
  busy = true;
  const job = jobQueue.shift();
  try {
    if (job.kind === "alert") await runAlertById(job.id, job.manual, job.prime);
    else if (job.kind === "scan") await job.run();
  } catch (_) {}
  finally { busy = false; pumpQueue(); }
}

// Close a helper tab, but NEVER close the last remaining browser tab — doing so
// quits Chrome, which stops scheduled alerts. In that case park it on about:blank
// and remember it so the next run reuses it (no stray-tab buildup).
async function safeCloseTab(id) {
  if (id == null) return;
  try {
    const all = await chrome.tabs.query({ windowType: "normal" });
    if (all.length <= 1) {
      await chrome.tabs.update(id, { url: "about:blank" });
      parkedTab = id;
      return;
    }
    await chrome.tabs.remove(id);
    if (parkedTab === id) parkedTab = null;
  } catch (_) { if (parkedTab === id) parkedTab = null; }
}

async function getPool(n) {
  n = Math.max(1, Math.min(5, n || 3));
  // adopt a previously-parked keep-alive tab instead of leaving it stray
  if (parkedTab != null) {
    try { await chrome.tabs.get(parkedTab); if (!pool.includes(parkedTab)) pool.push(parkedTab); } catch (_) {}
    parkedTab = null;
  }
  while (pool.length < n) {
    const t = await chrome.tabs.create({ url: "about:blank", active: false });
    pool.push(t.id);
  }
  // verify existing tabs still exist
  const alive = [];
  for (const id of pool) { try { await chrome.tabs.get(id); alive.push(id); } catch (_) {} }
  pool = alive;
  while (pool.length < n) {
    const t = await chrome.tabs.create({ url: "about:blank", active: false });
    pool.push(t.id);
  }
  return pool.slice(0, n);
}
async function closePool() {
  for (const id of pool) { await safeCloseTab(id); }
  pool = [];
}
// Return a live tab id; if the given one was closed, make a fresh one and track
// it in the pool so closePool() still cleans it up.
async function ensureTab(tabId) {
  try { await chrome.tabs.get(tabId); return tabId; }
  catch (_) {
    const t = await chrome.tabs.create({ url: "about:blank", active: false });
    pool.push(t.id);
    return t.id;
  }
}

function waitForComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const done = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(done);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(false); }, timeoutMs);
  });
}

// ---- runs INSIDE a listing tab: read description + title + price ----
function scrapePage() {
  return new Promise((resolve) => {
    const deadline = Date.now() + 11000;
    const END = /\n(Seller information|Seller details|Today's picks|Location is approximate|More like this)\n/i;
    function read() {
      Array.from(document.querySelectorAll('div[role="button"], span, a'))
        .filter((e) => /^see more$/i.test((e.textContent || "").trim()))
        .forEach((e) => { try { e.click(); } catch (_) {} });
      const body = document.body ? document.body.innerText : "";
      let desc = "";
      const m = body.search(/\nDescription\n/i);
      if (m > -1) {
        const rest = body.slice(m + "\nDescription\n".length);
        const end = rest.search(END);
        desc = end > -1 ? rest.slice(0, end) : rest.slice(0, 2000);
      }
      return { desc: desc.trim(), body };
    }
    function attempt() {
      const { desc, body } = read();
      if (!desc && Date.now() < deadline) return setTimeout(attempt, 400);
      const title = (document.title || "")
        .replace(/\s*\|\s*Facebook\s*$/i, "").replace(/^Marketplace\s*[–\-]\s*/i, "").trim();
      const priceM = body.match(/[฿$€£][\d,]+(?:\s*\/\s*month)?/);
      // Listing image: only og:image (the listing's primary photo). We deliberately
      // do NOT fall back to the largest <img> — item pages carry ads and unrelated
      // images that can be bigger than the listing photo. The feed thumbnail
      // captured during collection is the primary source anyway.
      let image = "";
      const og = document.querySelector('meta[property="og:image"]');
      if (og && /^https?:/.test(og.content || "")) image = og.content;
      resolve({ description: desc, haystack: (desc || body).toLowerCase(),
                title: title || "(untitled listing)", price: priceM ? priceM[0] : "", image });
    }
    attempt();
  });
}

// ---- runs INSIDE a feed tab: patiently scroll & ACCUMULATE listing IDs ----
function collectIdsFunc(max) {
  return new Promise((resolve) => {
    const RE = /\/marketplace\/item\/(\d+)/;
    const found = new Set();
    const thumbs = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const grab = () => document.querySelectorAll("a[href*='/marketplace/item/']")
      .forEach((a) => {
        const m = a.href.match(RE);
        if (!m) return;
        found.add(m[1]);
        // largest image within this listing's own card link = that listing's photo
        let best = "", bestA = 0;
        a.querySelectorAll("img").forEach((img) => {
          const s = img.currentSrc || img.src || "";
          if (!/^https?:/.test(s)) return;
          const ar = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
          if (ar >= bestA) { bestA = ar; best = s; }
        });
        if (best) thumbs[m[1]] = best;
      });
    (async () => {
      grab();                                  // count what's already loaded first
      let stable = 0;
      const start = Date.now();
      while (found.size < max && stable < 12 && Date.now() - start < 180000) {
        const before = found.size;
        window.scrollBy(0, Math.max(900, Math.floor(window.innerHeight * 0.9)));
        window.dispatchEvent(new Event("scroll"));
        await sleep(900);
        grab();
        stable = found.size === before ? stable + 1 : 0;
      }
      resolve({ ids: Array.from(found).slice(0, max), thumbs });
    })();
  });
}

async function scanOneInTab(tabId, id, keywords, matchAll, searchTitles) {
  const url = "https://www.facebook.com/marketplace/item/" + id + "/";
  let data;
  try {
    // tabs.update throws "No tab with id" if the pooled tab was closed mid-scan;
    // keep it inside the try so it can never become an uncaught rejection.
    await chrome.tabs.update(tabId, { url, active: false });
    await waitForComplete(tabId);
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapePage });
    data = res && res.result;
  } catch (e) { return { id, url, matched: false, error: String(e) }; }
  if (!data) return { id, url, matched: false, error: "no data" };
  const haystack = searchTitles ? ((data.title || "").toLowerCase() + "\n" + data.haystack) : data.haystack;
  const hits = keywords.filter((k) => haystack.includes(k.toLowerCase()));
  const matched = matchAll ? (hits.length === keywords.length && keywords.length > 0) : hits.length > 0;
  return { id, url, matched, hits, title: data.title, price: data.price,
           snippet: data.description.slice(0, 200), image: data.image || "" };
}

// Parallel scan across a pool of tabs.
async function scanIds(ids, keywords, matchAll, concurrency, searchTitles, onProgress, shouldAbort) {
  const tabs = await getPool(concurrency);
  const matches = [];
  let next = 0, done = 0;
  async function worker(tabId) {
    while (true) {
      if (shouldAbort && shouldAbort()) return;   // e.g. the tab that started the scan was closed
      const i = next++;
      if (i >= ids.length) return;
      tabId = await ensureTab(tabId);   // recreate the tab if the user closed it
      let r = await scanOneInTab(tabId, ids[i], keywords, matchAll, searchTitles);
      if (r.error) {
        // The read failed (tab closed mid-scan, or the page didn't load). Retry
        // once on a guaranteed-fresh tab so a single hiccup doesn't drop a listing.
        tabId = await ensureTab(tabId);
        r = await scanOneInTab(tabId, ids[i], keywords, matchAll, searchTitles);
      }
      if (r.matched) matches.push(r);
      done++;
      if (onProgress) onProgress(done, ids.length, r);
      await delay(300);   // small breather per tab
    }
  }
  await Promise.all(tabs.map((t) => worker(t)));
  return matches;
}

// Open a feed, collect IDs (newest first if caller passed a sorted URL), scan.
async function runFeedScan(feedUrl, keywords, matchAll, max, concurrency, searchTitles, onProgress) {
  const collector = await chrome.tabs.create({ url: feedUrl, active: false });
  await waitForComplete(collector.id);
  await delay(2500);
  let ids = [], thumbs = {};
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: collector.id }, func: collectIdsFunc, args: [max]
    });
    const out = (res && res.result) || {};
    ids = out.ids || [];
    thumbs = out.thumbs || {};
  } catch (_) { ids = []; }
  await safeCloseTab(collector.id);
  const matches = await scanIds(ids, keywords, matchAll, concurrency, searchTitles, onProgress);
  // Prefer the feed thumbnail (the listing's own card image) over the item-page
  // scrape, which can accidentally pick up an ad or unrelated image.
  for (const m of matches) { if (thumbs[m.id]) m.image = thumbs[m.id]; }
  return matches;
}

// ===================== ALERTS =====================
const ALARM_PREFIX = "mds-alert-";
const getAlerts = () => new Promise((r) => chrome.storage.local.get(["alerts"], (s) => r(s.alerts || [])));
const setAlerts = (a) => new Promise((r) => chrome.storage.local.set({ alerts: a }, r));

function withNewestSort(url) {
  try {
    const u = new URL(url);
    u.searchParams.set("sortBy", "creation_time_descend");  // set, not append — no duplicate, keeps all filters
    return u.toString();
  } catch (_) {
    if (/sortBy=/.test(url)) return url;
    return url + (url.includes("?") ? "&" : "?") + "sortBy=creation_time_descend";
  }
}

async function scheduleAlert(alert) {
  await chrome.alarms.create(ALARM_PREFIX + alert.id, { periodInMinutes: alert.intervalMin, delayInMinutes: 1 });
}
async function reRegisterAllAlarms() {
  for (const a of await getAlerts()) if (a.enabled !== false) await scheduleAlert(a);
}

const notifUrl = {};
chrome.notifications.onClicked.addListener((nid) => { if (notifUrl[nid]) chrome.tabs.create({ url: notifUrl[nid] }); });

// manual = user clicked "Run now" (show a "nothing new" toast if empty).
// prime  = very first run when the alert is created — establish a baseline of
//          current matches silently, with NO notifications.
async function runAlertById(id, manual, prime) {
  const alerts = await getAlerts();
  const alert = alerts.find((a) => a.id === id);
  if (!alert) return;
  runState = { id, phase: "Loading listings…", done: 0, total: 0 };
  try {
    const matches = await runFeedScan(
      withNewestSort(alert.url), alert.keywords, alert.matchAll, alert.max || 40, alert.concurrency || 3, !!alert.searchTitles,
      (done, total) => { runState = { id, phase: "Scanning", done, total }; }
    );
    const seen = new Set(alert.seen || []);
    const freshThisRun = matches.filter((m) => !seen.has(m.id));   // genuinely new listings this run
    // Cumulative history: accumulate every match (deduped by id) across runs. The
    // NEW flag is sticky — set when a listing first appears and cleared only when
    // the user clicks "Clear new". Newest additions go to the front.
    const history = Array.isArray(alert.history) ? alert.history.slice() : [];
    const known = new Set(history.map((m) => m.id));
    for (const m of matches) {
      if (known.has(m.id)) continue;
      history.unshift({
        id: m.id, url: m.url, title: m.title, price: m.price, snippet: m.snippet,
        image: m.image || "", hits: m.hits || [], isNew: !seen.has(m.id), ts: Date.now()
      });
      known.add(m.id);
    }
    if (history.length > 500) history.length = 500;
    if (!prime) {
      for (const m of freshThisRun) {
        const nid = "mds-" + m.id;
        chrome.notifications.create(nid, {
          type: "basic", iconUrl: "icon128.png",
          title: "Marketplace match: " + alert.keywords.join(", "),
          message: (m.title || "Listing") + (m.price ? "  " + m.price : ""),
          contextMessage: m.snippet ? m.snippet.slice(0, 110) : "", priority: 1
        });
        notifUrl[nid] = m.url;
      }
      if (manual && freshThisRun.length === 0) {
        chrome.notifications.create("mds-none-" + Date.now(), {
          type: "basic", iconUrl: "icon128.png",
          title: "No new matches", message: 'Nothing new for "' + alert.keywords.join(", ") + '".'
        });
      }
    }
    alert.seen = matches.map((m) => m.id).concat(alert.seen || []).slice(0, 1000);
    alert.history = history;
    alert.lastRun = Date.now();
    alert.lastCount = matches.length;                       // matches in this run
    alert.lastNew = history.filter((m) => m.isNew).length;  // cumulative unviewed
    await setAlerts(alerts);
  } finally {
    await closePool();
    runState = null;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(ALARM_PREFIX))
    enqueueJob({ kind: "alert", id: alarm.name.slice(ALARM_PREFIX.length), manual: false, prime: false });
});
chrome.runtime.onInstalled.addListener(reRegisterAllAlarms);
chrome.runtime.onStartup.addListener(reRegisterAllAlarms);

// ===================== MESSAGES =====================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "scan") {
    const src = sender.tab && sender.tab.id;
    enqueueJob({ kind: "scan", run: async () => {
      // If the user closes the tab that started the scan, there's no one to show
      // results to — stop early instead of burning through the rest of the list.
      let srcGone = false;
      const onRemoved = (tabId) => { if (tabId === src) srcGone = true; };
      if (src != null) chrome.tabs.onRemoved.addListener(onRemoved);
      const send = (m) => { if (src != null && !srcGone) chrome.tabs.sendMessage(src, m).catch(() => {}); };
      let matches = [];
      try {
        matches = await scanIds(msg.ids, msg.keywords, !!msg.matchAll, msg.concurrency || 3, !!msg.searchTitles,
          (done, total, r) => send({ type: "progress", done, total, current: r }),
          () => srcGone);
      } finally {
        if (src != null) chrome.tabs.onRemoved.removeListener(onRemoved);
        await closePool();
      }
      send({ type: "complete", matches });
    } });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "listAlerts") { getAlerts().then((a) => sendResponse({ alerts: a, runState })); return true; }
  if (msg.type === "runState") { sendResponse({ runState }); return false; }
  if (msg.type === "clearNew") {
    (async () => {
      const alerts = await getAlerts();
      const a = alerts.find((x) => x.id === msg.id);
      if (a && a.history) { a.history.forEach((m) => { m.isNew = false; }); a.lastNew = 0; }
      await setAlerts(alerts);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "clearAll") {
    (async () => {
      const alerts = await getAlerts();
      const a = alerts.find((x) => x.id === msg.id);
      if (a) { a.history = []; a.lastNew = 0; }   // keep `seen` so old listings don't re-notify
      await setAlerts(alerts);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "createAlert") {
    (async () => {
      const alerts = await getAlerts();
      const alert = { id: String(Date.now()), url: msg.url, keywords: msg.keywords,
        matchAll: !!msg.matchAll, searchTitles: !!msg.searchTitles, intervalMin: msg.intervalMin || 60, max: msg.max || 40,
        concurrency: msg.concurrency || 3, enabled: true, seen: [], lastRun: null, lastCount: null };
      alerts.push(alert);
      await setAlerts(alerts);
      await scheduleAlert(alert);
      enqueueJob({ kind: "alert", id: alert.id, manual: false, prime: true });   // silent baseline
      sendResponse({ ok: true, alert });
    })();
    return true;
  }
  if (msg.type === "removeAlert") {
    (async () => {
      await setAlerts((await getAlerts()).filter((a) => a.id !== msg.id));
      await chrome.alarms.clear(ALARM_PREFIX + msg.id);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "runAlert") { enqueueJob({ kind: "alert", id: msg.id, manual: true, prime: false }); sendResponse({ ok: true }); return false; }
});
