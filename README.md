# Marketplace Description Search (free)

A Chrome extension that searches Facebook Marketplace by words in the listing
**description** — the thing Facebook's own search can't do.

## Why this exists
Facebook's Marketplace search only matches listing **titles**. A rental titled
"3 Beds 2 Baths - House" whose description says *"Located in quiet area in
Choengmon"* never shows up when you search **choengmon**. This extension fixes
that: it opens each listing in a background tab, reads the description that
Facebook renders there, and keeps the ones containing your keyword.

## Install (load unpacked — takes 30 seconds)
1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `fb-marketplace-desc-search` folder.
4. Done. (No icon is bundled, so it shows a default puzzle-piece — that's fine.)

## Use
1. Go to Facebook Marketplace and run any normal **broad** search or open a
   category (e.g. search `house`, or open Property for Rent for your area).
   Broad is better — it loads the pool of listings to scan.
2. A blue **"🔎 Description Search"** panel appears at the top-right.
3. Type your keyword(s), e.g. `choengmon` (comma-separate for several).
4. Set how many listings to scan, then click **Scan descriptions**.
5. A background tab quietly cycles through the listings. Matches get a blue
   outline on the page and are listed in the panel with links. "Hide
   non-matches" (on by default) hides the rest.

### Your example
Search `house` (with your location set to Koh Samui), keyword `choengmon` →
the "3 Beds 2 Baths - House" listing that Facebook's search hid will surface.

## Options
- **match all** — require every keyword (default is match any).
- **hide non-matches** — collapse non-matching cards after the scan.
- **Max listings** — how many to open/scan (more = slower).

## How it works (and limits)
- It reads the description from each listing's rendered page (the description
  is loaded by JavaScript and isn't in the raw HTML, so a background tab is the
  reliable way to read it). It auto-clicks "See more" so long descriptions are
  fully searched.
- Scanning is **sequential and throttled** (~1 listing/sec) on purpose.
  Automated browsing is against Facebook's Terms of Service and hammering it can
  get an account rate-limited. Keep scans modest and personal.
- If Facebook changes its page layout, the section-detection may need a tweak
  (see `SECTION_END` / the `Description` markers in `background.js`).
- A single background tab is opened for the duration of a scan and closed when
  it finishes; it does not steal focus.

## Files
- `manifest.json` — extension config (MV3)
- `background.js` — opens listings, scrapes + matches descriptions
- `content.js` — the on-page panel and result display
- `panel.css` — panel styling

---

## Scheduled keyword alerts (v1.1)
Get notified when a **new** listing mentions your keyword in its description.

**Set one up (two ways):**
- On a Marketplace search/category page, fill in the panel's keyword(s) and click
  **＋ Save as alert**, then enter how often to check (minutes); or
- Click the extension's toolbar icon to open the **Alerts** popup, which shows the
  current page's feed, lets you set keywords + interval, and lists all alerts.

**How it behaves:**
- On each run it opens the saved feed (sorted newest-first), scans descriptions,
  and fires a desktop notification for any match it hasn't seen before. Click a
  notification to open that listing.
- When you first save an alert it quietly records current matches as "already
  seen", so you only get pinged about listings that appear *after* setup.
- Manage/Run-now/Remove alerts from the toolbar popup.
- Intervals use Chrome's alarms, so checks run only while Chrome is open.
- Same fair-use note applies — keep intervals reasonable (15 min minimum offered).

## Files (v1.1)
- `manifest.json` — extension config (MV3)
- `background.js` — scanning engine + alert scheduler + notifications
- `content.js` — on-page panel (manual scan + Save as alert)
- `popup.html` / `popup.js` — alert manager (toolbar icon)
- `panel.css` — panel styling
- `icon16.png` / `icon48.png` / `icon128.png` — toolbar/store icons

## v1.2 — works with in-app navigation
Facebook is a single-page app: clicking the Marketplace icon from your feed
changes the page without a full reload, so earlier versions only showed the
panel on a direct page load. v1.2 runs on all of facebook.com, watches for
in-app URL changes, and shows the panel within ~1 second whenever you land on a
Marketplace search/category page (and hides it elsewhere). After updating,
reload the extension at `chrome://extensions` (the circular refresh arrow).

## v1.3 — speed, reliability, and newest-first
- **Faster:** listings are now scanned in parallel using a small pool of tabs.
  Set **Parallel tabs** (1–5, default 3) in the panel; alerts use 3. There's no
  way to read descriptions in bulk (Facebook only renders them per listing), so
  parallelism + scanning fewer/newer listings is where the speed comes from.
  Higher parallelism is faster but raises rate-limit/ban risk — keep it modest.
- **Reliable loading:** the listing collector now scrolls patiently and
  *accumulates* IDs as it goes, so it keeps counting even when Facebook recycles
  off-screen cards out of the page (the old version could stall around ~75).
  It shows a live "found N / max" count while loading.
- **Newest first:** click **↻ Sort newest first** to reload the search sorted
  by most-recently-listed before scanning (the button shows a checkmark once
  applied). Scanning follows the page's order, so this makes a one-time scan
  cover the newest listings first. **Alerts already sort newest automatically.**
  For tighter control, also use Facebook's own **Date listed** filter to limit
  how far back you scan — that's the most reliable way to skip old inventory.
