#!/usr/bin/env python3
"""
schedule_update.py  —  ShortwaveHQ living-database updater
============================================================
Pulls the current EIBI A-26 shortwave schedule, parses it, filters to
listenable broadcast stations, and writes data/schedule.json in the exact
shape the site's SCH array uses. Run daily by GitHub Actions.

EIBI CSV format (semicolon-separated, 11 fields):
  kHz ; Time(UTC) ; Days ; ITU ; Station ; Lng ; Target ; Remarks ; P ; Start ; Stop

Design choices:
  - Only broadcast bands (2.3–30 MHz) — skips longwave/mediumwave utility.
  - Skips utility/military/navy/coastguard/fax/HFDL/volmet/channel-marker
    traffic (keeps the DB focused on what a listener tunes for).
  - Maps EIBI language + ITU + target codes to the friendly names the site
    already displays, so nothing downstream changes.
  - Falls back cleanly: on any network/parse failure it exits 0 WITHOUT
    overwriting a good existing schedule.json, so a bad fetch never breaks
    the live site.
"""

import os, json, sys, datetime, urllib.request, urllib.error

# Try the A26 file; the season rolls to B26 in late October. Both URLs tried.
EIBI_URLS = [
    "http://eibispace.de/dx/sked-a26.csv",
    "http://www.eibispace.de/dx/sked-a26.csv",
]
OUT = "data/schedule.json"
MIN_MHZ, MAX_MHZ = 2.3, 30.0   # broadcast HF only (coarse pre-filter)

# Real international shortwave BROADCAST band segments (MHz). Everything
# between these — marine, fixed, amateur, utility allocations — is NOT a
# broadcast band even though it falls inside 2.3–30 MHz, and EIBI lists
# plenty of non-broadcast traffic (coast stations, ship channels, etc.)
# in those gaps. Restricting to these segments is what actually keeps
# the database to "what a listener tunes for."
BROADCAST_BANDS = [
    (2.300, 2.495),   # 120m tropical
    (3.200, 3.400),   # 90m tropical
    (3.900, 4.000),   # 75m
    (4.750, 5.060),   # 60m tropical
    (5.900, 6.200),   # 49m
    (7.200, 7.450),   # 41m
    (9.400, 9.900),   # 31m
    (11.600, 12.100), # 25m
    (13.570, 13.870), # 22m
    (15.100, 15.800), # 19m
    (17.480, 17.900), # 16m
    (18.900, 19.020), # 15m
    (21.450, 21.850), # 13m
    (25.670, 26.100), # 11m
]

def in_broadcast_band(mhz):
    return any(lo <= mhz <= hi for lo, hi in BROADCAST_BANDS)

# ── Language codes (EIBI) → friendly names the site displays ──────────────
LANG = {
    "E": "English", "S": "Spanish", "F": "French", "D": "German", "A": "Arabic",
    "P": "Portuguese", "R": "Russian", "M": "Mandarin", "C": "Chinese",
    "J": "Japanese", "K": "Korean", "VN": "Vietnamese", "T": "Thai",
    "HI": "Hindi", "UR": "Urdu", "BE": "Bengali", "TAM": "Tamil", "TB": "Tibetan",
    "UI": "Uyghur", "MO": "Mongolian", "KH": "Khmer", "LAO": "Lao",
    "I": "Italian", "PO": "Polish", "GR": "Greek", "TU": "Turkish",
    "PS": "Pashto", "DR": "Dari", "FS": "Farsi", "SWA": "Swahili", "SW": "Swahili",
    "AH": "Amharic", "OO": "Oromo", "HA": "Hausa", "YO": "Yoruba",
    "NL": "Dutch", "SK": "Slovak", "BU": "Bulgarian", "RO": "Romanian",
    "ARO": "Aromanian", "SR": "Serbian", "UK": "Ukrainian", "AL": "Albanian",
    "BY": "Belarusian", "HR": "Croatian", "SV": "Slovenian", "NE": "Nepali",
    "SD": "Sindhi", "PJ": "Punjabi", "SIR": "Siraiki", "IN": "Indonesian",
    "BR": "Burmese", "TAG": "Tagalog", "MAL": "Malayalam", "TEL": "Telugu",
    "KZ": "Kazakh", "KG": "Kyrgyz", "TK": "Turkmen", "TJ": "Tajik",
    "SHO": "Shona", "Z": "Zulu", "FU": "Fula", "SWE": "Swedish", "FI": "Finnish",
    "NO": "Norwegian", "IS": "Icelandic", "DA": "Danish", "CA": "Cantonese",
    "MO2": "Mongolian", "Q": "Quechua", "AM": "Amoy", "HK": "Hakka",
    "-TS": "Time Signal", "-CW": "Morse/CW", "-TY": "RTTY", "-HF": "HFDL",
    "-MX": "Music", "": "Various",
}

# ── ITU country codes → the site's target/region buckets ──────────────────
REGION_BY_TGT = {
    "NAm": "North America", "ENA": "North America", "WNA": "North America",
    "CNA": "North America", "CAm": "North America", "Car": "North America",
    "USA": "North America", "CUB": "North America", "MEX": "North America",
    "SAm": "South America", "SAM": "South America", "B": "South America",
    "ARG": "South America", "CHL": "South America", "PRU": "South America",
    "BOL": "South America", "CLM": "South America", "VEN": "South America",
    "Eu": "Europe", "WEu": "Europe", "CEu": "Europe", "EEu": "Europe",
    "NEu": "Europe", "SEu": "Europe", "SEE": "Europe", "ROU": "Europe",
    "HNG": "Europe", "BUL": "Europe", "UKR": "Europe", "BLR": "Europe",
    "Af": "Africa", "WAf": "Africa", "EAf": "Africa", "SAf": "Africa",
    "NAf": "Africa", "CAf": "Africa", "NIG": "Africa", "TUN": "Africa",
    "ME": "Middle East", "IRN": "Middle East", "Cau": "Middle East",
    "AFG": "Middle East", "SAs": "Asia", "CAs": "Asia", "SEA": "Asia",
    "FE": "Asia", "Sib": "Asia", "CHN": "Asia", "TWN": "Asia", "MNG": "Asia",
    "KRE": "Asia", "J": "Asia", "INS": "Asia", "PAK": "Asia", "BGD": "Asia",
    "Oc": "Pacific", "SOc": "Pacific", "NOc": "Pacific", "EOc": "Pacific",
    "WOc": "Pacific", "AUS": "Pacific", "NZL": "Pacific", "SLM": "Pacific",
    "VUT": "Pacific", "FIN": "Europe", "HOL": "Europe", "SWZ": "Africa",
}
TGT_NAME = {
    "NAm": "North America", "ENA": "E. North America", "WNA": "W. North America",
    "CNA": "C. North America", "CAm": "Central America", "Car": "Caribbean",
    "SAm": "South America", "Eu": "Europe", "WEu": "W. Europe", "CEu": "C. Europe",
    "EEu": "E. Europe", "NEu": "N. Europe", "SEu": "S. Europe", "SEE": "SE Europe",
    "Af": "Africa", "WAf": "W. Africa", "EAf": "E. Africa", "SAf": "S. Africa",
    "NAf": "N. Africa", "ME": "Middle East", "IRN": "Iran", "AFG": "Afghanistan",
    "SAs": "South Asia", "CAs": "Central Asia", "SEA": "SE Asia", "FE": "Far East",
    "Sib": "Siberia", "Oc": "Pacific", "AUS": "Australia", "NZL": "New Zealand",
    "Cau": "Caucasus", "CHN": "China", "TWN": "Taiwan", "KRE": "Korea",
}

# ITU → ISO-ish full country (only those that appear as broadcasters we keep)
COUNTRY = {
    "USA": "USA", "G": "UK", "D": "Germany", "F": "France", "CHN": "China",
    "ROU": "Romania", "J": "Japan", "KOR": "South Korea", "KRE": "North Korea",
    "TWN": "Taiwan", "IND": "India", "CUB": "Cuba", "EQA": "Ecuador",
    "TUR": "Turkey", "VTN": "Vietnam", "INS": "Indonesia", "AUS": "Australia",
    "NZL": "New Zealand", "E": "Spain", "NIG": "Nigeria", "MLI": "Mali",
    "SWZ": "Eswatini", "MDG": "Madagascar", "CZE": "Czechia", "SVK": "Slovakia",
    "POL": "Poland", "BUL": "Bulgaria", "HNG": "Hungary", "UKR": "Ukraine",
    "BLR": "Belarus", "RUS": "Russia", "PHL": "Philippines", "THA": "Thailand",
    "MYA": "Myanmar", "SLM": "Solomon Is.", "VUT": "Vanuatu", "PRU": "Peru",
    "BOL": "Bolivia", "B": "Brazil", "CLM": "Colombia", "CLN": "Sri Lanka",
    "HKG": "Hong Kong", "GRC": "Greece", "ALG": "Algeria", "TUN": "Tunisia",
    "IRN": "Iran", "ETH": "Ethiopia", "SOM": "Somalia", "LBR": "Liberia",
    "SEN": "Senegal", "VAT": "Vatican", "HOL": "Netherlands", "FIN": "Finland",
    "DNK": "Denmark", "CAN": "Canada", "MRA": "N. Marianas", "OMA": "Oman",
    "UAE": "UAE", "KWT": "Kuwait", "SWE": "Sweden", "CLA": "Clandestine",
}

# ── Type inference ─────────────────────────────────────────────────────────
NUMBERS_HINTS = ("Spy Numbers", "Numbers", "Buzzer", "Channel Marker",
                 "Squeaky Wheel", "The Pip", "Goose", "Baron", "Alarm")
UTIL_HINTS = ("Volmet", "Coastguard", "Coast Guard", "Navy", "Radio Fax",
              "Meteo", "Met Fax", "HFDL", "USCG", "Aeradio", "Maritime",
              "US Air Force", "Air Force", "Teleswitch", "Time from",
              "Propag", "Fish", "SELCAL", "Search and Rescue", "US Navy")
PIRATE_HINTS = ("Pirate", "Mi Amigo", "Casanova", "Delta Int", "Europe 2",
                "Free Radio", "SuperClan", "Northern Star", "Mission",
                "Shortwave Radio", "Radio Gold", "Radio 60", "Studio 52")
TIME_HINTS = ("WWV", "WWVH", "BPM", "RWM", "CHU", "HLA", "Time Signal")

def infer_type(station, lang_code):
    s = station
    if any(h in s for h in TIME_HINTS) or lang_code == "-TS":
        return "Time"
    if any(h in s for h in NUMBERS_HINTS):
        return "Numbers"
    if any(h in s for h in UTIL_HINTS) or lang_code in ("-CW", "-TY", "-HF"):
        return "Utility"
    if any(h in s for h in PIRATE_HINTS):
        return "Pirate"
    return "International"

def hhmm_to_min(t):
    try:
        h, m = int(t[:2]), int(t[2:4])
        v = h * 60 + m
        return 1440 if v == 0 and t == "2400" else v
    except Exception:
        return None

def parse_time(field):
    # "1500-1530" -> (900, 930).  "0000-2400" -> (0,1440)
    if "-" not in field:
        return None, None
    a, b = field.split("-", 1)
    s = hhmm_to_min(a)
    e = hhmm_to_min(b)
    if b == "2400":
        e = 1440
    return s, e

def clean_station(name):
    # EIBI uses some abbreviations; expand common ones for display.
    # Word-boundary aware so "BBC" isn't mangled into "BBroadcasting".
    import re
    out = name.strip()
    out = re.sub(r"\bR\.", "Radio ", out)
    out = re.sub(r"\bInt\.", "International", out)
    out = re.sub(r"\bSce\b", "Service", out)
    out = re.sub(r"\bB\.C\.", "Broadcasting", out)
    out = re.sub(r"\s+", " ", out)
    return out.strip()

def lang_name(code):
    code = (code or "").strip()
    if code in LANG:
        return LANG[code]
    # take first token of composite like "A,F" or "E/S"
    for sep in (",", "/"):
        if sep in code:
            first = code.split(sep)[0].strip()
            if first in LANG:
                return LANG[first]
    return code if code else "Various"

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ShortwaveHQ-updater/1.0"})
    with urllib.request.urlopen(req, timeout=45) as r:
        raw = r.read()
    # EIBI is latin-1
    return raw.decode("latin-1")

def build():
    text = None
    for u in EIBI_URLS:
        try:
            text = fetch(u)
            if text and ";" in text:
                print(f"Fetched {u} ({len(text)} bytes)")
                break
        except Exception as e:
            print(f"Fetch failed {u}: {e}")
    if not text:
        return None

    rows = []
    seen = set()
    for line in text.splitlines():
        if ";" not in line:
            continue
        parts = line.split(";")
        if len(parts) < 8:
            continue
        # header line starts with "kHz:"
        if parts[0].startswith("kHz"):
            continue
        try:
            khz = float(parts[0])
        except ValueError:
            continue
        mhz = khz / 1000.0
        if mhz < MIN_MHZ or mhz > MAX_MHZ:
            continue

        s, e = parse_time(parts[1])
        if s is None or e is None:
            continue

        itu = parts[3].strip()
        station = clean_station(parts[4])
        lang_code = parts[5].strip()
        tgt_code = parts[6].strip()

        typ = infer_type(station, lang_code)
        # Keep only listenable content — drop pure utility/CW/RTTY/HFDL noise
        if typ == "Utility":
            continue
        if not station:
            continue
        # Drop anything outside a real broadcast band segment — EIBI's raw
        # 2.3–30 MHz range also includes marine coast, fixed, and other
        # non-broadcast allocations that would otherwise flood search
        # results with irrelevant stations. Time signals (WWV/CHU/etc.)
        # legitimately sit outside these bands, so they're exempted.
        if typ != "Time" and not in_broadcast_band(mhz):
            continue

        reg = REGION_BY_TGT.get(tgt_code, "Worldwide")
        # target label: friendly name, else country name, else Worldwide
        if tgt_code in TGT_NAME:
            tgt = TGT_NAME[tgt_code]
        elif tgt_code in COUNTRY:
            tgt = COUNTRY[tgt_code]
        elif not tgt_code:
            tgt = "Worldwide"
        else:
            tgt = tgt_code
        lang = lang_name(lang_code)

        freq_str = f"{mhz:.3f}"
        # Deduplicate identical freq+station+start
        key = (freq_str, station, s)
        if key in seen:
            continue
        seen.add(key)

        rows.append({
            "freq": freq_str,
            "stn": station,
            "lang": lang,
            "s": s,
            "e": e,
            "tgt": tgt,
            "type": typ,
            "reg": reg,
            "kw": 0,          # EIBI CSV has no power column; site treats 0 as unknown
            "site": COUNTRY.get(itu, itu) or "Unknown",
        })

    # Sort by frequency then start time for stable diffs
    rows.sort(key=lambda r: (float(r["freq"]), r["s"]))
    return rows

def main():
    rows = build()
    if not rows or len(rows) < 200:
        # Guardrail: never overwrite a good file with a suspiciously small parse
        print(f"Parse produced {len(rows) if rows else 0} rows — refusing to overwrite. Keeping existing schedule.json.")
        sys.exit(0)

    now = datetime.datetime.utcnow()
    payload = {
        "updated_utc": now.strftime("%Y-%m-%d %H:%M UTC"),
        "source": "EIBI A-26",
        "count": len(rows),
        "sch": rows,
    }
    os.makedirs("data", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {OUT}: {len(rows)} stations from EIBI A-26")

if __name__ == "__main__":
    main()
    sys.exit(0)
