// Unit tests for shared.js — the helpers every context relies on (keyword parsing,
// matching, highlighting, feed detection, prices). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../shared.js";

const M = globalThis.MDS;

test("parseKeywords: commas, quoted phrases, exclusions", () => {
  assert.deepEqual(M.parseKeywords('sea view, "15,000", -agent, !rented,  , pool'),
    { include: ["sea view", "15,000", "pool"], exclude: ["agent", "rented"] });
  assert.deepEqual(M.parseKeywords('-"for sale", choengmon'), { include: ["choengmon"], exclude: ["for sale"] });
  assert.deepEqual(M.parseKeywords(""), { include: [], exclude: [] });
  assert.deepEqual(M.parseKeywords("a, a, A"), { include: ["a", "A"], exclude: [] });
});

test("formatKeywords round-trips through parseKeywords", () => {
  const s = M.formatKeywords(["sea view", "15,000"], ["agent"]);
  assert.equal(s, 'sea view, "15,000", -agent');
  assert.deepEqual(M.parseKeywords(s), { include: ["sea view", "15,000"], exclude: ["agent"] });
});

test("matchText: substring by default, whole words on request, Thai bypasses boundaries", () => {
  const text = { description: "Cosy studio near the carpool spot. Pet friendly.", title: "Studio for rent" };
  assert.equal(M.matchText(text, { include: ["pool"] }).matched, true);
  assert.equal(M.matchText(text, { include: ["pool"], wholeWord: true }).matched, false);
  assert.equal(M.matchText(text, { include: ["pet"], wholeWord: true }).matched, true);
  const thai = { description: "บ้านเช่าใกล้หาดเฉวง", title: "" };
  assert.equal(M.matchText(thai, { include: ["เฉวง"], wholeWord: true }).matched, true);
});

test("matchText: excludes, match-all, titles, diacritics and case folding", () => {
  const text = { description: "Villa in Choengmon, agent fee applies", title: "3 Beds 2 Baths - House" };
  assert.equal(M.matchText(text, { include: ["choengmon"] }).matched, true);
  const ex = M.matchText(text, { include: ["choengmon"], exclude: ["agent"] });
  assert.equal(ex.matched, false);
  assert.equal(ex.excludedBy, "agent");
  assert.equal(M.matchText(text, { include: ["choengmon", "pool"], matchAll: true }).matched, false);
  assert.equal(M.matchText(text, { include: ["house"] }).matched, false);
  const t = M.matchText(text, { include: ["house"], searchTitles: true });
  assert.equal(t.matched, true);
  assert.deepEqual(t.titleHits, ["house"]);
  assert.equal(M.matchText({ description: "Café near İstanbul", title: "" }, { include: ["cafe", "istanbul"], matchAll: true }).matched, true);
});

test("highlightSnippet escapes once and never marks inside entities", () => {
  const html = M.highlightSnippet("Fender amp & cab <used>", ["amp"]);
  assert.equal(html, "Fender <mark>amp</mark> &amp; cab &lt;used&gt;…");
  assert.equal(M.highlightSnippet("R&D lab", ["R&D"]), "<mark>R&amp;D</mark> lab…");
  assert.equal(M.highlightSnippet("plain", []), "plain…");
  assert.equal(M.highlightSnippet("", ["x"]), "");
});

test("snippetAround centres on the first hit", () => {
  const desc = "x".repeat(300) + " quiet area in Choengmon " + "y".repeat(100);
  const s = M.snippetAround(desc, ["choengmon"]);
  assert.ok(s.startsWith("…"));
  assert.ok(/Choengmon/.test(s));
  assert.equal(M.snippetAround("short text with pool", ["pool"]), "short text with pool");
});

test("isFeedUrl: feeds yes, item/account pages and other hosts no", () => {
  const yes = ["https://www.facebook.com/marketplace/", "https://www.facebook.com/marketplace/kohsamui/propertyrentals/",
    "https://www.facebook.com/marketplace/category/propertyrentals", "https://www.facebook.com/marketplace/search/?query=house",
    "https://www.facebook.com/marketplace/108424279189115/search?query=x"];
  const no = ["https://www.facebook.com/marketplace/item/123/", "https://www.facebook.com/marketplace/inbox/", "https://www.facebook.com/marketplace/you/selling",
    "https://www.facebook.com/marketplace/create/item", "https://blog.example/facebook.com/marketplace/search/?q=x", "http://www.facebook.com/marketplace/", "not a url", ""];
  for (const u of yes) assert.equal(M.isFeedUrl(u), true, u);
  for (const u of no) assert.equal(M.isFeedUrl(u), false, u);
});

test("withNewestSort sets the sort without dropping other filters", () => {
  const u = new URL(M.withNewestSort("https://www.facebook.com/marketplace/search/?query=house&minPrice=100&sortBy=price_ascend"));
  assert.equal(u.searchParams.get("sortBy"), "creation_time_descend");
  assert.equal(u.searchParams.get("minPrice"), "100");
  assert.equal(u.searchParams.getAll("sortBy").length, 1);
});

test("prices: many currencies, thousands vs decimals, free, per-period", () => {
  assert.deepEqual(M.extractPrice("฿15,000 / month\nDescription"), { price: "฿15,000 / month", priceNum: 15000 });
  assert.equal(M.extractPrice("1 200 zł").priceNum, 1200);
  assert.equal(M.extractPrice("€1.200,50").priceNum, 1200.5);
  assert.equal(M.extractPrice("CA$ 30").priceNum, 30);
  assert.equal(M.extractPrice("Free\nsofa").priceNum, 0);
  assert.equal(M.extractPrice("Free sofa").price, "");      // "Free" inside a sentence is not a price
  assert.equal(M.extractPrice("25 000 THB").priceNum, 25000);
  assert.equal(M.extractPrice("no price here").price, "");
  assert.equal(M.parsePriceNum("12.5"), 12.5);
  assert.equal(M.parsePriceNum("1,200,000"), 1200000);
  assert.equal(M.descPriceNum("Rent is 25,000 per month, deposit 2 months"), 25000);
  assert.equal(M.descPriceNum("Nice house"), null);
  assert.equal(M.priceInRange(25000, 20000, 30000), true);
  assert.equal(M.priceInRange(null, 20000, null), false);
  assert.equal(M.priceInRange(null, null, null), true);
});

test("prices: the sidebar's 'Free Stuff' is not a price, a lone 'Free' line is", () => {
  const page = "Marketplace\nFree Stuff\nProperty Rentals\n3 Beds 2 Baths - House\n฿15,000 / month\nListed 2 days ago";
  assert.deepEqual(M.extractPrice(page), { price: "฿15,000 / month", priceNum: 15000 });
  assert.deepEqual(M.extractPrice("Free Stuff\nRoom for rent\nFree\nListed today"), { price: "Free", priceNum: 0 });
  assert.equal(M.extractPrice("Free Stuff\nRoom for rent").price, "");
  assert.equal(M.extractPrice("Villa\nTHB 20,000 / month").priceNum, 20000);
  assert.equal(M.extractPrice("Pet-free home, no price").price, "");
});

test("cleanTitle strips notification counts, the Marketplace prefix and the Facebook suffix", () => {
  assert.equal(M.cleanTitle("(2) Marketplace – 3 Beds 2 Baths - House | Facebook"), "3 Beds 2 Baths - House");
  assert.equal(M.cleanTitle("Marketplace - Villa with pool | Facebook"), "Villa with pool");
  assert.equal(M.cleanTitle("Plain title"), "Plain title");
  assert.equal(M.cleanTitle(""), "");
});

test("alertKey ignores order/case of terms but not options", () => {
  const a = { url: "https://www.facebook.com/marketplace/search/?query=x", keywords: ["Pool", "sea view"], exclude: [] };
  const b = { url: "https://www.facebook.com/marketplace/search/?query=x&sortBy=creation_time_descend", keywords: ["sea view", "pool"], exclude: [] };
  assert.equal(M.alertKey(a), M.alertKey(b));
  assert.notEqual(M.alertKey(a), M.alertKey({ ...a, matchAll: true }));
});

test("clampInt falls back to the default on garbage", () => {
  assert.equal(M.clampInt("abc", 1, 200, 40), 40);
  assert.equal(M.clampInt("9999", 1, 200, 40), 200);
  assert.equal(M.clampInt("0", 1, 200, 40), 1);
});
