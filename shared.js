// Helpers shared by every execution context: the service worker (importScripts),
// the content script (listed first in manifest content_scripts) and the extension
// pages (<script src="shared.js">). Everything hangs off globalThis.MDS so nothing
// leaks as a loose global. No chrome.* or DOM access at load time — the unit tests
// load this file in plain Node.
(function (g) {
  const LIMITS = {
    manualMax: 1000,          // panel "Max listings" ceiling for a one-off scan
    alertMax: 200,            // ceiling for scheduled alerts (clamped in the worker, the single writer)
    confirmScanAbove: 200,    // the panel asks for a second click above this
    minIntervalMin: 15,
    maxIntervalMin: 24 * 60,
    maxConcurrency: 5,
    alertConcurrency: 3,      // scheduled runs are capped here even if the alert asks for 5
    defaultMax: 40,
    historyMax: 500,
    seenMax: 1000,
    cacheMax: 2000,
    cacheTtlMs: 12 * 3600e3,  // a seller editing a description inside this window is missed until it expires
    dismissedMax: 5000,
    loadsPerHour: 600,        // scheduled runs are skipped once this rolling budget is spent
  };
  const ITEM_RE = /\/marketplace\/item\/(\d+)/;
  const ITEM_LINK_SEL = "a[href*='/marketplace/item/']";
  const itemUrl = (id) => "https://www.facebook.com/marketplace/item/" + id + "/";

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  // One case/diacritic fold for haystacks and keywords: "İstanbul" == "istanbul", "café" == "cafe".
  function foldText(s) {
    return String(s || "").normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  }
  const hasThai = (s) => /[฀-๿]/.test(s);
  const dedupe = (arr) => Array.from(new Set(arr));

  // 'sea view, "15,000", -agent, !rented' -> { include: ["sea view", "15,000"], exclude: ["agent", "rented"] }
  function parseKeywords(str) {
    const include = [], exclude = [];
    const re = /\s*([-!]?)"([^"]*)"\s*|([^,]+)/g;
    let m;
    while ((m = re.exec(String(str || "")))) {
      let neg = m[1] === "-" || m[1] === "!";
      let k = (m[2] != null ? m[2] : m[3]).trim();
      if (m[2] == null && /^[-!]/.test(k)) { neg = true; k = k.slice(1).trim(); }
      if (!k) continue;
      (neg ? exclude : include).push(k);
    }
    return { include: dedupe(include), exclude: dedupe(exclude) };
  }
  function formatKeywords(include, exclude) {
    const q = (k) => (/[,"]/.test(k) ? '"' + k.replace(/"/g, "") + '"' : k);
    return [...(include || []).map(q), ...(exclude || []).map((k) => "-" + q(k))].join(", ");
  }

  // Substring test by default; whole-word (Unicode letters/digits as word chars) when asked,
  // except for Thai terms — Thai has no word spaces, so a boundary test would never match.
  function termTest(term, wholeWord) {
    const t = foldText(term);
    if (!t) return () => false;
    if (!wholeWord || hasThai(t)) return (h) => h.includes(t);
    const re = new RegExp("(^|[^\\p{L}\\p{N}])" + escapeRe(t) + "(?=$|[^\\p{L}\\p{N}])", "u");
    return (h) => re.test(h);
  }
  // text: { description, title }; o: { include, exclude, matchAll, searchTitles, wholeWord }
  function matchText(text, o) {
    const include = o.include || [], exclude = o.exclude || [];
    const desc = foldText(text.description), title = foldText(text.title);
    const inDesc = (t) => termTest(t, o.wholeWord)(desc);
    const inTitle = (t) => termTest(t, o.wholeWord)(title);
    const hits = include.filter((t) => inDesc(t) || (o.searchTitles && inTitle(t)));
    const titleHits = o.searchTitles ? include.filter((t) => inTitle(t) && !inDesc(t)) : [];
    const excludedBy = exclude.find((t) => inDesc(t) || inTitle(t)) || null;
    let matched = o.matchAll ? include.length > 0 && hits.length === include.length : hits.length > 0;
    if (excludedBy) matched = false;
    return { matched, hits, titleHits, excludedBy };
  }

  // A window of the description around the earliest hit, so the card shows WHY it matched.
  function snippetAround(description, hits, len) {
    len = len || 200;
    const d = String(description || "");
    if (!d) return "";
    const lo = d.toLowerCase();
    let at = -1;
    for (const h of hits || []) {
      const i = lo.indexOf(String(h).toLowerCase());
      if (i > -1 && (at < 0 || i < at)) at = i;
    }
    if (at <= 60) return d.slice(0, len);
    const start = Math.max(0, at - 60);
    return "…" + d.slice(start, start + len);
  }
  // Highlight AFTER splitting the raw text, so a keyword can never match inside "&amp;" and
  // every emitted piece is escaped exactly once.
  function highlightSnippet(snip, hits) {
    const raw = String(snip || "");
    const terms = (hits || []).map((h) => String(h)).filter(Boolean);
    if (!raw) return "";
    if (!terms.length) return escapeHtml(raw) + "…";
    const re = new RegExp("(" + terms.map(escapeRe).join("|") + ")", "giu");
    let out = "", last = 0, m;
    while ((m = re.exec(raw))) {
      if (!m[0]) { re.lastIndex++; continue; }
      out += escapeHtml(raw.slice(last, m.index)) + "<mark>" + escapeHtml(m[0]) + "</mark>";
      last = m.index + m[0].length;
    }
    return out + escapeHtml(raw.slice(last)) + "…";
  }

  function withNewestSort(url, base) {
    try {
      const u = new URL(url, base);
      u.searchParams.set("sortBy", "creation_time_descend");   // set, not append — keeps every other filter
      return u.toString();
    } catch (_) { return url; }
  }
  // Pages the panel and the popup both treat as scannable feeds. Item pages and the
  // account areas under /marketplace/ (inbox, your listings, create…) are not feeds.
  const NON_FEED = /^\/marketplace\/(item|you|inbox|create|notifications|saved|selling|buying|profile|groups|settings|help|deals|shops)(\/|$)/;
  function isFeedUrl(url, base) {
    try {
      const u = new URL(url, base);
      if (u.protocol !== "https:" || !/(^|\.)facebook\.com$/.test(u.hostname)) return false;
      const p = u.pathname;
      return /^\/marketplace(\/|$)/.test(p) && !NON_FEED.test(p);
    } catch (_) { return false; }
  }
  const isItemUrl = (url) => ITEM_RE.test(String(url || ""));

  // Largest image inside an element (a listing card = that listing's photo).
  function bestImageIn(el) {
    let best = "", bestA = 0;
    el.querySelectorAll("img").forEach((img) => {
      const s = img.currentSrc || img.src || "";
      if (!/^https?:/.test(s)) return;
      const a = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
      if (a >= bestA) { bestA = a; best = s; }
    });
    return best;
  }

  // Prices: symbol-prefixed (฿1,200 / CA$ 30), code-prefixed (THB 20,000), code-suffixed
  // (1 200 zł / 25 000 THB), with an optional per-period suffix kept for display.
  const CURRENCY_RE = new RegExp(
    "(?:(?:[A-Z]{1,3}\\$|R\\$|[฿$€£¥₹₩₱₫₺₴₪])\\s?\\d[\\d.,]*(?:\\s\\d{3}(?!\\d))*" +
    "|(?<![\\p{L}\\d])(?:THB|USD|EUR|GBP|CHF|AUD|CAD|NZD|SGD|MYR|IDR|PHP|VND|INR|JPY|KRW|RM|Rp|Rs)\\s?\\d[\\d.,]*(?:\\s\\d{3}(?!\\d))*" +
    "|\\d[\\d.,]*(?:\\s\\d{3}(?!\\d))*\\s?(?:€|kr|zł|Kč|Ft|lei|лв|₽|CHF|RM|USD|EUR|GBP|THB|บาท|baht)(?!\\p{L}))" +
    "(?:\\s?(?:/\\s?(?:month|mo|week|wk|day|night|hour|hr)\\b|per\\s+(?:month|week|day|night)\\b))?", "iu");
  // A "free" listing shows the word on a line of its own — never match it inside other
  // text (Facebook's sidebar has a "Free Stuff" category on every listing page).
  const FREE_RE = /(?:^|\n)[ \t]*(Free|Gratis|Kostenlos|ฟรี)[ \t]*(?=\n|$)/i;
  function extractPrice(text) {
    const s = String(text || "");
    let m = s.match(CURRENCY_RE);
    if (m) { const price = m[0].replace(/\s+/g, " ").trim(); return { price, priceNum: parsePriceNum(price) }; }
    m = s.match(FREE_RE);
    if (m) return { price: m[1], priceNum: 0 };
    return { price: "", priceNum: null };
  }
  // "(2) Marketplace – 3 Beds 2 Baths - House | Facebook" -> "3 Beds 2 Baths - House"
  function cleanTitle(s) {
    return String(s || "").replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*Facebook\s*$/i, "")
      .replace(/^(?:Facebook\s*[–\-]\s*)?Marketplace\s*[–\-]\s*/i, "").trim();
  }
  // "€1.200,50" -> 1200.5, "1,200" -> 1200, "1.200" -> 1200, "12.5" -> 12.5, "Free" -> 0
  function parsePriceNum(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (/^(free|gratis|kostenlos|ฟรี)\b/i.test(s)) return 0;
    const num = s.replace(/\/.*$|\bper\s.*$/i, "").replace(/[^\d.,]/g, "");
    if (!/\d/.test(num)) return null;
    const lastDot = num.lastIndexOf("."), lastComma = num.lastIndexOf(",");
    const seps = (num.match(/[.,]/g) || []).length;
    let intPart = num, frac = "";
    if (seps === 1) {
      const sep = Math.max(lastDot, lastComma), tail = num.slice(sep + 1);
      if (tail.length !== 3) { intPart = num.slice(0, sep); frac = tail; }
    } else if (seps > 1 && lastDot > -1 && lastComma > -1) {
      const dec = Math.max(lastDot, lastComma);
      intPart = num.slice(0, dec); frac = num.slice(dec + 1);
    }
    const v = parseFloat(intPart.replace(/[.,]/g, "") + (frac ? "." + frac : ""));
    return Number.isFinite(v) ? v : null;
  }
  function priceInRange(n, min, max) {
    if (min == null && max == null) return true;
    if (n == null) return false;
    if (min != null && n < min) return false;
    if (max != null && n > max) return false;
    return true;
  }
  // A rent written inside the description ("25,000 per month", "฿ 25000") — Thai sellers
  // often list at ฿0/฿1 with the real price only in the text.
  function descPriceNum(desc) {
    const m = String(desc || "").match(/(?:[฿$€£]\s?)(\d{1,3}(?:[,.]\d{3})+|\d{3,7})|(\d{1,3}(?:[,.]\d{3})+|\d{4,7})\s?(?:฿|baht|thb|บาท|€|£|kr|zł|(?:per\s+month|\/\s*mo(?:nth)?\b|a\s+month|monthly|\bpm\b))/i);
    return m ? parsePriceNum(m[1] || m[2]) : null;
  }

  function alertKey(a) {
    const f = (arr) => (arr || []).map(foldText).sort().join(",");
    return withNewestSort(a.url) + "|" + f(a.keywords) + "|" + f(a.exclude) + "|" + !!a.matchAll + "|" + !!a.searchTitles + "|" + !!a.wholeWord;
  }
  function clampInt(n, lo, hi, dflt) {
    n = parseInt(n, 10);
    if (!Number.isFinite(n)) n = dflt;
    return Math.max(lo, Math.min(hi, n));
  }
  function timeAgo(ts) {
    if (!ts) return "never";
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60); if (m < 60) return m + " min ago";
    const h = Math.round(m / 60); if (h < 48) return h + " h ago";
    return Math.round(h / 24) + " days ago";
  }
  function timeUntil(ts) {
    if (!ts) return "";
    const m = Math.round((ts - Date.now()) / 60000);
    if (m <= 0) return "any moment";
    if (m < 60) return "in " + m + " min";
    const h = Math.floor(m / 60);
    return "in " + h + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
  }
  function fmtDuration(ms) {
    if (ms == null) return "";
    const s = Math.round(ms / 1000);
    return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s";
  }
  const STATUS = {
    ok: { label: "OK", tone: "ok" },
    partial: { label: "Partial", tone: "warn" },
    empty: { label: "No listings found", tone: "warn" },
    login: { label: "Logged out", tone: "bad" },
    blocked: { label: "Blocked by Facebook", tone: "bad" },
    unavailable: { label: "Unavailable", tone: "warn" },
    "wrong-page": { label: "Redirected", tone: "warn" },
    error: { label: "Error", tone: "bad" },
    cancelled: { label: "Stopped", tone: "muted" },
    budget: { label: "Skipped (hourly budget)", tone: "warn" },
    paused: { label: "Paused", tone: "muted" },
  };

  g.MDS = {
    LIMITS, ITEM_RE, ITEM_LINK_SEL, STATUS, itemUrl, isItemUrl,
    escapeHtml, escapeRe, foldText, hasThai, dedupe,
    parseKeywords, formatKeywords, matchText, termTest,
    snippetAround, highlightSnippet,
    withNewestSort, isFeedUrl, bestImageIn,
    extractPrice, parsePriceNum, priceInRange, descPriceNum, cleanTitle,
    alertKey, clampInt, timeAgo, timeUntil, fmtDuration,
  };
})(globalThis);
