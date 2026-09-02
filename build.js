// ShortwaveHQ static page generator
// Runs on Netlify at deploy time: reads the SCH database from data/schedule.json
// (written by schedule_update.py / GitHub Actions) and generates individual
// landing pages for every station, frequency, and band, plus a sitemap.xml
// and robots.txt. No dependencies — Node built-ins only.
//
// Netlify runs this via netlify.toml:  command = "node build.js", publish = "dist"

var fs = require("fs");
var path = require("path");

var SITE = "https://hqshortwaveradio.com";

// ── SEO: Placeholder station names to skip entirely ──────────────
var STATION_BLACKLIST = [
  "filler music","various stations","various","test","unknown",
  "music filler","filler","interval signal","unid","unidentified"
];
function isPlaceholder(name){
  return STATION_BLACKLIST.indexOf(name.toLowerCase().trim()) >= 0;
}

// ── SEO: Minimum schedule entries to index ───────────────────────
var MIN_STATION_ENTRIES = 3;  // station pages with fewer entries get noindex
var MIN_FREQ_ENTRIES = 2;     // frequency pages with fewer stations get noindex
var OUT = path.join(__dirname, "dist");
var TODAY = new Date().toISOString().slice(0, 10);

// ── 1. Load SCH from data/schedule.json (full EIBI dataset) ─────
var schedPath = path.join(__dirname, "data", "schedule.json");
var SCH;
if (fs.existsSync(schedPath)) {
  try {
    var schedData = JSON.parse(fs.readFileSync(schedPath, "utf8"));
    SCH = schedData.sch || schedData;
    console.log("Loaded " + SCH.length + " schedule rows from data/schedule.json (updated: " + (schedData.updated_utc || "unknown") + ")");
  } catch(e) {
    console.error("BUILD FAILED: could not parse data/schedule.json: " + e.message);
    process.exit(1);
  }
} else {
  // Fallback: read from index.html for local dev without the data file
  console.log("WARNING: data/schedule.json not found, falling back to index.html SCH array");
  var html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  var start = html.indexOf("var SCH=[");
  if (start < 0) { console.error("BUILD FAILED: no data/schedule.json and no SCH in index.html"); process.exit(1); }
  var end = html.indexOf("\n];", start);
  var arrText = html.slice(start + "var SCH=".length, end + 2);
  try { SCH = new Function("return " + arrText + ";")(); }
  catch (e) { console.error("BUILD FAILED: could not parse SCH: " + e.message); process.exit(1); }
  console.log("Parsed " + SCH.length + " schedule rows from index.html (fallback)");
}

// Re-read index.html for the template (separate from SCH load above)
var html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

// ── 2. Helpers ───────────────────────────────────────────────────
function slug(s) {
  return String(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function pad(n) { return (n < 10 ? "0" : "") + n; }
function fmtTime(m) {
  if (m >= 1440) return "24h";
  return pad(Math.floor(m / 60) % 24) + ":" + pad(m % 60);
}
function fmtSched(r) {
  if (r.s === 0 && r.e >= 1440) return "24 hours continuous";
  return fmtTime(r.s) + "\u2013" + fmtTime(r.e) + " UTC";
}
function kHz(freq) { return Math.round(parseFloat(freq) * 1000); }
function uniq(arr) {
  var seen = {}, out = [];
  for (var i = 0; i < arr.length; i++) { var v = arr[i]; if (v && !seen[v]) { seen[v] = 1; out.push(v); } }
  return out;
}
function listWords(arr, max) {
  var u = uniq(arr).slice(0, max || 6);
  return u.join(", ");
}
var BANDS = [
  { name: "120 Meter Band", lo: 2.3, hi: 2.495 },
  { name: "90 Meter Band", lo: 3.2, hi: 3.4 },
  { name: "75 Meter Band", lo: 3.9, hi: 4.0 },
  { name: "60 Meter Band", lo: 4.7, hi: 5.1 },
  { name: "49 Meter Band", lo: 5.8, hi: 6.3 },
  { name: "41 Meter Band", lo: 7.1, hi: 7.6 },
  { name: "31 Meter Band", lo: 9.3, hi: 10.0 },
  { name: "25 Meter Band", lo: 11.5, hi: 12.2 },
  { name: "22 Meter Band", lo: 13.5, hi: 13.9 },
  { name: "19 Meter Band", lo: 15.0, hi: 15.9 },
  { name: "16 Meter Band", lo: 17.4, hi: 18.0 },
  { name: "13 Meter Band", lo: 21.4, hi: 21.9 },
  { name: "11 Meter Band", lo: 25.6, hi: 26.2 }
];
function bandFor(freqMHz) {
  for (var i = 0; i < BANDS.length; i++) { if (freqMHz >= BANDS[i].lo && freqMHz <= BANDS[i].hi) return BANDS[i]; }
  return null;
}

// ── 3. Group data ────────────────────────────────────────────────
var byStation = {};   // stn -> rows[]
var byFreq = {};      // "9400" (kHz string) -> rows[]
for (var i = 0; i < SCH.length; i++) {
  var r = SCH[i];
  if (!byStation[r.stn]) byStation[r.stn] = [];
  byStation[r.stn].push(r);
  var k = String(kHz(r.freq));
  if (!byFreq[k]) byFreq[k] = [];
  byFreq[k].push(r);
}
var stationNames = Object.keys(byStation).sort();
var freqKeys = Object.keys(byFreq).map(Number).sort(function (a, b) { return a - b; });

// slug maps (collision-safe)
var stationSlug = {}, usedSlugs = {};
for (var s = 0; s < stationNames.length; s++) {
  var base = slug(stationNames[s]) || "station";
  var sl = base, n = 2;
  while (usedSlugs[sl]) { sl = base + "-" + n; n++; }
  usedSlugs[sl] = 1;
  stationSlug[stationNames[s]] = sl;
}
var bandSlug = {};
for (var b = 0; b < BANDS.length; b++) bandSlug[BANDS[b].name] = slug(BANDS[b].name);

// ── 4. Page shell ────────────────────────────────────────────────
function shell(opts) {
  // opts: title, desc, canonical, h1, kicker, bodyHtml, breadcrumbs [[name,url],...]
  var bc = { "@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [] };
  for (var i = 0; i < opts.breadcrumbs.length; i++) {
    bc.itemListElement.push({ "@type": "ListItem", "position": i + 1, "name": opts.breadcrumbs[i][0], "item": SITE + opts.breadcrumbs[i][1] });
  }
  return "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>" + esc(opts.title) + "</title>\n<meta name=\"description\" content=\"" + esc(opts.desc) + "\">\n<link rel=\"canonical\" href=\"" + SITE + opts.canonical + "\">\n<link rel=\"alternate\" hreflang=\"en\" href=\"" + SITE + opts.canonical + "\">\n<link rel=\"alternate\" hreflang=\"x-default\" href=\"" + SITE + opts.canonical + "\">\n<meta name=\"robots\" content=\"" + (opts.noindex ? "noindex,follow" : "index,follow") + "\">\n<meta property=\"og:title\" content=\"" + esc(opts.title) + "\">\n<meta property=\"og:description\" content=\"" + esc(opts.desc) + "\">\n<meta property=\"og:url\" content=\"" + SITE + opts.canonical + "\">\n<meta property=\"og:type\" content=\"website\">\n<meta property=\"og:site_name\" content=\"ShortwaveHQ\">\n<meta property=\"og:image\" content=\"" + SITE + "/og-image.png\">\n<script type=\"application/ld+json\">" + JSON.stringify(bc) + "</script>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Syne:wght@800;900&family=IBM+Plex+Mono:wght@400;600&family=Libre+Baskerville:ital@0;1&display=swap\" rel=\"stylesheet\">\n<style>\n*{box-sizing:border-box;margin:0;padding:0}\nbody{background:#f5f0e8;color:#0a0b0e;font-family:\"Libre Baskerville\",Georgia,serif;font-size:1.02rem;line-height:1.65}\na{color:#c0392b}\n.mast{background:#0a0b0e;border-bottom:3px solid #c0392b;padding:.85rem 1.2rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem}\n.bname{font-family:Syne,sans-serif;font-weight:900;font-size:1.15rem;color:#fff;letter-spacing:-.04em;text-decoration:none}\n.bname em{color:#e74c3c;font-style:normal}\n.mlink{font-family:\"IBM Plex Mono\",monospace;font-size:.62rem;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.75);text-decoration:none}\n.wrap{max-width:960px;margin:0 auto;padding:1.6rem 1.2rem 3.5rem}\n.kick{font-family:\"IBM Plex Mono\",monospace;font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;color:#9c8e81;margin-bottom:.4rem}\nh1{font-family:Syne,sans-serif;font-weight:800;font-size:1.7rem;letter-spacing:-.025em;line-height:1.15;margin-bottom:.9rem}\nh2{font-family:Syne,sans-serif;font-weight:800;font-size:1.12rem;letter-spacing:-.02em;margin:1.8rem 0 .7rem}\np{margin-bottom:.9rem}\n.lede{font-size:1.05rem}\n.cta{display:inline-block;font-family:\"IBM Plex Mono\",monospace;font-size:.72rem;font-weight:600;letter-spacing:.05em;background:#c0392b;color:#fff;text-decoration:none;padding:11px 18px;border-radius:4px;margin:.3rem .5rem .3rem 0}\n.cta.o{background:transparent;color:#0a0b0e;border:1px solid #c8c0b0}\ntable{width:100%;border-collapse:collapse;font-size:.82rem;margin:.6rem 0 1rem;background:#fff;border:1px solid #c8c0b0}\nth{font-family:\"IBM Plex Mono\",monospace;font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;text-align:left;padding:8px 10px;background:#ece7db;border-bottom:1px solid #c8c0b0;color:#6b5f52}\ntd{padding:8px 10px;border-bottom:1px solid #e2dbd0;vertical-align:top}\ntd a{text-decoration:none;border-bottom:1px solid #e0c4bf}\n.tags a{display:inline-block;font-family:\"IBM Plex Mono\",monospace;font-size:.66rem;border:1px solid #c8c0b0;border-radius:20px;padding:4px 12px;margin:0 6px 8px 0;text-decoration:none;color:#6b5f52;background:#fff}\n.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;margin:.6rem 0 1rem}\n.grid a{display:block;background:#fff;border:1px solid #c8c0b0;border-radius:4px;padding:.7rem .8rem;text-decoration:none;color:#0a0b0e;font-size:.82rem}\n.grid a span{display:block;font-family:\"IBM Plex Mono\",monospace;font-size:.58rem;color:#9c8e81;margin-top:2px}\n.crumbs{font-family:\"IBM Plex Mono\",monospace;font-size:.6rem;color:#9c8e81;margin-bottom:1.1rem}\n.crumbs a{color:#6b5f52;text-decoration:none}\nfooter{background:#0a0b0e;color:rgba(255,255,255,.6);padding:1.6rem 1.2rem;font-family:\"IBM Plex Mono\",monospace;font-size:.62rem;line-height:1.9}\nfooter a{color:rgba(255,255,255,.85)}\n</style>\n</head>\n<body>\n<header class=\"mast\"><a class=\"bname\" href=\"/\">Shortwave<em>HQ</em></a><nav><a class=\"mlink\" href=\"/\">Live Search</a> &nbsp; <a class=\"mlink\" href=\"/listen-online/\">Listen Online</a> &nbsp; <a class=\"mlink\" href=\"/articles/\">Articles</a> &nbsp; <a class=\"mlink\" href=\"/stations/\">Stations</a> &nbsp; <a class=\"mlink\" href=\"/frequency/\">Frequencies</a> &nbsp; <a class=\"mlink\" href=\"/bands/\">Bands</a></nav></header>\n<main class=\"wrap\">\n<div class=\"crumbs\">" + opts.breadcrumbs.map(function (c, ix) { return ix === opts.breadcrumbs.length - 1 ? esc(c[0]) : "<a href=\"" + c[1] + "\">" + esc(c[0]) + "</a>"; }).join(" \u203a ") + "</div>\n<div class=\"kick\">" + esc(opts.kicker) + "</div>\n<h1>" + opts.h1 + "</h1>\n" + opts.bodyHtml + "\n</main>\n<footer><div style=\"max-width:960px;margin:0 auto\">\u00a9 2026 ShortwaveHQ \u00b7 <a href=\"/\">hqshortwaveradio.com</a> \u00b7 Live shortwave schedules, frequencies &amp; band conditions \u00b7 EIBI A-26 data \u00b7 Contact: <a href=\"mailto:Hqshortwaveradio@gmail.com\">Hqshortwaveradio@gmail.com</a><br>Independent hobbyist project \u2014 schedules provided as-is; verify against official station sources. As an Amazon Associate, ShortwaveHQ earns from qualifying purchases at no extra cost to you.</div></footer>\n</body>\n</html>";
}

function write(rel, content) {
  var full = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ── 5. Reset dist and copy repo root files through ───────────────
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
var rootFiles = fs.readdirSync(__dirname);
for (var rf = 0; rf < rootFiles.length; rf++) {
  var f = rootFiles[rf];
  if (f === "dist" || f === "build.js" || f === "netlify.toml" || f[0] === ".") continue;
  var src = path.join(__dirname, f);
  if (fs.statSync(src).isDirectory()) fs.cpSync(src, path.join(OUT, f), { recursive: true });
  else fs.copyFileSync(src, path.join(OUT, f));
}
console.log("Copied site root files into dist/");

// ── 5b. Stamp dist/index.html with a content fingerprint ──────────
// Hash is computed from the SOURCE index.html (before this stamp is
// injected), so it only changes when the actual page content changes —
// not on every automated daily rebuild. Lets you confirm at a glance
// (bottom of the site footer) whether a real edit actually went live,
// instead of just whether *a* deploy happened.
var crypto = require("crypto");
var indexPath = path.join(OUT, "index.html");
if (fs.existsSync(indexPath)) {
  var indexSrc = fs.readFileSync(indexPath, "utf8");
  var contentHash = crypto.createHash("sha256").update(indexSrc).digest("hex").slice(0, 8);
  var stampedAt = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  var stamp = contentHash + " · " + stampedAt;
  var stamped = indexSrc.split("BUILD_STAMP_PLACEHOLDER").join(stamp);
  fs.writeFileSync(indexPath, stamped);
  console.log("Stamped dist/index.html with build fingerprint " + stamp);
}

// ── 5c. Real physical /reviews/ page ───────────────────────────────
// The Netlify _redirects / netlify.toml [[redirects]] rules were not
// reliably taking effect for this path, so instead of depending on
// Netlify's redirect engine at all, write an actual file at
// dist/reviews/index.html. Real files are served directly with no
// redirect-rule matching required — this can't silently fail to route.
// It does an instant client-side redirect into the SPA's Reviews page,
// with a plain-link/meta-refresh fallback for anyone without JS.
var reviewsDir = path.join(OUT, "reviews");
fs.mkdirSync(reviewsDir, { recursive: true });
fs.writeFileSync(path.join(reviewsDir, "index.html"),
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
  '<meta http-equiv="refresh" content="0;url=/?page=reviews">' +
  '<link rel="canonical" href="https://hqshortwaveradio.com/?page=reviews">' +
  '<title>Shortwave Radio Reviews \u2014 ShortwaveHQ</title>' +
  '<script>location.replace("/?page=reviews");</script>' +
  '</head><body>' +
  '<p>Loading radio reviews\u2026 if you are not redirected, ' +
  '<a href="/?page=reviews">click here</a>.</p>' +
  '</body></html>'
);
console.log("Wrote dist/reviews/index.html (real file, redirect-engine-independent)");

var urls = ["/"];

// ── 5d. Individual review pages ────────────────────────────────
// Parses the REVIEWS array straight out of index.html (same pattern
// as the SCH fallback parse above) and writes a real static, crawlable
// page per Published review at /reviews/<slug>/. Coming Soon reviews
// are skipped (nothing to say yet, would be thin/duplicate content).
var reviewSlugMap = {};
var revStart = html.indexOf("var REVIEWS=[");
if (revStart >= 0) {
  var revEnd = html.indexOf("\n];", revStart);
  var revText = html.slice(revStart + "var REVIEWS=".length, revEnd + 2);
  var REVIEWS = [];
  try { REVIEWS = new Function("return " + revText + ";")(); }
  catch (e) { console.error("WARNING: could not parse REVIEWS array, skipping review pages: " + e.message); }

  var usedReviewSlugs = {};
  for (var rv = 0; rv < REVIEWS.length; rv++) {
    var rev = REVIEWS[rv];
    if (rev.status !== "Published") continue;
    var rbase = slug(rev.n) || "review";
    var rslug = rbase, rn2 = 2;
    while (usedReviewSlugs[rslug]) { rslug = rbase + "-" + rn2; rn2++; }
    usedReviewSlugs[rslug] = 1;
    reviewSlugMap[rev.n] = rslug;

    var rTitle = rev.n + " Review \u2014 Hands-On Testing & Verdict | ShortwaveHQ";
    var rDesc = (rev.d || "").slice(0, 155);

    var specsHtml = "";
    if (rev.specs && rev.specs.length) {
      specsHtml = "<h2>Specifications</h2><table><tbody>" +
        rev.specs.map(function (sp) { return "<tr><td><strong>" + esc(sp[0]) + "</strong></td><td>" + esc(sp[1]) + "</td></tr>"; }).join("") +
        "</tbody></table>";
    }
    var prosHtml = rev.pros && rev.pros.length ? "<h2>Pros</h2><ul>" + rev.pros.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul>" : "";
    var consHtml = rev.cons && rev.cons.length ? "<h2>Cons</h2><ul>" + rev.cons.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul>" : "";
    var verdictHtml = rev.verdict ? "<h2>Verdict</h2>" + rev.verdict.split("\n\n").map(function (p) { return "<p>" + esc(p) + "</p>"; }).join("") : "";
    var buyUrl = rev.buyUrl || rev.amazonUrl;
    var buyLabel = rev.buyLabel || "Check Price on Amazon";
    var buyHtml = buyUrl ? "<p><a class=\"cta\" href=\"" + esc(buyUrl) + "\" rel=\"nofollow sponsored noopener\" target=\"_blank\">" + esc(buyLabel) + "</a></p>" : "";
    var imgHtml = rev.thumb ? "<img src=\"/" + esc(rev.thumb) + "\" alt=\"" + esc(rev.n) + "\" style=\"max-width:100%;border-radius:6px;margin-bottom:1rem\">" : "";

    var ratingMatch = /(\d(\.\d)?)\s*\/\s*5/.exec(rev.verdict || "");
    var ld = {
      "@context": "https://schema.org", "@type": "Review",
      "itemReviewed": { "@type": "Product", "name": rev.n, "category": rev.cat || undefined, "image": rev.thumb ? SITE + "/" + rev.thumb : undefined },
      "author": { "@type": "Person", "name": "Michael Smith (KM7FMJ)" },
      "datePublished": rev.date || undefined,
      "reviewBody": (rev.verdict || rev.d || "").slice(0, 500)
    };
    if (ratingMatch) ld.reviewRating = { "@type": "Rating", "ratingValue": ratingMatch[1], "bestRating": "5" };

    var rBody = "<script type=\"application/ld+json\">" + JSON.stringify(ld) + "</script>"
      + imgHtml
      + "<p class=\"lede\">" + esc(rev.d || "") + "</p>"
      + buyHtml + specsHtml + prosHtml + consHtml + verdictHtml
      + (rev.src ? "<p style=\"font-size:.78rem;color:#9c8e81\">" + esc(rev.src) + "</p>" : "")
      + "<h2>More Reviews</h2><p><a class=\"cta o\" href=\"/?page=reviews\">See all radio reviews \u2192</a></p>";

    write("reviews/" + rslug + "/index.html", shell({
      title: rTitle, desc: rDesc, canonical: "/reviews/" + rslug + "/",
      kicker: "Review \u00b7 " + (rev.cat || "Shortwave Gear") + (rev.date ? " \u00b7 " + rev.date : ""),
      h1: esc(rev.n) + " Review",
      bodyHtml: rBody,
      breadcrumbs: [["Home", "/"], ["Reviews", "/reviews/"], [rev.n, "/reviews/" + rslug + "/"]]
    }));
    urls.push("/reviews/" + rslug + "/");
  }
  console.log("Generated " + Object.keys(usedReviewSlugs).length + " individual review pages");
} else {
  console.log("WARNING: REVIEWS array not found in index.html, skipping individual review pages");
}

// ── 6. Station pages ─────────────────────────────────────────────
for (var sn = 0; sn < stationNames.length; sn++) {
  var name = stationNames[sn];
  // Skip placeholder/junk station names entirely
  if(isPlaceholder(name)) continue;
  var rows = byStation[name].slice().sort(function (a, b) { return parseFloat(a.freq) - parseFloat(b.freq); });
  var sl = stationSlug[name];
  var thinStation = rows.length < MIN_STATION_ENTRIES;
  var langs = listWords(rows.map(function (r) { return r.lang; }), 5);
  var tgts = listWords(rows.map(function (r) { return r.tgt; }), 5);
  var sites = listWords(rows.map(function (r) { return r.site; }), 4);
  var freqs = uniq(rows.map(function (r) { return String(kHz(r.freq)); }));
  var tgtList = uniq(rows.map(function(r){ return r.tgt; }).filter(Boolean));
  var regionStr = tgtList.length ? ", beamed to " + tgtList.slice(0,4).join(", ") : "";
  var title = "Listen to " + name + " on Shortwave \u2014 Live Frequencies & 2026 Schedule | ShortwaveHQ";
  var desc = name + " shortwave schedule 2026: " + freqs.length + " frequenc" + (freqs.length > 1 ? "ies" : "y") + (langs ? " in " + langs : "") + regionStr + ". Check if it\u2019s on the air right now and listen online free.";
  var tbl = "<table><thead><tr><th>Frequency</th><th>Time (UTC)</th><th>Language</th><th>Target</th><th>Transmitter Site</th><th>Power</th></tr></thead><tbody>";
  for (var ri = 0; ri < rows.length; ri++) {
    var r2 = rows[ri];
    var bd = bandFor(parseFloat(r2.freq));
    tbl += "<tr><td><a href=\"/frequency/" + kHz(r2.freq) + "-khz/\">" + kHz(r2.freq) + " kHz</a>" + (bd ? " <span style=\"color:#9c8e81;font-size:.7rem\">(" + esc(bd.name.replace(" Band", "")) + ")</span>" : "") + "</td><td>" + fmtSched(r2) + "</td><td>" + esc(r2.lang || "") + "</td><td>" + esc(r2.tgt || "") + "</td><td>" + esc(r2.site || "\u2014") + "</td><td>" + (r2.kw ? r2.kw + " kW" : "\u2014") + "</td></tr>";
  }
  tbl += "</tbody></table>";
  var body = "<p class=\"lede\">All active shortwave transmissions for <strong>" + esc(name) + "</strong> in the 2026 EIBI A-26 schedule season" + (sites ? ", transmitting from " + esc(sites) : "") + ". Times are UTC. Frequencies link to full frequency pages showing everything else on that channel.</p>"
    + "<p><a class=\"cta\" href=\"/?q=" + encodeURIComponent(name) + "\">\u25cf Is it on the air right now? \u2192 Live status</a><a class=\"cta o\" href=\"http://websdr.ewi.utwente.nl:8901/?tune=" + (kHz(rows[0].freq)/1000).toFixed(3) + "am\" rel=\"nofollow\">Listen online via WebSDR</a></p>"
    + "<h2>" + esc(name) + " \u2014 Full 2026 Schedule</h2>" + tbl
    + "<h2>Browse More</h2><div class=\"tags\"><a href=\"/stations/\">All Stations</a><a href=\"/frequency/\">All Frequencies</a><a href=\"/bands/\">Shortwave Bands</a><a href=\"/\">Live Search &amp; Band Conditions</a></div>"
    + "<p><a class=\"cta o\" href=\"/?page=equipment\">\uD83D\uDED2 New to " + esc(name) + "? See the radios we recommend to hear it clearly \u2192</a></p>";
  write("stations/" + sl + "/index.html", shell({
    title: title, desc: desc, canonical: "/stations/" + sl + "/", kicker: "Station Profile \u00b7 EIBI A-26 \u00b7 2026",
    h1: "Listen to <span style=\"color:#c0392b\">" + esc(name) + "</span> on Shortwave", bodyHtml: body,
    breadcrumbs: [["Home", "/"], ["Stations", "/stations/"], [name, "/stations/" + sl + "/"]],
    noindex: thinStation
  }));
  if(!thinStation) urls.push("/stations/" + sl + "/");
}
console.log("Generated " + stationNames.length + " station pages");

// ── 7. Frequency pages ───────────────────────────────────────────
for (var fk = 0; fk < freqKeys.length; fk++) {
  var khz = freqKeys[fk];
  var rows2 = byFreq[String(khz)].slice().sort(function (a, b) { return a.s - b.s; });
  var thinFreq = rows2.length < MIN_FREQ_ENTRIES;
  var mhz = khz / 1000;
  var bd2 = bandFor(mhz);
  var stns = uniq(rows2.map(function (r) { return r.stn; }));
  var tgts2 = uniq(rows2.map(function(r){ return r.tgt; }).filter(Boolean));
  var regionStr2 = tgts2.length ? " Transmissions target " + tgts2.slice(0,4).join(", ") + "." : "";
  var title2 = "What\u2019s on " + khz + " kHz Shortwave? Live Schedule & Stations (2026) | ShortwaveHQ";
  var desc2 = khz + " kHz shortwave: " + stns.slice(0, 3).join(", ") + (stns.length > 3 ? " and " + (stns.length - 3) + " more" : "") + " are scheduled on this frequency in 2026." + regionStr2 + " Full UTC schedule" + (bd2 ? " \u2014 " + bd2.name : "") + ". See what\u2019s on right now.";
  var tbl2 = "<table><thead><tr><th>Station</th><th>Time (UTC)</th><th>Language</th><th>Target</th><th>Site</th><th>Power</th></tr></thead><tbody>";
  for (var ri2 = 0; ri2 < rows2.length; ri2++) {
    var r3 = rows2[ri2];
    tbl2 += "<tr><td><a href=\"/stations/" + stationSlug[r3.stn] + "/\">" + esc(r3.stn) + "</a></td><td>" + fmtSched(r3) + "</td><td>" + esc(r3.lang || "") + "</td><td>" + esc(r3.tgt || "") + "</td><td>" + esc(r3.site || "\u2014") + "</td><td>" + (r3.kw ? r3.kw + " kW" : "\u2014") + "</td></tr>";
  }
  tbl2 += "</tbody></table>";
  var prev = fk > 0 ? freqKeys[fk - 1] : null;
  var next = fk < freqKeys.length - 1 ? freqKeys[fk + 1] : null;
  var nav = "<div class=\"tags\">" + (prev ? "<a href=\"/frequency/" + prev + "-khz/\">\u2190 " + prev + " kHz</a>" : "") + (bd2 ? "<a href=\"/bands/" + bandSlug[bd2.name] + "/\">" + esc(bd2.name) + "</a>" : "") + (next ? "<a href=\"/frequency/" + next + "-khz/\">" + next + " kHz \u2192</a>" : "") + "</div>";
  var body2 = "<p class=\"lede\"><strong>" + khz + " kHz</strong> (" + mhz.toFixed(3) + " MHz)" + (bd2 ? " sits in the <a href=\"/bands/" + bandSlug[bd2.name] + "/\">" + esc(bd2.name.toLowerCase()) + "</a>" : "") + ". In the 2026 EIBI A-26 season this channel carries " + rows2.length + " scheduled transmission" + (rows2.length > 1 ? "s" : "") + " from " + stns.length + " station" + (stns.length > 1 ? "s" : "") + ". All times UTC.</p>"
    + "<p><a class=\"cta\" href=\"/?q=" + khz + "\">\u25cf What\u2019s on " + khz + " kHz right now? \u2192 Live status</a><a class=\"cta o\" href=\"http://websdr.ewi.utwente.nl:8901/?tune=" + mhz.toFixed(3) + "am\" rel=\"nofollow\">Tune it live on WebSDR</a></p>"
    + "<h2>2026 Schedule for " + khz + " kHz</h2>" + tbl2
    + "<h2>Nearby Frequencies</h2>" + nav
    + "<p><a class=\"cta o\" href=\"/?page=equipment\">\uD83D\uDED2 Hearing " + khz + " kHz needs the right radio \u2014 see our top picks \u2192</a></p>";
  write("frequency/" + khz + "-khz/index.html", shell({
    title: title2, desc: desc2, canonical: "/frequency/" + khz + "-khz/", kicker: "Live Shortwave Schedule \u00b7 " + (bd2 ? bd2.name + " \u00b7 " : "") + mhz.toFixed(3) + " MHz",
    noindex: thinFreq,
    h1: khz + " kHz <span style=\"color:#c0392b\">Shortwave</span>", bodyHtml: body2,
    breadcrumbs: [["Home", "/"], ["Frequencies", "/frequency/"], [khz + " kHz", "/frequency/" + khz + "-khz/"]]
  }));
  if(!thinFreq) urls.push("/frequency/" + khz + "-khz/");
}
console.log("Generated " + freqKeys.length + " frequency pages");

// ── 8. Band pages ────────────────────────────────────────────────
var bandsBuilt = 0;
for (var bb = 0; bb < BANDS.length; bb++) {
  var band = BANDS[bb];
  var bandFreqs = freqKeys.filter(function (k) { var m = k / 1000; return m >= band.lo && m <= band.hi; });
  if (!bandFreqs.length) continue;
  var bandRows = [];
  for (var bf = 0; bf < bandFreqs.length; bf++) bandRows = bandRows.concat(byFreq[String(bandFreqs[bf])]);
  var bStns = uniq(bandRows.map(function (r) { return r.stn; }));
  var bsl = bandSlug[band.name];
  var title3 = band.name + " Shortwave (" + band.lo + "\u2013" + band.hi + " MHz) \u2014 Stations & Frequencies 2026 | ShortwaveHQ";
  var desc3 = "Every station on the " + band.name.toLowerCase() + " (" + band.lo + "\u2013" + band.hi + " MHz) in 2026: " + bandFreqs.length + " active frequencies, " + bStns.length + " stations including " + bStns.slice(0, 3).join(", ") + ". Schedules, times, and live listening links.";
  var g = "<div class=\"grid\">";
  for (var bg = 0; bg < bandFreqs.length; bg++) {
    var k2 = bandFreqs[bg];
    var st2 = uniq(byFreq[String(k2)].map(function (r) { return r.stn; }));
    g += "<a href=\"/frequency/" + k2 + "-khz/\"><strong>" + k2 + " kHz</strong><span>" + esc(st2.slice(0, 2).join(" \u00b7 ")) + (st2.length > 2 ? " +" + (st2.length - 2) : "") + "</span></a>";
  }
  g += "</div>";
  var hint = band.name.indexOf("49") === 0 || band.name.indexOf("41") === 0 || band.name.indexOf("31") === 0 ? "This band performs best in the evening and overnight hours." : (band.name.indexOf("19") === 0 || band.name.indexOf("16") === 0 || band.name.indexOf("13") === 0 ? "This band performs best in daylight, especially with solar flux above 130." : "Propagation on this band varies with time of day and solar conditions.");
  var body3 = "<p class=\"lede\">The <strong>" + esc(band.name.toLowerCase()) + "</strong> covers " + band.lo + " to " + band.hi + " MHz. In the 2026 season it carries <strong>" + bandFreqs.length + " active frequencies</strong> from " + bStns.length + " stations. " + hint + "</p>"
    + "<p><a class=\"cta\" href=\"/\">\u25cf Check live band conditions \u2192</a></p>"
    + "<h2>Active Frequencies on the " + esc(band.name) + "</h2>" + g
    + "<h2>Other Bands</h2><div class=\"tags\">" + BANDS.filter(function (x) { return x.name !== band.name; }).map(function (x) { return "<a href=\"/bands/" + bandSlug[x.name] + "/\">" + esc(x.name) + "</a>"; }).join("") + "</div>"
    + "<p><a class=\"cta o\" href=\"/?page=equipment\">\uD83D\uDED2 Best radios for the " + esc(band.name) + " \u2192</a></p>";
  write("bands/" + bsl + "/index.html", shell({
    title: title3, desc: desc3, canonical: "/bands/" + bsl + "/", kicker: "Band Guide \u00b7 " + band.lo + "\u2013" + band.hi + " MHz",
    h1: esc(band.name) + " <span style=\"color:#c0392b\">Guide</span>", bodyHtml: body3,
    breadcrumbs: [["Home", "/"], ["Bands", "/bands/"], [band.name, "/bands/" + bsl + "/"]]
  }));
  urls.push("/bands/" + bsl + "/");
  bandsBuilt++;
}
console.log("Generated " + bandsBuilt + " band pages");

// ── Listen Online / On-Air Now landing page ─────────────────────
var loBody = "<p class=\"lede\">Want to listen to shortwave radio online right now, without owning a receiver? You have two options: a live web-based SDR you tune yourself, or our live database showing exactly which stations are broadcasting on-air at this moment.</p>"
  + "<h2>Option 1: Listen Live via WebSDR</h2><p>A WebSDR is a real shortwave receiver connected to the internet that anyone can tune remotely, free, in your browser. No account, no software install. <a class=\"cta\" href=\"http://websdr.ewi.utwente.nl:8901/\" target=\"_blank\" rel=\"noopener\">Open WebSDR &amp; Listen Now</a></p>"
  + "<h2>Option 2: See What's On Air Right Now</h2><p>ShortwaveHQ tracks the full 2026 EIBI broadcast schedule and shows you, in real time, which stations are transmitting on which frequency at this exact moment \u2014 so you know what to tune to before you start listening.</p><p><a class=\"cta\" href=\"/\">Open Live Band Conditions &amp; On-Air Tracker</a></p>"
  + "<h2>How to Listen to International Broadcasts</h2><p>International shortwave stations \u2014 BBC World Service, Radio Romania International, NHK World Japan, and dozens of others \u2014 broadcast on published schedules in UTC (Coordinated Universal Time), not your local time zone. That's the single biggest thing to get right before you start: find a station's scheduled hours, convert UTC to your local time, and tune a few minutes early since signals can take a moment to settle in.</p>"
  + "<p>If you own a physical receiver, a basic portable with SSB (single sideband) capability, like the ones we've reviewed on the <a href=\"/\">homepage</a>, is enough to pull in most international broadcasters clearly. Reception quality depends heavily on time of day, the band you're tuned to, and your antenna \u2014 an external wire antenna dramatically improves weak-signal reception over a stock telescopic whip.</p>"
  + "<p>If you don't own a radio yet, WebSDR (above) lets you listen to real international broadcasts immediately, and our <a href=\"/schedules-by-country/\">schedules by country</a> page organizes stations by where they're broadcasting from, so you can find, say, every station transmitting from Japan or Germany at a glance.</p>"
  + "<h2>Best Times to Listen</h2><p>Shortwave propagation changes with the time of day and the ionosphere. Lower bands (49m, 41m, 31m) tend to carry best after dark and into the early morning; higher bands (25m, 19m, 16m) often perform better midday. Our live tracker adjusts automatically \u2014 it only shows stations that are actually scheduled to be on air right now.</p>"
  + "<h2>Browse More</h2><div class=\"tags\"><a href=\"/stations/\">All Stations</a><a href=\"/frequency/\">All Frequencies</a><a href=\"/bands/\">Shortwave Bands</a><a href=\"/schedules-by-country/\">Schedules by Country</a><a href=\"/best-shortwave-radios-for-beginners/\">Best Beginner Radios</a></div>";
write("listen-online/index.html", shell({
  title: "Listen to Shortwave Radio Online \u2014 Live On-Air Stations Now | ShortwaveHQ",
  desc: "Listen to shortwave radio online free via WebSDR, or see exactly which shortwave stations are on-air right now with ShortwaveHQ's live 2026 broadcast tracker. Includes a guide to listening to international broadcasts.",
  canonical: "/listen-online/", kicker: "Listen Live \u00b7 On-Air Now \u00b7 International Broadcasts",
  h1: "Listen to Shortwave <span style=\"color:#c0392b\">Radio Online</span>", bodyHtml: loBody,
  breadcrumbs: [["Home", "/"], ["Listen Online", "/listen-online/"]]
}));
urls.push("/listen-online/");

// ── Site Tour (video walkthrough page, crawlable + VideoObject schema) ──
var tourLd = {
  "@context": "https://schema.org", "@type": "VideoObject",
  "name": "Tour of HQ Shortwave Radio Website",
  "description": "A full walkthrough of ShortwaveHQ \u2014 live global shortwave schedules, real NOAA propagation data, hands-on gear reviews, and the community Reception Log.",
  "thumbnailUrl": "https://i.ytimg.com/vi/FyPiY_Y-PLs/hqdefault.jpg",
  "uploadDate": "2026-09-02",
  "embedUrl": "https://www.youtube.com/embed/FyPiY_Y-PLs",
  "contentUrl": "https://youtu.be/FyPiY_Y-PLs",
  "publisher": { "@type": "Organization", "name": "ShortwaveHQ", "url": SITE }
};
var tourBody = "<script type=\"application/ld+json\">" + JSON.stringify(tourLd) + "</script>"
  + "<div style=\"position:relative;padding-top:56.25%;border-radius:8px;overflow:hidden;background:#000;margin-bottom:1.4rem\">"
  + "<iframe src=\"https://www.youtube.com/embed/FyPiY_Y-PLs\" title=\"Tour of HQ Shortwave Radio Website\" loading=\"lazy\" style=\"position:absolute;top:0;left:0;width:100%;height:100%;border:0\" allow=\"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture\" allowfullscreen></iframe></div>"
  + "<p class=\"lede\">A full walkthrough of ShortwaveHQ \u2014 how to search the live global shortwave schedule, read real-time propagation data, browse hands-on gear reviews, and log your own receptions in the community Reception Log.</p>"
  + "<h2>What's Covered</h2><ul>"
  + "<li>Searching the live schedule by frequency, station name, or region</li>"
  + "<li>Reading real-time NOAA propagation data to know what the bands are doing</li>"
  + "<li>Finding honest, tested gear reviews before you buy a radio</li>"
  + "<li>Logging your own catches in the community Reception Log</li></ul>"
  + "<h2>Get Started</h2><p>New to the hobby? Head to our <a href=\"/best-shortwave-radios-for-beginners/\">beginner's guide</a> for radio recommendations, or jump straight into the <a href=\"/\">live schedule</a>.</p>"
  + "<h2>Browse More</h2><div class=\"tags\"><a href=\"/\">Live Schedule</a><a href=\"/best-shortwave-radios-for-beginners/\">Best Beginner Radios</a><a href=\"/listen-online/\">Listen Online</a></div>";
write("site-tour/index.html", shell({
  title: "Tour of ShortwaveHQ \u2014 Full Site Walkthrough Video",
  desc: "Watch a full video tour of ShortwaveHQ: live shortwave schedules, real propagation data, gear reviews, and the community Reception Log, all explained.",
  canonical: "/site-tour/", kicker: "Video \u00b7 Site Tour",
  h1: "Tour of the <span style=\"color:#c0392b\">ShortwaveHQ</span> Website", bodyHtml: tourBody,
  breadcrumbs: [["Home", "/"], ["Site Tour", "/site-tour/"]]
}));
urls.push("/site-tour/");

// ── Best Shortwave Radios for Beginners ─────────────────────────
var brBody = "<p class=\"lede\">If you're buying your first shortwave radio, the honest advice is simpler than most buying guides make it sound: get something with SSB (single sideband) capability, don't overspend before you know if you'll stick with the hobby, and don't judge a radio by FM performance alone \u2014 shortwave reception is a different skill.</p>"
  + "<h2>Our Top Beginner Pick: Tecsun PL-330</h2><p>At $79\u2013$99, the PL-330 is the radio most 2026 buying guides agree on for a first purchase. It's compact enough to travel with, has real SSB tuning (not a stripped-down version), and its PLL tuning means you can dial in an exact frequency instead of hunting with an analog knob. If you only buy one radio to start, this is the one.</p>"
  + "<h2>Best Value: XHDATA D-808</h2><p>At $59\u2013$79, the D-808 punches well above its price \u2014 full band coverage including SSB and AIR band, with sensitivity that regularly outperforms radios two or three times its cost. If budget is the deciding factor, start here.</p>"
  + "<h2>Best for Emergency Prep: Kaito KA500</h2><p>At $39\u2013$59, the KA500 isn't the best pure DXing radio on this list, but it's the most versatile: solar, hand-crank, battery, and USB power, plus NOAA weather alerts. If you want a radio that pulls double duty for emergencies, this is it.</p>"
  + "<h2>What to Avoid as a Beginner</h2><p>Skip radios with no SSB mode \u2014 you'll be locked out of a huge portion of what makes shortwave interesting (utility stations, ham traffic, numbers stations). Also be cautious of ultra-cheap unbranded radios on marketplace sites with no model name; quality control on those varies wildly.</p>"
  + "<h2>Not Sure Which One Fits You?</h2><p>Answer two quick questions in the Radio Finder tool on our <a href=\"/\">Equipment page</a> and get a specific recommendation based on your budget and how you plan to use it.</p>"
  + "<h2>Read Full Reviews</h2><p>We've published hands-on reviews of several budget and mid-range radios, including real-world reception notes and verdicts, in the Reviews section of our <a href=\"/\">homepage</a>.</p>"
  + "<h2>Browse More</h2><div class=\"tags\"><a href=\"/listen-online/\">Listen Online</a><a href=\"/best-antennas-for-apartments/\">Antennas for Small Spaces</a><a href=\"/stations/\">All Stations</a></div>";
write("best-shortwave-radios-for-beginners/index.html", shell({
  title: "Best Shortwave Radios for Beginners (2026) | ShortwaveHQ",
  desc: "Our picks for the best shortwave radios for beginners in 2026, including the Tecsun PL-330, XHDATA D-808, and Kaito KA500 \u2014 with honest guidance on what to avoid.",
  canonical: "/best-shortwave-radios-for-beginners/", kicker: "Buying Guide \u00b7 2026",
  h1: "Best Shortwave Radios for <span style=\"color:#c0392b\">Beginners</span>", bodyHtml: brBody,
  breadcrumbs: [["Home", "/"], ["Best Radios for Beginners", "/best-shortwave-radios-for-beginners/"]]
}));
urls.push("/best-shortwave-radios-for-beginners/");

// ── Numbers Stations Explained ───────────────────────────────────
var nsBody = "<p class=\"lede\">Tune across the shortwave bands at the right hour and you may stumble onto something genuinely eerie: a flat, robotic voice reading strings of numbers or letters, over and over, for no apparent audience. These are numbers stations \u2014 and despite decades of speculation, they're one of the few genuinely unresolved mysteries still broadcasting in the open, right now, on frequencies anyone can tune.</p>"
  + "<h2>What Are Numbers Stations?</h2><p>A numbers station is a shortwave broadcast, usually voice (sometimes Morse code or digital tones), that reads sequences of numbers, letters, or words in a fixed, repetitive format \u2014 often introduced by a distinctive tune or tone sequence, then groups of five digits read aloud, then silence until the next scheduled transmission.</p>"
  + "<h2>Who's Actually Behind Them?</h2><p>Intelligence agencies are the widely accepted explanation, and it's one of the rare conspiracy-adjacent theories with real, documented backing. Numbers stations are believed to transmit one-time-pad encoded messages to field agents \u2014 a system that's actually unbreakable if used correctly, because the encryption key is used only once and never reused. Several governments, including the US, UK, Cuba, and Russia, have been linked to specific stations over the decades, though none officially confirm it.</p>"
  + "<h2>Famous Numbers Stations to Listen For</h2><p>Our live database tracks several active and historically notable numbers stations, including <a href=\"/stations/e06-yosemite-sam/\">E06 \"Yosemite Sam\"</a>, <a href=\"/stations/m03-lincolnshire-poacher/\">M03 \"Lincolnshire Poacher\"</a> (a legendary now-silent UK station named for the folk tune it used as an interval signal), <a href=\"/stations/m08a-russian-numbers/\">M08a Russian Numbers</a>, <a href=\"/stations/m14-orthodox-bell/\">M14 \"Orthodox Bell\"</a>, and <a href=\"/stations/v13-english-numbers/\">V13 English Numbers</a>. Perhaps the most famous of all isn't a numbers station in the strict sense but shares the same eerie DNA: <a href=\"/stations/uvb-76-the-buzzer/\">UVB-76 \"The Buzzer\"</a>, a Russian station that has transmitted a near-continuous buzzing tone since the Cold War, occasionally interrupted by cryptic voice messages.</p>"
  + "<h2>How to Find and Listen to Them</h2><p>Numbers stations don't publish official schedules \u2014 everything known about their timing comes from decades of hobbyist logging. Check our <a href=\"/\">live tracker</a> for currently scheduled transmissions, or browse frequencies directly on our <a href=\"/frequency/\">frequency list</a>. Any basic shortwave radio can pick these up; no special equipment is needed, just patience and the right time of day.</p>"
  + "<h2>Browse More</h2><div class=\"tags\"><a href=\"/stations/\">All Stations</a><a href=\"/listen-online/\">Listen Online Now</a><a href=\"/best-shortwave-radios-for-beginners/\">Best Beginner Radios</a></div>";
write("numbers-stations-explained/index.html", shell({
  title: "Numbers Stations Explained \u2014 What They Are & How to Find Them | ShortwaveHQ",
  desc: "What are numbers stations, who really broadcasts them, and how to find and listen to famous ones like UVB-76, the Lincolnshire Poacher, and Yosemite Sam.",
  canonical: "/numbers-stations-explained/", kicker: "Explainer \u00b7 Shortwave Mysteries",
  h1: "Numbers Stations, <span style=\"color:#c0392b\">Explained</span>", bodyHtml: nsBody,
  breadcrumbs: [["Home", "/"], ["Numbers Stations Explained", "/numbers-stations-explained/"]]
}));
urls.push("/numbers-stations-explained/");

// ── Best Antennas for Apartment Dwellers ─────────────────────────
var apBody = "<p class=\"lede\">Not having a backyard for a full-size wire antenna doesn't mean weak shortwave reception. Apartment and HOA-restricted listeners have real, effective options \u2014 you just need to pick the right category for your situation.</p>"
  + "<h2>Best Overall: Small Active Loop Antennas</h2><p>An active loop antenna (roughly 1\u20133 feet in diameter) sits on a desk, windowsill, or balcony rail and uses a small amplifier to make up for its compact size. This is the single best solution for most apartment dwellers \u2014 no permanent installation, no landlord conversation required, and genuinely competitive performance versus a large outdoor wire.</p>"
  + "<h2>Stealth Option: Compact/Concealed Antennas</h2><p>Purpose-built compact antennas designed to be inconspicuous \u2014 mounted behind furniture, along a windowsill, or disguised as ordinary household items \u2014 are worth considering if you're in a strict no-visible-antenna building. They trade a little performance for genuine invisibility.</p>"
  + "<h2>Budget Option: Longwire Indoor Antenna</h2><p>A simple length of wire run around a room (along a baseboard, behind curtains, up a wall) still meaningfully improves reception over a radio's stock telescopic whip, and costs almost nothing. It's the lowest-effort upgrade if you're not ready to invest in an active loop.</p>"
  + "<h2>What to Avoid</h2><p>Skip anything requiring permanent outdoor mounting or running wire outside a window if your lease or HOA prohibits visible modifications \u2014 not worth the conflict when indoor and balcony-friendly options perform well.</p>"
  + "<h2>Pairing With a Radio</h2><p>Any of these antennas noticeably improves reception on our <a href=\"/best-shortwave-radios-for-beginners/\">recommended beginner radios</a>, especially models with an external antenna jack rather than only a telescopic whip.</p>"
  + "<h2>Browse More</h2><div class=\"tags\"><a href=\"/best-shortwave-radios-for-beginners/\">Best Beginner Radios</a><a href=\"/listen-online/\">Listen Online Now</a><a href=\"/stations/\">All Stations</a></div>";
write("best-antennas-for-apartments/index.html", shell({
  title: "Best Antennas for Apartment Dwellers & Small Spaces (2026) | ShortwaveHQ",
  desc: "The best shortwave antennas for apartments, HOAs, and small spaces \u2014 active loop antennas, stealth options, and budget indoor wire setups that actually work.",
  canonical: "/best-antennas-for-apartments/", kicker: "Buying Guide \u00b7 Small-Space Listening",
  h1: "Best Antennas for <span style=\"color:#c0392b\">Apartment Dwellers</span>", bodyHtml: apBody,
  breadcrumbs: [["Home", "/"], ["Antennas for Apartments", "/best-antennas-for-apartments/"]]
}));
urls.push("/best-antennas-for-apartments/");

// ── Shortwave Schedules by Country ───────────────────────────────
var COUNTRY_MAP = {
  "United Kingdom": ["BBC World Service", "BBC Arabic Service", "BBC Hausa Service", "BBC Persian Service", "Radio Caroline Int'l", "London Volmet"],
  "United States": ["Voice of America", "VOA Afrique", "VOA Ashna Radio", "VOA Persian Service", "VOA Radio Ashna", "VOA Southeast Asia", "VOA Zimbabwe", "Radio Free Asia", "Radio Marti", "Radio Sawa", "WRMI / WWCR", "WRMI C. America", "WRMI Eastern N. America", "WRMI Europe", "WRMI Latin America", "WRMI North America", "WRMI Okeechobee FL", "WRMI S. America/Africa", "WRMI Western USA", "WWCR Nashville TN", "WBCQ The Planet", "WTWW Lebanon TN", "WHRI World Harvest Radio", "Adventist World Radio", "USAF HF-GCS SKYKING", "USCG NMF Boston", "USCG NMN Maritime", "WWV / WWVH Hawaii", "WWV Fort Collins CO", "ARINC Honolulu", "ARINC San Francisco", "San Francisco VOLMET", "New York VOLMET", "HF Underground Pirates", "KBOX Radio Pirates", "From The Isle of Music", "Overcomer Ministry"],
  "China": ["China Radio International", "China Radio Int'l Russian", "BPM Pucheng China"],
  "Japan": ["Radio Japan NHK World"],
  "South Korea": ["KBS World Radio Korea"],
  "North Korea": ["Voice of Korea DPRK"],
  "Cuba": ["Radio Habana Cuba", "Radio Rebelde Cuba"],
  "Russia": ["Radio Sputnik Russia", "RWM Moscow Russia", "UVB-76 The Buzzer"],
  "Germany": ["Channel 292 Germany"],
  "France": ["Radio France Internationale", "RFI Afrique"],
  "Spain": ["Radio Exterior de Espana"],
  "Romania": ["Radio Romania International"],
  "Bulgaria": ["Radio Bulgaria"],
  "Slovakia": ["Radio Slovakia International"],
  "Finland": ["Radio Arcala Finland"],
  "Greece": ["Voice of Greece ERA5"],
  "Turkey": ["Voice of Turkey"],
  "Vietnam": ["Voice of Vietnam"],
  "Thailand": ["Radio Thailand World"],
  "Taiwan": ["Radio Taiwan International"],
  "India": ["All India Radio External"],
  "Kuwait": ["Radio Kuwait"],
  "Nigeria": ["Voice of Nigeria"],
  "Algeria": ["Radio Algerie Chaine 1"],
  "Belarus": ["Belarus Radio"],
  "Ecuador": ["HCJB Ecuador"],
  "New Zealand": ["Radio New Zealand Pacific", "RNZ Pacific Overnight"],
  "Australia": ["Reach Beyond Australia", "Darwin VOLMET Australia"],
  "Canada": ["Gander VOLMET Canada"],
  "Ireland": ["Shannon VOLMET Ireland"],
  "Vatican City": ["Vatican Radio"],
  "Czech Republic": ["Radio Free Europe / RL"]
};
var countrySlug = {}; var countryNames = Object.keys(COUNTRY_MAP).sort();
for (var cn = 0; cn < countryNames.length; cn++) countrySlug[countryNames[cn]] = slug(countryNames[cn]);
var cIndexGrid = "";
for (var ci = 0; ci < countryNames.length; ci++) {
  var cname = countryNames[ci];
  var cStations = COUNTRY_MAP[cname].filter(function (s) { return byStation[s]; });
  if (!cStations.length) continue;
  cIndexGrid += "<a href=\"/schedules-by-country/" + countrySlug[cname] + "/\">" + esc(cname) + "<span>" + cStations.length + " station" + (cStations.length > 1 ? "s" : "") + "</span></a>";
  var cBody = "<p class=\"lede\">Shortwave stations broadcasting from or representing " + esc(cname) + ", with live frequencies and schedules for 2026.</p><div class=\"grid\">";
  cStations.sort();
  for (var cs = 0; cs < cStations.length; cs++) {
    var csName = cStations[cs];
    var csRows = byStation[csName];
    var csFreqs = uniq(csRows.map(function (r) { return kHz(r.freq) + " kHz"; })).slice(0, 4).join(", ");
    cBody += "<a href=\"/stations/" + stationSlug[csName] + "/\">" + esc(csName) + "<span>" + esc(csFreqs) + "</span></a>";
  }
  cBody += "</div><h2>Browse More</h2><div class=\"tags\"><a href=\"/schedules-by-country/\">All Countries</a><a href=\"/stations/\">All Stations A\u2013Z</a><a href=\"/listen-online/\">Listen Online Now</a></div>";
  write("schedules-by-country/" + countrySlug[cname] + "/index.html", shell({
    title: "Shortwave Schedules from " + cname + " (2026) | ShortwaveHQ",
    desc: "Live 2026 shortwave frequencies and schedules for " + cStations.length + " station" + (cStations.length > 1 ? "s" : "") + " broadcasting from " + cname + ".",
    canonical: "/schedules-by-country/" + countrySlug[cname] + "/", kicker: "Schedules by Country",
    h1: "Shortwave Schedules from <span style=\"color:#c0392b\">" + esc(cname) + "</span>", bodyHtml: cBody,
    breadcrumbs: [["Home", "/"], ["Schedules by Country", "/schedules-by-country/"], [cname, "/schedules-by-country/" + countrySlug[cname] + "/"]]
  }));
  urls.push("/schedules-by-country/" + countrySlug[cname] + "/");
}
var cxBody = "<p class=\"lede\">Browse shortwave broadcast schedules organized by the country each station transmits from \u2014 " + countryNames.length + " countries currently tracked in our 2026 database.</p><div class=\"grid\">" + cIndexGrid + "</div>";
write("schedules-by-country/index.html", shell({
  title: "Shortwave Schedules by Country (2026) | ShortwaveHQ",
  desc: "Browse shortwave radio schedules organized by broadcasting country \u2014 find every station transmitting from a specific country with live 2026 frequencies.",
  canonical: "/schedules-by-country/", kicker: "Schedules by Country",
  h1: "Shortwave Schedules by <span style=\"color:#c0392b\">Country</span>", bodyHtml: cxBody,
  breadcrumbs: [["Home", "/"], ["Schedules by Country", "/schedules-by-country/"]]
}));
urls.push("/schedules-by-country/");

// ── Shortwave Radio Articles ──────────────────────────────────────
var ARTICLES = [
  {
    slug: "rti-french-service-august-2026-special-broadcasts",
    title: "RTI's French Service Returns to Shortwave for August 2026",
    date: "2026-08-07",
    summary: "Radio Taiwan International's French Service is running special direct shortwave broadcasts from Taiwan every Friday, Saturday, and Sunday through August 30, 2026, aimed at listeners in Europe and North Africa.",
    bodyHtml: "<p class=\"lede\">Radio Taiwan International's French Service is broadcasting directly from its Tamsui transmission site in northern Taiwan throughout August 2026, targeting listeners in Europe and North Africa. The special shortwave transmissions run every Friday, Saturday, and Sunday from August 7 through August 30.</p>"
      + "<p>One frequency has already changed since the broadcasts were first announced: RTI moved from 11995 kHz to 11850 kHz after listeners reported persistent interference on the original frequency during the German Service's July transmissions. Listeners who helped verify the new frequency were thanked directly by the station.</p>"
      + "<p>Listeners who send in reception reports for these August broadcasts can receive a special commemorative QSL card confirming their reception \u2014 a nice incentive for anyone logging RTI this month.</p>"
      + "<h2>Why This Matters</h2><p>Direct shortwave transmissions from Taiwan, rather than relayed broadcasts, are increasingly rare as international broadcasters shift toward internet delivery. A dedicated multi-week run like this is worth catching while it's scheduled \u2014 check our <a href=\"/schedules-by-country/taiwan/\">Taiwan schedule page</a> for current frequencies, or tune in live via our <a href=\"/listen-online/\">Listen Online</a> page.</p>"
      + "<p style=\"font-family:var(--mono,'IBM Plex Mono',monospace);font-size:.7rem;color:#9c8e81;margin-top:1.4rem\">Source: <a href=\"https://swling.com/blog/\" target=\"_blank\" rel=\"noopener\">The SWLing Post</a>, reported by contributor David Iurescia.</p>"
  }
];
var aIndexList = "";
for (var ai = 0; ai < ARTICLES.length; ai++) {
  var art = ARTICLES[ai];
  aIndexList += "<a href=\"/articles/" + art.slug + "/\" style=\"display:block;padding:1rem;background:#fff;border:1px solid #c8c0b0;border-radius:6px;margin-bottom:.7rem;text-decoration:none;color:#0a0b0e\"><div style=\"font-family:'IBM Plex Mono',monospace;font-size:.58rem;letter-spacing:.08em;text-transform:uppercase;color:#9c8e81;margin-bottom:.3rem\">" + art.date + "</div><div style=\"font-family:Syne,sans-serif;font-weight:800;font-size:1.02rem;margin-bottom:.4rem\">" + esc(art.title) + "</div><div style=\"font-size:.85rem;color:#4a4238;line-height:1.6\">" + esc(art.summary) + "</div></a>";
  var aBody = art.bodyHtml + "<h2>More Articles</h2><div class=\"tags\"><a href=\"/articles/\">All Articles</a><a href=\"/listen-online/\">Listen Online</a><a href=\"/schedules-by-country/\">Schedules by Country</a></div>";
  write("articles/" + art.slug + "/index.html", shell({
    title: art.title + " | ShortwaveHQ",
    desc: art.summary,
    canonical: "/articles/" + art.slug + "/", kicker: "Shortwave Radio Articles \u00b7 " + art.date,
    h1: art.title, bodyHtml: aBody,
    breadcrumbs: [["Home", "/"], ["Articles", "/articles/"], [art.title, "/articles/" + art.slug + "/"]]
  }));
  urls.push("/articles/" + art.slug + "/");
}
var axBody = "<p class=\"lede\">News, schedule changes, and notable happenings in the shortwave radio world, updated as things come up.</p>" + aIndexList;
write("articles/index.html", shell({
  title: "Shortwave Radio Articles & News (2026) | ShortwaveHQ",
  desc: "Shortwave radio news, broadcast schedule changes, and notable happenings in the SWL hobby, updated regularly.",
  canonical: "/articles/", kicker: "Shortwave Radio Articles",
  h1: "Shortwave Radio <span style=\"color:#c0392b\">Articles</span>", bodyHtml: axBody,
  breadcrumbs: [["Home", "/"], ["Articles", "/articles/"]]
}));
urls.push("/articles/");

// ── 9. Index pages ───────────────────────────────────────────────
var stIdx = "<p class=\"lede\">Individual schedule pages for every station in the ShortwaveHQ database \u2014 " + stationNames.length + " broadcasters, time stations, utility and numbers stations, updated for the 2026 EIBI A-26 season.</p><div class=\"grid\">";
for (var si = 0; si < stationNames.length; si++) {
  var nm2 = stationNames[si];
  stIdx += "<a href=\"/stations/" + stationSlug[nm2] + "/\"><strong>" + esc(nm2) + "</strong><span>" + uniq(byStation[nm2].map(function (r) { return String(kHz(r.freq)); })).length + " frequencies</span></a>";
}
stIdx += "</div>";
write("stations/index.html", shell({
  title: "Shortwave Stations \u2014 Live List of " + stationNames.length + "+ Broadcasters & Frequencies (2026) | ShortwaveHQ",
  desc: "Shortwave stations list for 2026: " + stationNames.length + " broadcasters, time signals, utility, and numbers stations, each with full frequency schedules and live on-air status.",
  canonical: "/stations/", kicker: "Directory \u00b7 " + stationNames.length + " Stations",
  h1: "All Shortwave <span style=\"color:#c0392b\">Stations</span>", bodyHtml: stIdx,
  breadcrumbs: [["Home", "/"], ["Stations", "/stations/"]]
}));
urls.push("/stations/");

var fqIdx = "<p class=\"lede\">Every active frequency in the 2026 database \u2014 " + freqKeys.length + " channels from " + freqKeys[0] + " kHz to " + freqKeys[freqKeys.length - 1] + " kHz, each with its own schedule page.</p>";
for (var bi2 = 0; bi2 < BANDS.length; bi2++) {
  var bnd = BANDS[bi2];
  var inBand = freqKeys.filter(function (k) { var m = k / 1000; return m >= bnd.lo && m <= bnd.hi; });
  if (!inBand.length) continue;
  fqIdx += "<h2><a href=\"/bands/" + bandSlug[bnd.name] + "/\" style=\"text-decoration:none;color:inherit\">" + esc(bnd.name) + "</a> <span style=\"font-size:.75rem;color:#9c8e81;font-family:'IBM Plex Mono',monospace\">" + bnd.lo + "\u2013" + bnd.hi + " MHz</span></h2><div class=\"tags\">";
  for (var ib = 0; ib < inBand.length; ib++) fqIdx += "<a href=\"/frequency/" + inBand[ib] + "-khz/\">" + inBand[ib] + " kHz</a>";
  fqIdx += "</div>";
}
var outOfBand = freqKeys.filter(function (k) { return !bandFor(k / 1000); });
if (outOfBand.length) {
  fqIdx += "<h2>Out-of-Band &amp; Utility Channels</h2><div class=\"tags\">";
  for (var ob = 0; ob < outOfBand.length; ob++) fqIdx += "<a href=\"/frequency/" + outOfBand[ob] + "-khz/\">" + outOfBand[ob] + " kHz</a>";
  fqIdx += "</div>";
}
write("frequency/index.html", shell({
  title: "Shortwave Frequencies \u2014 Complete 2026 List by Meter Band | ShortwaveHQ",
  desc: "Shortwave frequencies list for 2026 \u2014 " + freqKeys.length + " active channels organized by meter band, each linking to a full schedule of stations, times, and languages.",
  canonical: "/frequency/", kicker: "Directory \u00b7 " + freqKeys.length + " Frequencies",
  h1: "Shortwave <span style=\"color:#c0392b\">Frequency List</span> 2026", bodyHtml: fqIdx,
  breadcrumbs: [["Home", "/"], ["Frequencies", "/frequency/"]]
}));
urls.push("/frequency/");

var bdIdx = "<p class=\"lede\">The shortwave spectrum is divided into meter bands, each with its own character and best listening hours. Pick a band to see every active frequency and station on it in 2026.</p><div class=\"grid\">";
for (var bi3 = 0; bi3 < BANDS.length; bi3++) {
  var bnd2 = BANDS[bi3];
  var cnt = freqKeys.filter(function (k) { var m = k / 1000; return m >= bnd2.lo && m <= bnd2.hi; }).length;
  if (!cnt) continue;
  bdIdx += "<a href=\"/bands/" + bandSlug[bnd2.name] + "/\"><strong>" + esc(bnd2.name) + "</strong><span>" + bnd2.lo + "\u2013" + bnd2.hi + " MHz \u00b7 " + cnt + " active frequencies</span></a>";
}
bdIdx += "</div>";
write("bands/index.html", shell({
  title: "Shortwave Bands Explained \u2014 49m, 31m, 25m, 19m & More (2026) | ShortwaveHQ",
  desc: "Guide to the shortwave meter bands \u2014 49m, 41m, 31m, 25m, 19m, 16m and more \u2014 with every active 2026 frequency and station on each band, plus best listening times.",
  canonical: "/bands/", kicker: "Band Guides",
  h1: "Shortwave <span style=\"color:#c0392b\">Meter Bands</span>", bodyHtml: bdIdx,
  breadcrumbs: [["Home", "/"], ["Bands", "/bands/"]]
}));
urls.push("/bands/");

// ── 10. Sitemap + robots ─────────────────────────────────────────
var sm = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n";
for (var u = 0; u < urls.length; u++) {
  sm += "<url><loc>" + SITE + urls[u] + "</loc><lastmod>" + TODAY + "</lastmod></url>\n";
}
sm += "</urlset>\n";
write("sitemap.xml", sm);
write("robots.txt", "User-agent: *\nAllow: /\nSitemap: " + SITE + "/sitemap.xml\n");

console.log("BUILD COMPLETE: " + urls.length + " URLs (" + stationNames.length + " stations, " + freqKeys.length + " frequencies, " + bandsBuilt + " bands, " + countryNames.length + " countries, 4 guides, 1 listen-online, 1 home) + sitemap.xml + robots.txt");
