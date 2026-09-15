# Changelog

## 2.0.0

A ground-up hardening release. Existing alerts and their history are migrated
automatically (histories move to their own storage keys; alerts that have run
before count as already baselined).

### Fixed
- Clicking a desktop notification now always opens the listing (the URL is derived
  from the notification id instead of worker memory that Chrome wiped after ~30 s).
- An alert run no longer overwrites storage with a stale copy of every alert — creating,
  removing or clearing alerts while a run is in progress is no longer reverted.
- The silent baseline is a property of the alert (`primed`), so stopping or losing the
  first run can no longer turn the next one into a notification storm.
- Scheduled runs never steal focus while you are active. Foregrounding the collector
  (needed when the window is hidden) happens only for a manual "Run now" or after two
  minutes of idle, and the "did it scroll?" heuristic no longer misfires on short pages.
- Keywords are matched against the description only. Pages without a description
  section (blank, deleted, login, non-English UI) no longer match against navigation
  text or "More like this" cards.
- Logged-out, blocked, deleted and offline runs are detected and recorded as such; a run
  stops after three consecutive login/blocked pages, backs off with a doubling interval,
  shows "!" on the toolbar badge and notifies once per failure streak.
- Cancel is targeted: a panel only cancels its own scan, the popup's Stop names the run,
  and queued scans that get dropped tell their panel instead of leaving it stuck.
- Cancelling during collection and scanning again immediately no longer leaves two
  scroll loops running; late messages from a cancelled job are ignored.
- `seen` is deduplicated, so the 1000-listing memory is real again.
- A running alert is not re-queued by its own alarm; repeated "Run now" clicks no longer
  stack full scans.
- Alarms are one-shot and re-armed from the end of each run; startup no longer resets
  every alert to fire one minute later, and orphaned alarms are pruned.
- Descriptions are read through language-independent sources first (`og:description`),
  with heading markers for 25 UI languages as the fallback.
- After a 20 s navigation timeout the previous listing is no longer scraped under the
  new id; the retry really uses a fresh tab.
- Job failures are logged and reported to the panel instead of leaving it on "Scanning…".
- The popup's Stop button is no longer rebuilt every 1.2 s; "Stopping…" stays put.
- Reloading the extension mid-scan: the old panel explains itself instead of dying
  silently, and helper tabs are closed at the next worker start.
- The tab pool is never reassigned mid-flight; the keep-alive tab is only adopted when
  it is still ours (it now shows an explanatory page instead of about:blank).
- Highlighting no longer marks text inside HTML entities.
- Broken (expired) thumbnails fall back to the placeholder.
- The popup and the panel agree on which pages are feeds; the panel no longer appears
  on Inbox / Selling / Create listing pages.
- The `tabs` permission was dropped (no more "Read your browsing history" warning).

### Added
- Per-listing description cache (12 h): repeat scans and alert runs open only listings
  that are actually new. Tick "re-read listings cached in the last 12 h" to force a full pass.
- Exclude keywords (`-agent`), quoted phrases (`"15,000"`), whole-word matching.
- Edit, pause/resume and name alerts; changing terms keeps the history and re-baselines quietly.
- Hide a listing (× on any card) so it never shows up in scans or alerts again; undo available.
- Toolbar badge with the unread count ("!" when an alert is failing).
- Digest notification when more than three new matches arrive at once.
- Price min/max filter for alerts (falls back to a price written in the description)
  and price sorting in the galleries.
- Copy links, Export CSV and "Open new" in the gallery; Open all / Copy links in the panel gallery.
- Panel: all options and the collapsed state are remembered; Enter scans; header shows
  live progress even when collapsed; draggable; Esc cancels or closes the gallery;
  richer results list with thumbnails, snippets and a Clear button; dark mode.
- Popup: live activity row for any running job (including page scans) with Stop; queued
  runs listed; last-run outcome, duration, cache hits and next-run time per alert;
  expanded panels and filters survive refreshes; confirmation for Clear all / Remove;
  custom interval; dark mode.
- Gallery page updates live; Show hidden toggle.
- Jittered pacing, a global navigation limiter and an hourly page-load budget for
  scheduled runs; helper tabs are muted and don't download photos/video.
- Tooling: shared helpers in `shared.js`, one collector in `collector.js`, unit tests,
  Playwright smoke + end-to-end tests, ESLint, CI, allow-list zip build, safer release script.

### Changed
- Minimum alert interval is 15 minutes; alert scans are capped at 200 listings and 3 tabs.
- Minimum Chrome version is 116.
