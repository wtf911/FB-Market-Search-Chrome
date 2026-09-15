// Smoke test: load the unpacked extension in Chromium, make sure the service worker
// boots, the popup renders, the message API answers, and a seeded alert shows up in
// the popup and the gallery. Needs `npx playwright install chromium` once.
// Run with `npm run smoke`.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mds-smoke-"));
const fail = (msg) => { console.error("SMOKE FAIL:", msg); process.exitCode = 1; };

// Extensions need the full browser (not the headless shell): Playwright's "chromium"
// channel, or a local binary via CHROMIUM_PATH when the matching build isn't installed.
const executablePath = process.env.CHROMIUM_PATH;
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  ...(executablePath ? { executablePath } : { channel: "chromium" }),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(worker.url()).host;
  console.log("service worker up:", worker.url());

  // Seed one alert so the UIs have something to render.
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      schemaVersion: 2,
      alerts: [{ id: "1", url: "https://www.facebook.com/marketplace/search/?query=house", keywords: ["choengmon"], exclude: ["agent"], matchAll: false,
        searchTitles: false, wholeWord: false, intervalMin: 60, max: 40, concurrency: 2, enabled: true, primed: true, seen: ["1"], lastRun: Date.now() - 60000,
        lastStatus: "ok", histCount: 1, lastNew: 1, nextRun: Date.now() + 3540000 }],
      "hist:1": [{ id: "1", url: "https://www.facebook.com/marketplace/item/1/", title: "3 Beds 2 Baths - House", price: "฿15,000 / month", priceNum: 15000,
        snippet: "Located in a quiet area in Choengmon", image: "", hits: ["choengmon"], isNew: true, ts: Date.now() }],
    });
  });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector(".alert", { timeout: 20000 });
  const title = await popup.textContent(".alert .title b");
  if (!/choengmon/.test(title)) fail("popup did not render the seeded alert: " + title);
  const rs = await popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "runState" }, r)));
  if (!rs || rs.ok !== true) fail("runState message failed: " + JSON.stringify(rs));
  await popup.click(".alert [data-results]");
  await popup.waitForSelector(".res .ttl", { timeout: 5000 });
  const rowTitle = await popup.textContent(".res .ttl");
  if (!/3 Beds/.test(rowTitle)) fail("history row not rendered: " + rowTitle);
  // Pause / resume round-trips through updateAlert and the alarm.
  await popup.click(".alert [data-pause]");
  await popup.waitForFunction(() => /Resume/.test(document.querySelector(".alert [data-pause]").textContent), null, { timeout: 5000 });
  const alarms = await worker.evaluate(() => chrome.alarms.getAll());
  if (alarms.some((a) => a.name === "mds-alert-1")) fail("pausing did not clear the alarm");
  await popup.click(".alert [data-pause]");
  await popup.waitForFunction(() => /Pause/.test(document.querySelector(".alert [data-pause]").textContent), null, { timeout: 5000 });
  const alarms2 = await worker.evaluate(() => chrome.alarms.getAll());
  if (!alarms2.some((a) => a.name === "mds-alert-1")) fail("resuming did not re-arm the alarm");
  console.log("popup ok");

  const gallery = await context.newPage();
  await gallery.goto(`chrome-extension://${extId}/gallery.html?id=1&filter=new`);
  await gallery.waitForSelector(".mds-gcard", { timeout: 10000 });
  const snippet = await gallery.innerHTML(".mds-gsnip");
  if (!/<mark>Choengmon<\/mark>/.test(snippet)) fail("gallery did not highlight the hit: " + snippet);
  await gallery.click('[data-act="clearNew"]');
  await gallery.waitForFunction(() => /New \(0\)/.test(document.body.textContent), null, { timeout: 5000 });
  console.log("gallery ok");

  const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
  if (badge !== "") fail("badge should be empty after Clear new, got " + JSON.stringify(badge));

  const missing = await context.newPage();
  await missing.goto(`chrome-extension://${extId}/gallery.html?id=nope`);
  await missing.waitForFunction(() => /Alert not found/.test(document.body.textContent), null, { timeout: 5000 });
  console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
