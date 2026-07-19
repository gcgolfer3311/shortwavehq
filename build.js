// ShortwaveHQ static page generator
// Runs on Netlify at deploy time: reads the SCH database out of index.html
// and generates individual landing pages for every station, frequency, and band,
// plus a sitemap.xml and robots.txt. No dependencies — Node built-ins only.
//
// Netlify runs this via netlify.toml:  command = "node build.js", publish = "dist"

var fs = require("fs");
var path = require("path");

var SITE = "https://hqshortwaveradio.com";
var OUT = path.join(__dirname, "dist");
var TODAY = new Date().toISOString().slice(0, 10);

// ── 1. Read index.html and extract the SCH database ─────────────
var html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
var start = html.indexOf("var SCH=[");
if (start < 0) { console.error("BUILD FAILED: could not find 'var SCH=[' in index.html"); process.exit(1); }
var end = html.indexOf("\n];", start);
if (end < 0) { console.error("BUILD FAILED: could not find end of SCH array"); process.exit(1); }
var arrText = html.slice(start + "var SCH=".length, end + 2); // includes closing ]
var SCH;
try { SCH = new Function("return " + arrText + ";")(); }
catch (e) { console.error("BUILD FAILED: could not parse SCH array: " + e.message); process.exit(1); }
console.log("Parsed " + SCH.length + " schedule rows from index.html");

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
  return "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>" + esc(opts.title) + "</title>\n<meta name=\"description\" content=\"" + esc(opts.desc) + "\">\n<link rel=\"canonical\" href=\"" + SITE + opts.canonical + "\">\n<meta name=\"robots\" content=\"index,follow\">\n<meta property=\"og:title\" content=\"" + esc(opts.title) + "\">\n<meta property=\"og:description\" content=\"" + esc(opts.desc) + "\">\n<meta property=\"og:url\" content=\"" + SITE + opts.canonical + "\">\n<meta property=\"og:type\" content=\"website\">\n<meta property=\"og:site_name\" content=\"ShortwaveHQ\">\n<meta property=\"og:image\" content=\"" + SITE + "/og-image.png\">\n<script type=\"application/ld+json\">" + JSON.stringify(bc) + "</script>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Syne:wght@800;900&family=IBM+Plex+Mono:wght@400;600&family=Libre+Baskerville:ital@0;1&display=swap\" rel=\"stylesheet\">\n<style>\n*{box-sizing:border-box;margin:0;padding:0}\nbody{background:#f5f0e8;color:#0a0b0e;font-family:\"Libre Baskerville\",Georgia,serif;font-size:1.02rem;line-height:1.65}\na{color:#c0392b}\n.mast{background:#0a0b0e;border-bottom:3px solid #c0392b;padding:.85rem 1.2rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem}\n.bname{font-family:Syne,sans-serif;font-weight:900;font-size:1.15rem;color:#fff;letter-spacing:-.04em;text-decoration:none}\n.bname em{color:#e74c3c;font-style:normal}\n.mlink{font-family:\"IBM Plex Mono\",monospace;font-size:.62rem;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.75);text-decoration:none}\n.wrap{max-width:960px;margin:0 auto;padding:1.6rem 1.2rem 3.5rem}\n.kick{font-family:\"IBM Plex Mono\",monospace;font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;color:#9c8e81;margin-bottom:.4rem}\nh1{font-family:Syne,sans-serif;font-weight:800;font-size:1.7rem;letter-spacing:-.025em;line-height:1.15;margin-bottom:.9rem}\nh2{font-family:Syne,sans-serif;font-weight:800;font-size:1.12rem;letter-spacing:-.02em;margin:1.8rem 0 .7rem}\np{margin-bottom:.9rem}\n.lede{font-size:1.05rem}\n.cta{display:inline-block;font-family:\"IBM Plex Mono\",monospace;font-size:.72rem;font-weight:600;letter-spacing:.05em;background:#c0392b;color:#fff;text-decoration:none;padding:11px 18px;border-radius:4px;margin:.3rem .5rem .3rem 0}\n.cta.o{background:transparent;color:#0a0b0e;border:1px solid #c8c0b0}\ntable{width:100%;border-collapse:collapse;font-size:.82rem;margin:.6rem 0 1rem;background:#fff;border:1px solid #c8c0b0}\nth{font-family:\"IBM Plex Mono\",monospace;font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;text-align:left;padding:8px 10px;background:#ece7db;border-bottom:1px solid #c8c0b0;color:#6b5f52}\ntd{padding:8px 10px;border-bottom:1px solid #e2dbd0;vertical-align:top}\ntd a{text-decoration:none;border-bottom:1px solid #e0c4bf}\n.tags a{display:inline-block;font-family:\"IBM Plex Mono\",monospace;font-size:.66rem;border:1px solid #c8c0b0;border-radius:20px;padding:4px 12px;margin:0 6px 8px 0;text-decoration:none;color:#6b5f52;background:#fff}\n.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;margin:.6rem 0 1rem}\n.grid a{display:block;background:#fff;border:1px solid #c8c0b0;border-radius:4px;padding:.7rem .8rem;text-decoration:none;color:#0a0b0e;font-size:.82rem}\n.grid a span{display:block;font-family:\"IBM Plex Mono\",monospace;font-size:.58rem;color:#9c8e81;margin-top:2px}\n.crumbs{font-family:\"IBM Plex Mono\",monospace;font-size:.6rem;color:#9c8e81;margin-bottom:1.1rem}\n.crumbs a{color:#6b5f52;text-decoration:none}\nfooter{background:#0a0b0e;color:rgba(255,255,255,.6);padding:1.6rem 1.2rem;font-family:\"IBM Plex Mono\",monospace;font-size:.62rem;line-height:1.9}\nfooter a{color:rgba(255,255,255,.85)}\n</style>\n</head>\n<body>\n<header class=\"mast\"><a class=\"bname\" href=\"/\">Shortwave<em>HQ</em></a><nav><a class=\"mlink\" href=\"/\">Live Search</a> &nbsp; <a class=\"mlink\" href=\"/stations/\">Stations</a> &nbsp; <a class=\"mlink\" href=\"/frequency/\">Frequencies</a> &nbsp; <a class=\"mlink\" href=\"/bands/\">Bands</a></nav></header>\n<main class=\"wrap\">\n<div class=\"crumbs\">" + opts.breadcrumbs.map(function (c, ix) { return ix === opts.breadcrumbs.length - 1 ? esc(c[0]) : "<a href=\"" + c[1] + "\">" + esc(c[0]) + "</a>"; }).join(" \u203a ") + "</div>\n<div class=\"kick\">" + esc(opts.kicker) + "</div>\n<h1>" + opts.h1 + "</h1>\n" + opts.bodyHtml + "\n</main>\n<footer><div style=\"max-width:960px;margin:0 auto\">\u00a9 2026 ShortwaveHQ \u00b7 <a href=\"/\">hqshortwaveradio.com</a> \u00b7 Live shortwave schedules, frequencies &amp; band conditions \u00b7 EIBI A-26 data \u00b7 Contact: <a href=\"mailto:Hqshortwaveradio@gmail.com\">Hqshortwaveradio@gmail.com</a><br>Independent hobbyist project \u2014 schedules provided as-is; verify against official station sources. As an Amazon Associate, ShortwaveHQ earns from qualifying purchases at no extra cost to you.</div></footer>\n</body>\n</html>";
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

var urls = ["/"];

// ── 6. Station pages ─────────────────────────────────────────────
for (var sn = 0; sn < stationNames.length; sn++) {
  var name = stationNames[sn];
  var rows = byStation[name].slice().sort(function (a, b) { return parseFloat(a.freq) - parseFloat(b.freq); });
  var sl = stationSlug[name];
  var langs = listWords(rows.map(function (r) { return r.lang; }), 5);
  var tgts = listWords(rows.map(function (r) { return r.tgt; }), 5);
  var sites = listWords(rows.map(function (r) { return r.site; }), 4);
  var freqs = uniq(rows.map(function (r) { return String(kHz(r.freq)); }));
  var title = name + " \u2014 Shortwave Frequencies & Schedule 2026 | ShortwaveHQ";
  var desc = name + " shortwave frequencies and broadcast times for 2026: " + rows.length + " scheduled transmission" + (rows.length > 1 ? "s" : "") + " on " + freqs.length + " frequenc" + (freqs.length > 1 ? "ies" : "y") + (langs ? " in " + langs : "") + (tgts ? ", beamed to " + tgts : "") + ". Check live on-air status and listen online.";
  var tbl = "<table><thead><tr><th>Frequency</th><th>Time (UTC)</th><th>Language</th><th>Target</th><th>Transmitter Site</th><th>Power</th></tr></thead><tbody>";
  for (var ri = 0; ri < rows.length; ri++) {
    var r2 = rows[ri];
    var bd = bandFor(parseFloat(r2.freq));
    tbl += "<tr><td><a href=\"/frequency/" + kHz(r2.freq) + "-khz/\">" + kHz(r2.freq) + " kHz</a>" + (bd ? " <span style=\"color:#9c8e81;font-size:.7rem\">(" + esc(bd.name.replace(" Band", "")) + ")</span>" : "") + "</td><td>" + fmtSched(r2) + "</td><td>" + esc(r2.lang || "") + "</td><td>" + esc(r2.tgt || "") + "</td><td>" + esc(r2.site || "\u2014") + "</td><td>" + (r2.kw ? r2.kw + " kW" : "\u2014") + "</td></tr>";
  }
  tbl += "</tbody></table>";
  var body = "<p class=\"lede\">All active shortwave transmissions for <strong>" + esc(name) + "</strong> in the 2026 EIBI A-26 schedule season" + (sites ? ", transmitting from " + esc(sites) : "") + ". Times are UTC. Frequencies link to full frequency pages showing everything else on that channel.</p>"
    + "<p><a class=\"cta\" href=\"/?q=" + encodeURIComponent(name) + "\">\u25cf Is it on the air right now? \u2192 Live status</a><a class=\"cta o\" href=\"http://websdr.ewi.utwente.nl:8901/?tune=" + kHz(rows[0].freq) + "am\" rel=\"nofollow\">Listen online via WebSDR</a></p>"
    + "<h2>" + esc(name) + " \u2014 Full 2026 Schedule</h2>" + tbl
    + "<h2>Browse More</h2><div class=\"tags\"><a href=\"/stations/\">All Stations</a><a href=\"/frequency/\">All Frequencies</a><a href=\"/bands/\">Shortwave Bands</a><a href=\"/\">Live Search &amp; Band Conditions</a></div>";
  write("stations/" + sl + "/index.html", shell({
    title: title, desc: desc, canonical: "/stations/" + sl + "/", kicker: "Station Profile \u00b7 EIBI A-26 \u00b7 2026",
    h1: esc(name) + " <span style=\"color:#c0392b\">Shortwave Schedule</span>", bodyHtml: body,
    breadcrumbs: [["Home", "/"], ["Stations", "/stations/"], [name, "/stations/" + sl + "/"]]
  }));
  urls.push("/stations/" + sl + "/");
}
console.log("Generated " + stationNames.length + " station pages");

// ── 7. Frequency pages ───────────────────────────────────────────
for (var fk = 0; fk < freqKeys.length; fk++) {
  var khz = freqKeys[fk];
  var rows2 = byFreq[String(khz)].slice().sort(function (a, b) { return a.s - b.s; });
  var mhz = khz / 1000;
  var bd2 = bandFor(mhz);
  var stns = uniq(rows2.map(function (r) { return r.stn; }));
  var title2 = khz + " kHz Shortwave \u2014 What Station Is On This Frequency? (2026) | ShortwaveHQ";
  var desc2 = "Who broadcasts on " + khz + " kHz (" + mhz.toFixed(3) + " MHz) shortwave? " + stns.slice(0, 3).join(", ") + (stns.length > 3 ? " and more" : "") + " \u2014 full 2026 schedule with UTC times, languages, target regions, and transmitter sites" + (bd2 ? " in the " + bd2.name.toLowerCase() : "") + ".";
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
    + "<p><a class=\"cta\" href=\"/?q=" + khz + "\">\u25cf What\u2019s on " + khz + " kHz right now? \u2192 Live status</a><a class=\"cta o\" href=\"http://websdr.ewi.utwente.nl:8901/?tune=" + khz + "am\" rel=\"nofollow\">Tune it live on WebSDR</a></p>"
    + "<h2>2026 Schedule for " + khz + " kHz</h2>" + tbl2
    + "<h2>Nearby Frequencies</h2>" + nav;
  write("frequency/" + khz + "-khz/index.html", shell({
    title: title2, desc: desc2, canonical: "/frequency/" + khz + "-khz/", kicker: "Frequency Guide \u00b7 " + mhz.toFixed(3) + " MHz",
    h1: khz + " kHz <span style=\"color:#c0392b\">Shortwave</span>", bodyHtml: body2,
    breadcrumbs: [["Home", "/"], ["Frequencies", "/frequency/"], [khz + " kHz", "/frequency/" + khz + "-khz/"]]
  }));
  urls.push("/frequency/" + khz + "-khz/");
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
    + "<h2>Other Bands</h2><div class=\"tags\">" + BANDS.filter(function (x) { return x.name !== band.name; }).map(function (x) { return "<a href=\"/bands/" + bandSlug[x.name] + "/\">" + esc(x.name) + "</a>"; }).join("") + "</div>";
  write("bands/" + bsl + "/index.html", shell({
    title: title3, desc: desc3, canonical: "/bands/" + bsl + "/", kicker: "Band Guide \u00b7 " + band.lo + "\u2013" + band.hi + " MHz",
    h1: esc(band.name) + " <span style=\"color:#c0392b\">Guide</span>", bodyHtml: body3,
    breadcrumbs: [["Home", "/"], ["Bands", "/bands/"], [band.name, "/bands/" + bsl + "/"]]
  }));
  urls.push("/bands/" + bsl + "/");
  bandsBuilt++;
}
console.log("Generated " + bandsBuilt + " band pages");

// ── 9. Index pages ───────────────────────────────────────────────
var stIdx = "<p class=\"lede\">Individual schedule pages for every station in the ShortwaveHQ database \u2014 " + stationNames.length + " broadcasters, time stations, utility and numbers stations, updated for the 2026 EIBI A-26 season.</p><div class=\"grid\">";
for (var si = 0; si < stationNames.length; si++) {
  var nm2 = stationNames[si];
  stIdx += "<a href=\"/stations/" + stationSlug[nm2] + "/\"><strong>" + esc(nm2) + "</strong><span>" + uniq(byStation[nm2].map(function (r) { return String(kHz(r.freq)); })).length + " frequencies</span></a>";
}
stIdx += "</div>";
write("stations/index.html", shell({
  title: "All Shortwave Stations A\u2013Z \u2014 Frequencies & Schedules 2026 | ShortwaveHQ",
  desc: "Alphabetical directory of " + stationNames.length + " shortwave stations with full 2026 frequency schedules: international broadcasters, time signals, utility, pirate, and numbers stations.",
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
  title: "Shortwave Frequency List 2026 \u2014 All Active Channels by Band | ShortwaveHQ",
  desc: "Complete shortwave frequency list for 2026 \u2014 " + freqKeys.length + " active channels organized by meter band, each linking to a full schedule of stations, times, and languages.",
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

console.log("BUILD COMPLETE: " + urls.length + " URLs (" + stationNames.length + " stations, " + freqKeys.length + " frequencies, " + bandsBuilt + " bands, 3 indexes, 1 home) + sitemap.xml + robots.txt");
