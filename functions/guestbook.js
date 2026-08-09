// ShortwaveHQ Guestbook — Netlify Function + Netlify Blobs
// Open guestbook: no manual moderation step. A POST here is visible to every
// visitor within seconds via GET. Same architecture pattern as CB Radio HQ's
// skip-spots.js (single JSON blob, read-modify-write, honeypot spam check).
//
// Endpoint (default, no netlify.toml redirect required):
//   GET  /.netlify/functions/guestbook   -> { entries: [...] }  (newest first)
//   POST /.netlify/functions/guestbook   -> { ok:true, entry:{...} }
//
// Requires netlify.toml to declare the functions directory, e.g.:
//   [functions]
//     directory = "functions"

const { getStore } = require("./vendor/netlify-blobs/main.cjs");

const KEY = "entries";
const MAX_STORED = 500;   // hard cap so the blob can't grow unbounded
const MAX_RETURNED = 200; // cap on what a single GET returns

const MAX_NAME = 60;
const MAX_STATION = 60;
const MAX_MESSAGE = 500;

function clean(s, max) {
  return String(s || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

exports.handler = async function (event) {
  const store = getStore("guestbook");

  if (event.httpMethod === "GET") {
    let entries = [];
    try {
      entries = (await store.get(KEY, { type: "json" })) || [];
    } catch (e) {
      entries = [];
    }
    const ordered = entries.slice().reverse().slice(0, MAX_RETURNED);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ entries: ordered }),
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
      // Return a normal-looking success so bots don't learn anything, but do not store it.
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    const name = clean(data.name, MAX_NAME) || "Anonymous";
    const station = clean(data.station, MAX_STATION);
    const message = clean(data.message, MAX_MESSAGE);

    if (!message) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Message is required" }) };
    }

    let entries = [];
    try {
      entries = (await store.get(KEY, { type: "json" })) || [];
    } catch (e) {
      entries = [];
    }

    const entry = {
      name,
      station,
      message,
      date: new Date().toISOString().slice(0, 10),
    };

    entries.push(entry);
    if (entries.length > MAX_STORED) entries = entries.slice(entries.length - MAX_STORED);

    try {
      await store.setJSON(KEY, entries);
    } catch (e) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: "Could not save entry" }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, entry }),
    };
  }

  return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
};
