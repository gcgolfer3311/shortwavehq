// ShortwaveHQ Discrepancy Reports — Netlify Function + Netlify Blobs
// Turns individual "report a discrepancy" mailto reports into an aggregated,
// visible signal: how many listeners flagged the same frequency recently,
// instead of each report only ever being seen by one person's inbox.
// Same architecture pattern as guestbook.js (single JSON blob, read-modify-
// write, honeypot spam check, vendored Blobs module — no npm install needed).
//
// Endpoint (default, no netlify.toml redirect required):
//   GET  /.netlify/functions/discrepancy        -> { counts: {freq: count, ...}, updated }
//   POST /.netlify/functions/discrepancy         -> { ok:true, freq, count }
//
// Requires netlify.toml to declare the functions directory, e.g.:
//   [functions]
//     directory = "functions"

const { getStore } = require("./vendor/netlify-blobs/main.cjs");

const KEY = "reports";
const MAX_STORED = 2000;          // hard cap so the blob can't grow unbounded
const WINDOW_MS = 24 * 60 * 60 * 1000;   // "recent" window shown to visitors
const PRUNE_MS = 30 * 24 * 60 * 60 * 1000; // drop anything older than this on write
const MAX_FREQ_LEN = 80;

function clean(s, max) {
  return String(s || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

function aggregate(entries, windowMs) {
  const cutoff = Date.now() - windowMs;
  const counts = {};
  for (const e of entries) {
    if (!e || !e.freq || !e.ts) continue;
    const t = Date.parse(e.ts);
    if (isNaN(t) || t < cutoff) continue;
    counts[e.freq] = (counts[e.freq] || 0) + 1;
  }
  return counts;
}

exports.handler = async function (event) {
  const store = getStore("discrepancy-reports");

  if (event.httpMethod === "GET") {
    let entries = [];
    try {
      entries = (await store.get(KEY, { type: "json" })) || [];
    } catch (e) {
      entries = [];
    }
    const counts = aggregate(entries, WINDOW_MS);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ counts, updated: new Date().toISOString() }),
    };
  }

  if (event.httpMethod === "POST") {
    let data;
    try {
      data = JSON.parse(event.body || "{}");
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Invalid request body" }) };
    }

    // Honeypot: real visitors never fill this hidden field.
    if (data["bot-field"]) {
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    const freq = clean(data.freq, MAX_FREQ_LEN);
    if (!freq) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "freq is required" }) };
    }

    let entries = [];
    try {
      entries = (await store.get(KEY, { type: "json" })) || [];
    } catch (e) {
      entries = [];
    }

    const now = new Date();
    entries.push({ freq, ts: now.toISOString() });

    // Prune anything older than PRUNE_MS so the store stays small forever,
    // then also cap on raw count as a second safety net.
    const cutoff = now.getTime() - PRUNE_MS;
    entries = entries.filter((e) => {
      const t = Date.parse(e && e.ts);
      return !isNaN(t) && t >= cutoff;
    });
    if (entries.length > MAX_STORED) entries = entries.slice(entries.length - MAX_STORED);

    try {
      await store.setJSON(KEY, entries);
    } catch (e) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: "Could not save report" }) };
    }

    const counts = aggregate(entries, WINDOW_MS);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, freq, count: counts[freq] || 1 }),
    };
  }

  return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
};
