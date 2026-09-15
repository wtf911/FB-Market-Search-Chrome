# Marketplace Description Search (free)

A Chrome extension (Manifest V3) that searches **Facebook Marketplace by the words
inside each listing's description** — the thing Facebook's own search can't do —
and can watch a search on a schedule to notify you when a new matching listing appears.

## Why this exists
Facebook's Marketplace search only matches listing **titles**. A rental titled
"3 Beds 2 Baths - House" whose description says *"Located in a quiet area in
Choengmon"* never shows up when you search **choengmon**. This extension fixes
that: it opens each listing in a background tab, reads the description Facebook
renders there, and keeps the ones that contain your keyword.

## Install (load unpacked — ~30 seconds)
1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the folder you cloned this repository into.
4. The extension's icon appears in your toolbar — pin it for one-click access to
   the Alerts popup.

After editing the files, click the circular **refresh** arrow on the extension's
card at `chrome://extensions` to reload it, then refresh any open Facebook tabs
(the panel on an already-open tab will tell you to).

## Two ways to use it

### 1. Search descriptions on demand
1. Go to Facebook Marketplace and run any **broad** search or open a category
   (e.g. search `house`, or open *Property for Rent* for your area). Broad is
   better — it loads a large pool of listings to scan.
2. A blue **"🔎 Description Search"** panel appears at the top-right. Drag its
   header to move it; click the **–** to collapse it (progress still shows in the header).
3. Type your keyword(s), press **Enter** or click **Scan descriptions**.
   - comma-separate several: `choengmon, sea view`
   - quote a phrase that contains a comma: `"15,000"`
   - exclude with a leading minus: `-agent, -rented`
   - tick **whole words** so `pool` stops matching `carpool` (Thai terms always match as substrings)
4. While listings load, a small toast at the bottom shows the count — you can keep
   using the page; **Esc** or **✕ Cancel** stops it. A pool of background tabs then
   quietly reads the descriptions (helper tabs are muted and don't download photos).
   Listings read in the last 12 hours come from the cache and don't open a tab at all;
   tick **re-read listings cached in the last 12 h** to force a full pass.
5. Matches get a blue border in the feed and are listed in the panel with photo,
   price and the sentence that matched. **×** hides a listing from every future scan
   and alert (undo available).
6. With **show only matches** on (the default), a full-screen **gallery** of just
   the matching listings opens when the scan finishes, sortable by price, with
   **Open all** and **Copy links**. Press **Esc** or **Show all listings** to close it;
   **Show matches (N)** reopens it without rescanning.
7. Navigating to a listing and back keeps your results and badges. Cancel anytime
   with **✕ Cancel scan** — don't close the helper tabs by hand.

**Your example:** Search `house` (location set to Koh Samui), keyword `choengmon`
→ the "3 Beds 2 Baths - House" listing that Facebook's title-only search hid will
surface.

### 2. Scheduled keyword alerts
Get a desktop notification when a **new** listing mentions your keyword in its
description.

**Create an alert (two ways):**
- On a Marketplace search/category page, fill in the panel's keyword(s), pick an
  interval and click **＋ Save as alert**; or
- Click the toolbar icon to open the **🔔 Marketplace Description Alerts** popup.
  It picks up the current Marketplace tab's URL — set your keyword(s), choose
  **Check every** (15 min to 24 h, or a custom number of minutes), adjust
  **Max scan**, an optional **price range** and **name**, and click **Save alert**.
  Saving the same search twice updates the existing alert instead of duplicating it.

**How alerts behave:**
- Right after you save, a quiet **baseline scan** records the current matches as
  already seen, so you're only pinged about listings that appear *after* setup.
- On each run the alert opens its saved search **sorted newest-first**, reads only the
  listings it hasn't read recently (the rest come from the cache), and fires a
  desktop notification for each match it hasn't seen before — or one digest when more
  than three arrive at once. Click a notification to open the listing (or the gallery).
- Every match is kept in a per-alert **history** (newest first, up to 500). Listings
  new since you last looked are tagged **NEW** until you click **Clear new**; the
  toolbar badge shows how many are waiting.
- In the popup each alert shows its last run (outcome, duration, cache hits), the
  next run time and counts, plus **Results**, **Fullscreen**, **Run now**, **Edit**,
  **Pause/Resume** and **Remove**. Editing keeps the history; changing the terms
  re-baselines quietly. A running job appears at the top with a **Stop** button.
- If Facebook shows a login or "temporarily blocked" page, the run stops after three
  such pages, the alert is marked accordingly (badge **!**), you get one notification,
  and it retries with a doubling interval until a run succeeds.
- Scheduled runs never steal focus while you're using the computer. If Chrome's window
  is hidden and Facebook won't lazy-load, the run takes what it can ("Partial") and
  only brings the window forward after two minutes of idle.
- Alerts run on Chrome's alarms, so checks only happen **while Chrome is open**. If the
  last Marketplace helper tab is also the last tab in Chrome, it's parked on a small
  explainer page instead of closed, so Chrome stays running.

## Options (panel and popup)
- **match all** — require *every* keyword to appear (default is match *any*).
- **search titles too** — also match the listing title, not just the description.
- **whole words** — match whole words only (`pet` but not `carpet`).
- **show only matches** *(panel only)* — open the gallery of matches after a scan
  (on by default); turn it off to just highlight matches in the feed.
- **Max listings / Max scan** — how many listings to consider (more = slower). The
  panel allows up to 1000 (it asks you to confirm above 200); alerts up to 200.
- **Parallel tabs** — how many listings to read at once (1–5 for scans, 1–3 for
  alerts). Faster, but higher values raise rate-limit/ban risk — keep it modest.
- **Price min / max** *(alerts)* — drop matches outside the range. If a listing is
  posted at ฿0/฿1, a price written in the description ("25,000 per month") is used.
- **↻ Sort newest first** *(panel)* — reload the current search sorted by
  most-recently-listed before scanning (shows a ✓ once applied). Alerts always
  sort newest automatically.

## How it works (and limits)
- **Descriptions aren't in the raw HTML** — Facebook renders them with JavaScript
  per listing — so the only reliable way to read them is to open each listing in a
  background tab and read the rendered page. It reads `og:description` first, then
  the "Description" heading in 25 UI languages, and expands "See more" so long
  descriptions are fully searched.
- **Parallel but throttled.** Listings are read by a small pool of background tabs
  with jittered pauses and a global navigation limiter; scheduled runs share an hourly
  page-load budget. Automated browsing is against Facebook's Terms of Service and
  hammering it can get an account rate-limited — keep scans modest and personal.
- **Narrow with Facebook's own filters.** Set a location/radius and use the
  **Date listed** filter to limit how far back you scan; that's the most reliable
  way to skip old inventory.
- **Layout-sensitive.** If Facebook changes its page structure, the description
  detection (`scrapePage` in `background.js`) or the card detection (`collector.js`)
  may need a tweak — both live in exactly one place.
- Background tabs are opened only for the duration of a scan and closed when it
  finishes; if the extension is reloaded mid-run they're closed at the next start.

## Data & privacy
Everything stays in your browser. `chrome.storage.local` holds your alerts (the saved
search URL — which can embed map coordinates if you set a custom location — keywords,
options and the ids already seen), each alert's match history (title, price, a
200-character snippet, image URL), the 12-hour description cache, the list of hidden
listings and the panel's last settings. Nothing is sent anywhere; there is no
analytics. **Remove** an alert to delete its history, or uninstall the extension to
wipe everything.

Permissions: `scripting` (read listing pages), `storage`, `alarms` (schedules),
`notifications`, `idle` (to avoid stealing focus while you're active) and
`declarativeNetRequestWithHostAccess` (to block photos/video in the helper tabs),
limited to `https://*.facebook.com/*`.

## Files
- `manifest.json` — extension config (Manifest V3)
- `background.js` — the scanning engine (tab pool, description scrape + matching,
  cache), job queue, alert scheduler, notifications, badge
- `shared.js` — helpers used by every context (keyword parsing, matching,
  highlighting, feed detection, prices)
- `collector.js` — the one feed collector (finds cards, scrolls, reports login walls)
- `content.js` — the on-page panel (in a shadow root), in-feed highlighting, matches gallery
- `popup.html` / `popup.js` — the toolbar **Alerts** manager
- `gallery.html` / `gallery.js` — full-page view of one alert's saved matches
- `parked.html` — the keep-alive page used instead of closing Chrome's last tab
- `panel.css` — styles shared by the panel, toast and galleries (light + dark)
- `icon16.png` / `icon48.png` / `icon128.png` — toolbar and notification icons
- `tests/` — unit tests (`npm test`), Playwright smoke (`npm run smoke`) and
  end-to-end against a fake Marketplace (`npm run e2e`)
- `scripts/build-zip.sh`, `build-zip.ps1`, `release.ps1` — packaging and release

## Development
```
npm install
npm run lint      # eslint
npm test          # unit tests for shared.js
npm run smoke     # loads the extension in Chromium, checks popup + gallery
npm run e2e       # full pipeline against a fake Marketplace (no real Facebook traffic)
npm run zip       # marketplace-description-search-v<version>.zip
```
`smoke` and `e2e` need `npx playwright install chromium` once, or set `CHROMIUM_PATH`
to a Chromium binary. CI runs all of the above on every push.

---

*Personal-use tool. Be a good citizen: keep scan sizes and alert frequencies reasonable.*
