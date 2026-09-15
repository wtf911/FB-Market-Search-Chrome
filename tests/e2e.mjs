// End-to-end: serve a fake Marketplace feed + listing pages from a local HTTPS server that
// Chromium is told is facebook.com (--host-resolver-rules), then drive real runs through
// the service worker — collector injection, pooled tabs, scrapePage, the description
// cache, alert history, cancel, and login detection. Nothing touches the real
// facebook.com. Needs `openssl` on PATH for the throwaway certificate. Run: `npm run e2e`.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import https from "node:https";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mds-e2e-"));
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error("  ✗", msg); } else console.log("  ✓", msg); };
const FEED = "https://www.facebook.com/marketplace/search/?query=house";
const LISTINGS = {
  101: { title: "3 Beds 2 Baths - House", price: "฿15,000 / month", desc: "Fully furnished. Located in a quiet area in Choengmon, 5 min to the beach." },
  102: { title: "Studio near Chaweng", price: "฿8,000 / month", desc: "Small studio, agent fee applies. Choengmon area, sea view from the roof." },
  103: { title: "Villa with pool", price: "฿45,000 / month", desc: "Luxury villa in Bophut with a private pool. Long term only." },
  104: { title: "Room for rent", price: "Free", desc: "" },                              // blank description
  105: { unavailable: true },
};
let loginMode = false;
const page = (body, title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title || "Marketplace"} | Facebook</title>
  <meta property="og:image" content="https://scontent.example/photo.jpg"></head><body>${body}</body></html>`;
const feedHtml = () => page(`<div style="height:2400px">${Object.keys(LISTINGS).map((id) =>
  `<div><a href="/marketplace/item/${id}/"><img src="https://scontent.example/t${id}.jpg" width="200" height="150"><span>${(LISTINGS[id].title || "x")}</span></a></div>`).join("")}</div>`, "Marketplace");
const itemHtml = (id) => {
  const l = LISTINGS[id];
  if (!l) return page("<div>Not found</div>");
  if (l.unavailable) return page("<div>This content isn't available right now</div>", "Facebook");
  return page(`<div>${l.title}</div><div>${l.price}</div><div>Description</div><div>${l.desc || ""}</div><div>Seller information</div><div>Seller Name</div>`, `Marketplace - ${l.title}`);
};

// Throwaway certificate + HTTPS server standing in for facebook.com and its CDN.
const keyPath = path.join(profile, "key.pem"), certPath = path.join(profile, "cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2",
  "-subj", "/CN=www.facebook.com", "-addext", "subjectAltName=DNS:www.facebook.com,DNS:facebook.com,DNS:scontent.example"], { stdio: "ignore" });
const server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => {
  const u = new URL(req.url, "https://" + (req.headers.host || "www.facebook.com"));
  const html = (body, status) => { res.writeHead(status || 200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
  if (u.hostname === "scontent.example") { res.writeHead(200, { "content-type": "image/gif" }); return res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64")); }
  if (u.pathname.startsWith("/login")) return html(page('<form action="/login/"><input name="email"><input name="pass"></form>', "Log in to Facebook"));
  if (loginMode) { res.writeHead(302, { location: "https://www.facebook.com/login/?next=" + encodeURIComponent(u.href) }); return res.end(); }
  if (u.pathname.startsWith("/marketplace/item/")) return html(itemHtml(u.pathname.split("/")[3]));
  if (u.pathname.startsWith("/marketplace/")) return html(feedHtml());
  return html(page("<div>home</div>"));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  ignoreHTTPSErrors: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }),
  // --no-proxy-server: a system proxy would resolve hostnames itself and bypass the
  // mapping below, sending the test to the real facebook.com.
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--ignore-certificate-errors", "--no-proxy-server",
    `--host-resolver-rules=MAP www.facebook.com 127.0.0.1:${port},MAP facebook.com 127.0.0.1:${port},MAP scontent.example 127.0.0.1:${port},EXCLUDE 127.0.0.1`],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  await worker.evaluate(() => chrome.storage.local.clear());
  const baselineTabs = () => context.pages().length;

  console.log("content script on a fake feed");
  const feed = await context.newPage();
  await feed.goto(FEED);
  await feed.waitForSelector("#mds-host", { state: "attached", timeout: 10000 });   // zero-size host, children are position:fixed
  check(true, "panel host injected on a Marketplace feed");
  const item = await context.newPage();
  await item.goto("https://www.facebook.com/marketplace/item/101/");
  await item.waitForTimeout(500);
  check(await item.$("#mds-host") == null, "no panel host on an item page");
  await item.close();

  console.log("manual pipeline: collector + scrape + cache");
  const match = { include: ["choengmon"], exclude: ["agent"], matchAll: false, searchTitles: false, wholeWord: false, priceMin: null, priceMax: null };
  const before = baselineTabs();
  const r1 = await worker.evaluate(async ({ FEED, match }) => {
    const cache = {};
    const res = await runFeedScan({ feedUrl: FEED, max: 10, concurrency: 2, match, noCache: false }, { manual: true, cancel: { requested: false }, cache, dismissed: {}, onProgress: () => {} });
    await closePool();
    await saveCache(cache);
    return { res: { ...res, matches: res.matches.map((m) => ({ id: m.id, title: m.title, price: m.price, priceNum: m.priceNum, snippet: m.snippet, hits: m.hits, excludedBy: m.excludedBy })) }, cacheIds: Object.keys(cache).sort(), cache101: cache["101"], cache105: cache["105"] };
  }, { FEED, match });
  check(r1.res.state === "ok", "run state ok (" + r1.res.state + " " + (r1.res.error || "") + ")");
  check(r1.res.ids.length === 5, "collector found 5 listings (" + r1.res.ids.length + ")");
  check(r1.res.matches.length === 1 && r1.res.matches[0].id === "101", "exactly listing 101 matched (102 excluded by 'agent'): " + JSON.stringify(r1.res.matches.map((m) => m.id)));
  const m = r1.res.matches[0] || {};
  check(m.price === "฿15,000 / month" && m.priceNum === 15000, "price scoped to the header and parsed: " + m.price + " / " + m.priceNum);
  check(/Choengmon/.test(m.snippet || ""), "snippet contains the hit: " + m.snippet);
  check(r1.res.noDesc === 1, "blank description counted, not matched (" + r1.res.noDesc + ")");
  check(r1.res.unavailable === 1, "unavailable listing detected (" + r1.res.unavailable + ")");
  check(r1.cacheIds.join(",") === "101,102,103,104,105", "all five listings cached: " + r1.cacheIds.join(","));
  check(r1.cache105 && r1.cache105.state === "unavailable", "unavailable state cached");
  check(r1.cache101 && r1.cache101.source === "marker" && /quiet area/.test(r1.cache101.description), "description read via the heading marker");
  check(baselineTabs() === before, "helper tabs closed after the run (" + baselineTabs() + " vs " + before + ")");

  const r2 = await worker.evaluate(async ({ FEED }) => {
    const cache = (await chrome.storage.local.get("descCache")).descCache || {};
    const res = await runFeedScan({ feedUrl: FEED, max: 10, concurrency: 2, match: { include: ["pool"], exclude: [], wholeWord: true }, noCache: false }, { manual: true, cancel: { requested: false }, cache, dismissed: {}, onProgress: () => {} });
    await closePool();
    return { fetched: res.fetched, cached: res.cached, ids: res.matches.map((x) => x.id) };
  }, { FEED });
  check(r2.cached === 5 && r2.fetched === 0, "second run served entirely from cache (cached " + r2.cached + ", fetched " + r2.fetched + ")");
  check(r2.ids.join() === "103", "whole-word 'pool' matches the villa only (not 'carpool'): " + r2.ids.join());

  console.log("alerts: create → silent baseline → history");
  const created = await worker.evaluate(async ({ FEED }) => HANDLERS.createAlert({ url: FEED, keywords: ["choengmon"], exclude: ["agent"], intervalMin: 60, max: 10, concurrency: 2, name: "Test" }), { FEED });
  check(created.ok && !created.merged, "alert created");
  const id = created.alert.id;
  const primed = await worker.evaluate(async (id) => {
    for (let i = 0; i < 60; i++) { const a = (await getAlerts()).find((x) => x.id === id); if (a && a.primed) return a; await new Promise((r) => setTimeout(r, 500)); }
    return null;
  }, id);
  check(primed && primed.lastStatus === "ok", "baseline run completed with status ok");
  const hist = await worker.evaluate((id) => getHist(id), id);
  check(hist.length === 1 && hist[0].id === "101" && hist[0].isNew === false, "baseline history saved quietly (isNew false): " + JSON.stringify(hist.map((h) => [h.id, h.isNew])));
  const dup = await worker.evaluate(async ({ FEED }) => HANDLERS.createAlert({ url: FEED, keywords: ["Choengmon"], exclude: ["Agent"], intervalMin: 30 }), { FEED });
  check(dup.ok && dup.merged && dup.alert.intervalMin === 30, "saving the same search again merges into the existing alert (interval updated)");
  const alarm = await worker.evaluate((id) => chrome.alarms.get("mds-alert-" + id), id);
  check(alarm && alarm.scheduledTime > Date.now() + 25 * 60e3, "one-shot alarm armed for the next interval");
  const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
  check(badge === "", "badge empty after a silent baseline (got " + JSON.stringify(badge) + ")");

  console.log("cancel: stop a running alert");
  const cancelled = await worker.evaluate(async (id) => {
    enqueueJob({ kind: "alert", id, manual: true, prime: false });
    await new Promise((r) => setTimeout(r, 1500));                 // let it open the feed
    const c = await cancelJobs((j) => j.kind === "alert" && j.id === id);
    for (let i = 0; i < 40 && currentJob; i++) await new Promise((r) => setTimeout(r, 250));
    const a = (await getAlerts()).find((x) => x.id === id);
    return { c, status: a.lastStatus, busy, tabs: pool.length, collectorTab };
  }, id);
  check(cancelled.c.cancelled === true, "running job was flagged");
  check(cancelled.status === "cancelled", "alert recorded status 'cancelled' (" + cancelled.status + ")");
  check(!cancelled.busy && cancelled.tabs === 0 && cancelled.collectorTab == null, "queue idle, pool and collector closed");
  await feed.waitForTimeout(500);
  check(baselineTabs() === before, "no helper tabs left after cancel (" + baselineTabs() + ")");

  console.log("logged-out session is detected and backs off");
  loginMode = true;
  const lo = await worker.evaluate(async (id) => {
    enqueueJob({ kind: "alert", id, manual: false, prime: false });
    for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 500)); const a = (await getAlerts()).find((x) => x.id === id); if (a.lastStatus === "login") return { a, alarm: await chrome.alarms.get("mds-alert-" + id), badge: await chrome.action.getBadgeText({}) }; }
    return { a: (await getAlerts()).find((x) => x.id === id) };
  }, id);
  check(lo.a.lastStatus === "login" && lo.a.failCount === 1, "run classified as 'login' (" + lo.a.lastStatus + ", failCount " + lo.a.failCount + ")");
  check(lo.badge === "!", "badge shows '!' for a failing alert");
  check(lo.alarm && lo.alarm.scheduledTime > Date.now() + 50 * 60e3, "next run backed off beyond the 30-min interval (doubled)");
  loginMode = false;

  console.log("hide a listing");
  const hid = await worker.evaluate(async ({ FEED, match }) => {
    await HANDLERS.dismiss({ id: "101" });
    const cache = {};
    const res = await runFeedScan({ feedUrl: FEED, max: 10, concurrency: 2, match, noCache: true }, { manual: true, cancel: { requested: false }, cache, dismissed: await loadDismissed(), onProgress: () => {} });
    await closePool();
    await HANDLERS.dismiss({ id: "101", undo: true });
    return { skipped: res.skipped, matches: res.matches.length };
  }, { FEED, match });
  check(hid.skipped === 1 && hid.matches === 0, "hidden listing is skipped without opening a tab");

  console.log("panel UI through the closed shadow root (CDP)");
  fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
  await feed.reload();
  await feed.waitForSelector("#mds-host", { state: "attached", timeout: 10000 });
  const cdp = await context.newCDPSession(feed);
  const find = async (selector) => {
    await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { searchId, resultCount } = await cdp.send("DOM.performSearch", { query: selector, includeUserAgentShadowDOM: true });
    if (!resultCount) { await cdp.send("DOM.discardSearchResults", { searchId }); return null; }
    const { nodeIds } = await cdp.send("DOM.getSearchResults", { searchId, fromIndex: 0, toIndex: 1 });
    await cdp.send("DOM.discardSearchResults", { searchId });
    return nodeIds[0];
  };
  const clickNode = async (selector) => {
    const nodeId = await find(selector);
    if (!nodeId) throw new Error("not found: " + selector);
    const { model } = await cdp.send("DOM.getBoxModel", { nodeId });
    const q = model.content;
    await feed.mouse.click((q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4);
  };
  const textOf = async (selector) => {
    const nodeId = await find(selector);
    if (!nodeId) return null;
    const { outerHTML } = await cdp.send("DOM.getOuterHTML", { nodeId });
    return outerHTML;
  };
  const waitFor = async (selector, ms, test) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const html = await textOf(selector); if (html != null && (!test || test(html))) return html; await feed.waitForTimeout(400); }
    return null;
  };
  await clickNode("#mds-kw");
  await feed.keyboard.press("Control+A");
  await feed.keyboard.type("choengmon, -agent");
  await feed.keyboard.press("Enter");
  const grid = await waitFor("#mds-gallery-grid", 60000, (h) => /mds-gcard/.test(h));
  check(!!grid, "Enter started a scan and the gallery opened");
  check(grid && (grid.match(/mds-gcard/g) || []).length === 1 && /data-id="101"/.test(grid), "gallery shows exactly listing 101");
  check(grid && /<mark>Choengmon<\/mark>/.test(grid), "gallery highlights the hit");
  await feed.screenshot({ path: path.join(root, "test-results", "gallery.png") });
  const status = await textOf("#mds-status");
  check(/Done\. 1 match/.test(status || ""), "status reports the result: " + (status || "").replace(/<[^>]+>/g, "").trim());
  await feed.keyboard.press("Escape");
  await feed.waitForTimeout(300);
  check((await find("#mds-gallery")) == null, "Esc closes the gallery");
  check(/data-id="101"/.test((await textOf("#mds-results")) || ""), "panel results list has the match");
  check(((await feed.$$eval(".mds-badge", (els) => els.length)) === 1), "one in-feed badge drawn");
  await feed.screenshot({ path: path.join(root, "test-results", "panel.png") });

  // Cancel mid-scan: force a fresh read (no cache) so the worker phase lasts a few seconds.
  await clickNode("#mds-fresh");
  await clickNode("#mds-go");
  const cancelBtn = await waitFor("#mds-cancel", 15000, (h) => !/ hidden/.test(h));
  check(!!cancelBtn, "Cancel button visible during the scan");
  await feed.waitForTimeout(1200);
  await clickNode("#mds-cancel");
  const st2 = await waitFor("#mds-status", 5000, (h) => /cancelled/i.test(h));
  check(!!st2, "status says cancelled after clicking Cancel");
  const idle = await worker.evaluate(async () => { for (let i = 0; i < 40 && (busy || pool.length); i++) await new Promise((r) => setTimeout(r, 250)); return { busy, pool: pool.length, collectorTab }; });
  check(!idle.busy && idle.pool === 0, "worker idle and helper tabs closed after panel Cancel");
  await feed.waitForTimeout(500);
  check(baselineTabs() === before, "no stray tabs after panel Cancel (" + baselineTabs() + ")");

  console.log(failures ? `E2E FAILED (${failures})` : "E2E PASSED");
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.error("E2E FAIL:", e && e.stack || String(e));
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
