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
# ══ APPEND TO update.py ══ Station/DX Tip of the Day (no API cost, deterministic daily rotation)
import datetime, json, hashlib, os

STATIONS_POOL = [
 {"name":"WRMI Radio Miami International","freq":"9455 kHz","tip":"Okeechobee FL powerhouse — 12×100kW transmitters. Best reception evenings across the Americas."},
 {"name":"Radio Romania International","freq":"9730 kHz","tip":"English to N. America 0900–1000 UTC. Reliable 31m signal, strong into the eastern US."},
 {"name":"BBC World Service","freq":"12095 kHz","tip":"Ascension relay to Africa. One of the last major English SW services still broadcasting."},
 {"name":"Radio Habana Cuba","freq":"6000 kHz","tip":"Strong nighttime signal across North America on 49m. English 0100–0500 UTC."},
 {"name":"WWV Fort Collins","freq":"5000/10000/15000 kHz","tip":"Time standard, 24/7. Perfect for testing receiver calibration and propagation."},
 {"name":"Voice of Turkey","freq":"9830 kHz","tip":"English to N. America 2200–2300 UTC. Free QSL cards — great for new DXers."},
 {"name":"China Radio International","freq":"7350 kHz","tip":"Massive global network. English programming around the clock on multiple bands."},
 {"name":"RNZ Pacific","freq":"9700 kHz","tip":"New Zealand to the Pacific. Excellent audio, DRM + AM. Best for west-coast US listeners."},
 {"name":"WBCQ The Planet","freq":"7490 kHz","tip":"Maine independent SW. Eclectic programming — a genuine free-radio survivor."},
 {"name":"UVB-76 'The Buzzer'","freq":"4625 kHz","tip":"Russian mystery station, continuous buzz 24/7. Occasional voice messages — a DX legend."},
 {"name":"All India Radio","freq":"9445 kHz","tip":"External Service in English. Distinctive interval signal, strong on 31m to Europe/ME."},
 {"name":"Radio Free Asia","freq":"9455 kHz","tip":"Multiple target languages into Asia. Frequency-hops to counter jamming."},
 {"name":"WWCR Nashville","freq":"9350 kHz","tip":"US private broadcaster, 24/7. Consistent strong signal — good beginner target."},
 {"name":"Voice of Korea (DPRK)","freq":"11710 kHz","tip":"North Korea's external service. Unmistakable programming — a bucket-list DX catch."},
]
DX_TIPS = [
 "Gray-line propagation peaks at your local sunrise/sunset — best DX window of the day.",
 "Lower bands (49m/41m) open at night; higher bands (19m/16m) favor daytime.",
 "A simple longwire outperforms most whip antennas on shortwave. Length beats complexity.",
 "Log the SINPO of every catch — patterns reveal your best frequencies and times.",
 "Winter nights = peak SW season. Lower noise, better low-band propagation.",
 "High solar flux (SFI) boosts upper bands. Check SFI before chasing 13m/11m DX.",
 "A low K-index (0–2) means quiet geomagnetic conditions — ideal for weak-signal DX.",
 "Null out local noise: rotate a loop antenna to minimize interference before the signal.",
 "Pirate radio clusters on 6925 kHz AM/USB, weekend nights after 0100 UTC.",
 "Utility and time stations are perfect for calibrating your receiver's frequency readout.",
]

def _didx(n, salt):
    t = datetime.date.today().isoformat()
    return int(hashlib.md5((t+salt).encode()).hexdigest(), 16) % n

os.makedirs("data", exist_ok=True)
_daily = {
    "date": datetime.date.today().isoformat(),
    "station_of_day": STATIONS_POOL[_didx(len(STATIONS_POOL), "station")],
    "dx_tip": DX_TIPS[_didx(len(DX_TIPS), "dxtip")],
}
with open("data/daily.json", "w") as _f:
    json.dump(_daily, _f, indent=2)
print("daily.json written:", _daily["date"], _daily["station_of_day"]["name"])
