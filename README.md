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
3. Click **Load unpacked** and select this `fb-marketplace-desc-search` folder.
4. The extension's icon appears in your toolbar — pin it for one-click access to
   the Alerts popup.

After editing the files, click the circular **refresh** arrow on the extension's
card at `chrome://extensions` to reload it.

## Two ways to use it

### 1. Search descriptions on demand
1. Go to Facebook Marketplace and run any **broad** search or open a category
   (e.g. search `house`, or open *Property for Rent* for your area). Broad is
   better — it loads a large pool of listings to scan.
2. A blue **"🔎 Description Search"** panel appears at the top-right. (Click its
   header or the **–** to collapse it.)
3. Type your keyword(s) — comma-separate several, e.g. `choengmon, sea view`.
4. Set **Max listings** (how many to open) and **Parallel tabs**, then click
   **Scan descriptions**. A brief overlay shows the live "Loading listings…
   N / max" count while it loads them.
5. A small pool of background tabs quietly cycles through the listings. Matches
   get a blue border in the feed and are listed in the panel with links and prices.
6. With **show only matches** on (the default), a full-screen **gallery** of just
   the matching listings opens when the scan finishes — each card shows the photo,
   price, title, and the description snippet with your keyword highlighted. Press
   **Esc** or **Show all listings** to close it.

**Your example:** Search `house` (location set to Koh Samui), keyword `choengmon`
→ the "3 Beds 2 Baths - House" listing that Facebook's title-only search hid will
surface.

### 2. Scheduled keyword alerts
Get a desktop notification when a **new** listing mentions your keyword in its
description.

**Create an alert (two ways):**
- On a Marketplace search/category page, fill in the panel's keyword(s) and click
  **＋ Save as alert**, then type how often to check in minutes (5 min minimum); or
- Click the toolbar icon to open the **🔔 Marketplace Description Alerts** popup.
  It picks up the current Marketplace tab's URL — set your keyword(s), choose
  **Check every** (15 min, 30 min, 1 hour, 3 hours, or 6 hours), adjust
  **Max scan** / options, and click **Save alert**.

**How alerts behave:**
- On each run the alert opens its saved search **sorted newest-first**, scans
  descriptions, and fires a desktop notification for any match it hasn't seen
  before. Click a notification to open that listing.
- When you first save an alert it silently records the current matches as
  "already seen", so you're only pinged about listings that appear *after* setup.
- Every match is kept in a per-alert **history** (newest first, up to 500).
  Listings new since you last looked are tagged **NEW** until you click **Clear new**.
- In the popup, each alert shows its last-run time and "*N saved, M new*" counts,
  plus buttons: **Results** (expand the saved history inline, with **All / New**
  filters and **Clear new / Clear all**), **View fullscreen** (open the matches as
  a full-page gallery), **Run now**, and **Remove**.
- Alerts run on Chrome's alarms, so checks only happen **while Chrome is open**.

## Options (panel and popup)
- **match all** — require *every* keyword to appear (default is match *any*).
- **search titles too** — also match the listing title, not just the description.
- **show only matches** *(panel only)* — open the gallery of matches after a scan
  (on by default); turn it off to just highlight matches in the feed.
- **Max listings / Max scan** — how many listings to open and read (more = slower).
  The panel allows up to 1000; alerts up to 200.
- **Parallel tabs** — how many listings to scan at once (1–5, default 3). Faster,
  but higher values raise rate-limit/ban risk — keep it modest.
- **↻ Sort newest first** *(panel)* — reload the current search sorted by
  most-recently-listed before scanning (shows a ✓ once applied). Alerts always
  sort newest automatically.

## How it works (and limits)
- **Descriptions aren't in the raw HTML** — Facebook renders them with JavaScript
  per listing — so the only reliable way to read them is to open each listing in a
  background tab and read the rendered page. It auto-clicks "See more" so long
  descriptions are fully searched.
- **Parallel but throttled.** Listings are scanned by a small pool of background
  tabs (1–5) with a short pause between each. Automated browsing is against
  Facebook's Terms of Service and hammering it can get an account rate-limited —
  keep scans modest and personal, and parallelism low.
- **Narrow with Facebook's own filters.** Set a location/radius and use the
  **Date listed** filter to limit how far back you scan; that's the most reliable
  way to skip old inventory.
- **Layout-sensitive.** If Facebook changes its page structure, the description
  detection may need a tweak (see `scrapePage` and its section markers in
  `background.js`).
- Background tabs are opened only for the duration of a scan and closed when it
  finishes; they don't steal focus. (The service worker keeps a single blank tab
  parked if closing the last one would otherwise quit Chrome and stop your alerts.)

## Files
- `manifest.json` — extension config (Manifest V3)
- `background.js` — the scanning engine (background-tab pool, description scrape +
  matching), alert scheduler, and notifications
- `content.js` — the on-page panel, in-feed highlighting, and the matches gallery
  overlay
- `popup.html` / `popup.js` — the toolbar **Alerts** manager (create / run / remove
  alerts, browse saved history)
- `gallery.html` / `gallery.js` — full-page view of one alert's saved matches
- `panel.css` — styles shared by the panel, overlay, and galleries
- `icon16.png` / `icon48.png` / `icon128.png` — toolbar and notification icons

---

*Personal-use tool. Be a good citizen: keep scan sizes and alert frequencies reasonable.*
