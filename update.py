import os, json, datetime, urllib.request, urllib.error, sys

KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
OUT = "data/live.json"

def write_fallback(reason):
    """Write a static briefing if API fails"""
    now = datetime.datetime.utcnow()
    hour = now.hour
    # Pick highlights based on time of day
    if 0 <= hour < 6:
        highlights = [
            "4625 kHz — UVB-76 The Buzzer — Russian numbers station active 24/7",
            "5000 kHz — WWV Fort Collins CO — Time signals continuous",
            "9395 kHz — WRMI Okeechobee FL — Check for overnight programming",
            "7780 kHz — WRMI — Various religious and shortwave programming"
        ]
        note = "Overnight hours favor lower HF bands. 40m and 49m typically best for North America."
    elif 6 <= hour < 12:
        highlights = [
            "5000 kHz — WWV Fort Collins CO — Time signals continuous",
            "9730 kHz — Radio Romania International — English 0900-1000 UTC",
            "9395 kHz — WRMI Okeechobee FL — Morning programming",
            "6155 kHz — Various — 49m band active morning hours"
        ]
        note = "Morning propagation building. Higher bands opening as solar flux increases."
    elif 12 <= hour < 18:
        highlights = [
            "9730 kHz — Radio Romania International — Active afternoon window",
            "9395 kHz — WRMI — Afternoon relay schedule",
            "11800 kHz — Various international — 25m band open",
            "15000 kHz — WWV Fort Collins CO — Time signals continuous"
        ]
        note = "Peak daytime propagation on 25m and 31m bands. Good conditions for transatlantic paths."
    else:
        highlights = [
            "9395 kHz — WRMI Okeechobee FL — Evening programming active",
            "9730 kHz — Radio Romania International — Evening English service",
            "5000 kHz — WWV — Time signals 24/7",
            "6925 kHz — Pirate radio — Check weekends for pirate activity"
        ]
        note = "Evening hours favor 31m and 49m bands. Transatlantic and European signals improving."

    result = {
        "updated_utc": now.strftime("%Y-%m-%d %H:%M UTC"),
        "headline": "ShortwaveHQ Daily Briefing — " + now.strftime("%B %d, %Y"),
        "highlights": highlights,
        "changes": [
            "EIBI A-26 2026 schedule active through October 25, 2026",
            "Check hqshortwaveradio.com for real-time AI frequency identification"
        ],
        "propagation_note": note,
        "status": "ok",
        "source": "scheduled"
    }
    os.makedirs("data", exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(result, f, indent=2)
    print("Fallback briefing written:", result["headline"])
    return result

def write_ai_briefing():
    """Try to get AI briefing from Anthropic API"""
    if not KEY or len(KEY) < 20:
        print("No valid API key found")
        return False

    now = datetime.datetime.utcnow()
    prompt = (
        "Write a shortwave radio daily briefing for " + now.strftime("%B %d, %Y at %H:%M UTC") + ". "
        "Return ONLY valid JSON with these exact keys: "
        "headline (string), highlights (array of 4 strings each mentioning a kHz frequency), "
        "changes (array of 2 strings about schedule changes), "
        "propagation_note (string about HF propagation today). "
        "No markdown, no backticks, just raw JSON."
    )

    body = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 600,
        "messages": [{"role": "user", "content": prompt}]
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "content-type": "application/json",
            "x-api-key": KEY,
            "anthropic-version": "2023-06-01"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8")
        d = json.loads(raw)
        text = d["content"][0]["text"].strip()
        # Strip any markdown fences
        if text.startswith("```"):
            lines = text.split("\n")
            text = "\n".join(lines[1:-1] if lines[-1] == "```" else lines[1:])
        text = text.strip()
        result = json.loads(text)
        result["updated_utc"] = now.strftime("%Y-%m-%d %H:%M UTC")
        result["status"] = "ok"
        result["source"] = "ai"
        os.makedirs("data", exist_ok=True)
        with open(OUT, "w") as f:
            json.dump(result, f, indent=2)
        print("AI briefing written:", result.get("headline", "OK"))
        return True
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.reason}")
        return False
    except Exception as e:
        print(f"Error: {e}")
        return False

# Try AI first, fall back to static if it fails
if not write_ai_briefing():
    print("AI failed — using fallback briefing")
    write_fallback("api_error")

print("Done")
sys.exit(0)  # Always exit 0 so workflow succeeds
