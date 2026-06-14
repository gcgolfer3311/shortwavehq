#!/usr/bin/env python3
"""
ShortwaveHQ Autonomous Updater
==============================
This is the REAL autonomous component. It runs on a schedule (via cron),
independent of whether anyone has the website open. It:

  1. Calls the Anthropic API to get current shortwave schedule intelligence
  2. Writes the result to data/live.json
  3. The website fetches data/live.json on load

Run it manually:   python3 update.py
Run it on schedule: see crontab line in DEPLOY.md

Requires: ANTHROPIC_API_KEY in environment (or a .env file).
"""

import os
import json
import datetime
import urllib.request
import urllib.error
import sys

API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
MODEL = os.environ.get("SHQ_MODEL", "claude-haiku-4-5-20251001")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
OUT_FILE = os.path.join(OUT_DIR, "live.json")

SYSTEM = (
    "You are a shortwave radio schedule analyst with knowledge of the EIBI A-26 "
    "season, HFCC registrations, and the published schedules of WRMI, WWCR, WBCQ, "
    "BBC World Service, Voice of America, Radio Romania International, Radio France "
    "Internationale, China Radio International, and other active 2026 broadcasters. "
    "Return ONLY valid JSON, no prose, no markdown fences."
)

PROMPT = (
    "Produce a concise daily shortwave intelligence briefing as JSON with exactly "
    "these keys:\n"
    '  "headline": a one-sentence summary of notable shortwave activity today,\n'
    '  "highlights": an array of 4-6 short strings, each a notable broadcast worth '
    "tuning (include frequency in kHz and station),\n"
    '  "changes": an array of 0-4 short strings describing any recent schedule '
    "changes, closures, or new services a listener should know,\n"
    '  "propagation_note": one sentence of practical propagation advice for today.\n'
    "Keep every string under 140 characters. Return only the JSON object."
)


def call_api():
    if not API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY is not set in the environment.")
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 700,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": PROMPT}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "content-type": "application/json",
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    # Extract text from the content blocks
    text = ""
    for block in payload.get("content", []):
        if block.get("type") == "text":
            text += block.get("text", "")
    return text.strip()


def parse_json(text):
    # Strip accidental markdown fences if present
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    text = text.strip()
    return json.loads(text)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)
    result = {
        "updated_utc": now.strftime("%Y-%m-%d %H:%M UTC"),
        "updated_iso": now.isoformat(),
        "headline": "",
        "highlights": [],
        "changes": [],
        "propagation_note": "",
        "status": "ok",
    }

    try:
        raw = call_api()
        data = parse_json(raw)
        result["headline"] = str(data.get("headline", ""))[:300]
        result["highlights"] = [str(x)[:200] for x in data.get("highlights", [])][:6]
        result["changes"] = [str(x)[:200] for x in data.get("changes", [])][:4]
        result["propagation_note"] = str(data.get("propagation_note", ""))[:300]
    except Exception as e:
        # On failure, preserve the previous good file if it exists; only
        # write an error status if there is nothing at all.
        result["status"] = "error"
        result["error"] = str(e)
        if os.path.exists(OUT_FILE):
            print("Update failed (%s); keeping previous live.json." % e, file=sys.stderr)
            sys.exit(1)

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print("Wrote %s at %s" % (OUT_FILE, result["updated_utc"]))
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
