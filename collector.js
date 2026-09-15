// Feed collector — the ONE place that knows how to find listing cards and coax Facebook
// into lazy-loading more. Runs in the extension's isolated world on a Marketplace feed:
// the panel (content.js) calls it directly for manual scans, and the service worker
// injects this file + shared.js for scheduled alerts. Returns
//   { ids, thumbs, scrolled, scrollable, href, state, cancelled }
// where `state` is "ok" | "login" | "blocked" so a logged-out session is reported
// instead of being scanned, and `scrolled`/`scrollable` let the caller tell an
// occluded (non-rendering) window from a page that simply has nothing more to load.
(function (g) {
  if (g.__mdsCollect) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  g.__mdsCollect = async function collect(max, opts) {
    opts = opts || {};
    const { ITEM_RE, ITEM_LINK_SEL, bestImageIn } = g.MDS;
    const isCancelled = opts.isCancelled || (() => false);
    const onProgress = opts.onProgress || (() => {});
    const found = new Set();
    const thumbs = {};
    const grab = () => document.querySelectorAll(ITEM_LINK_SEL).forEach((a) => {
      const m = a.href.match(ITEM_RE);
      if (!m) return;
      found.add(m[1]);
      const img = bestImageIn(a);            // largest image inside the card link = that listing's photo
      if (img) thumbs[m[1]] = img;
    });
    const pageState = () => {
      const p = location.pathname;
      if (/^\/(login|checkpoint|recover|two_step_verification)/.test(p) || document.querySelector('form[action*="/login"]')) return "login";
      if (/temporarily blocked/i.test(document.title)) return "blocked";
      return "ok";
    };
    const scrollable = () => document.documentElement.scrollHeight > window.innerHeight + 50;
    const atBottom = () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;

    const start = Date.now();
    // Wait for the first card instead of sleeping a fixed 2.5 s (feeds render after the load event).
    while (!document.querySelector(ITEM_LINK_SEL) && Date.now() - start < (opts.firstCardMs || 6000) && pageState() === "ok" && !isCancelled()) await sleep(250);
    const y0 = window.scrollY;
    grab();
    let stable = 0, maxY = 0;
    // Hard cap 180 s: when injected by the worker this whole call must stay under
    // Chrome's 5-minute limit for a single extension API call.
    while (!isCancelled() && found.size < max && Date.now() - start < 180000) {
      const before = found.size;
      window.scrollBy(0, Math.max(900, Math.floor(window.innerHeight * 0.9)));
      window.dispatchEvent(new Event("scroll"));
      await sleep(700 + Math.random() * 500);
      grab();
      if (window.scrollY > maxY) maxY = window.scrollY;
      stable = found.size === before ? stable + 1 : 0;
      onProgress({ found: found.size, max, stable, elapsedMs: Date.now() - start });
      // At the real bottom of the page 3 quiet ticks are proof; elsewhere give Facebook longer.
      if (stable >= (atBottom() ? 3 : 12)) break;
    }
    if (opts.restoreScroll !== false) window.scrollTo(0, y0);
    return {
      ids: Array.from(found).slice(0, max), thumbs,
      scrolled: maxY > 0, scrollable: scrollable(),
      href: location.href, state: pageState(), cancelled: isCancelled(),
    };
  };
})(globalThis);
