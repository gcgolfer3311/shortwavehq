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

HFCC cross-validation (optional, additive):
  If data/hfcc_schedule.txt and data/hfcc_sites.txt are present, each row
  is checked against HFCC's international frequency coordination data by
  frequency + time-window overlap. A match fills in real transmit power
  (kw) and real transmitter coordinates (lat/lon) — EIBI carries neither
  — and sets "hfcc": true, which the site shows as a second verified-badge
  tier. No match just leaves the row exactly as it's always looked (kw: 0,
  no coordinates) — this can never make an existing row worse.
  These two files are NOT auto-fetched (HFCC has no stable public direct-
  download URL the way EIBI does) — download the current season's files
  by hand from hfcc.org → Public Data Files, and re-upload them to
  data/hfcc_schedule.txt / data/hfcc_sites.txt each new A/B season
  (same twice-yearly cadence as EIBI's own A26/B26 switch).
"""

import os, json, sys, re, datetime, urllib.request, urllib.error

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
    (2.300, 2.500),   # 120m tropical
    (3.150, 3.500),   # 90m tropical (widened — some stations sit just outside)
    (3.850, 4.050),   # 75m (widened for edge broadcasters)
    (4.700, 5.100),   # 60m tropical (widened)
    (5.800, 6.300),   # 49m (widened — catches edge stations)
    (6.800, 7.000),   # Pirate/unofficial allocation around 6.9 MHz
    (7.100, 7.500),   # 41m (widened)
    (9.300, 10.000),  # 31m (widened — WRMI uses 9.395 and 9.955)
    (11.550, 12.150), # 25m (widened)
    (13.550, 13.900), # 22m (widened)
    (15.050, 15.850), # 19m (widened)
    (17.450, 17.950), # 16m (widened)
    (18.850, 19.050), # 15m (widened)
    (21.400, 21.900), # 13m (widened)
    (25.600, 26.100), # 11m
]

def in_broadcast_band(mhz):
    return any(lo <= mhz <= hi for lo, hi in BROADCAST_BANDS)

# ── HFCC cross-validation ───────────────────────────────────────────────
# HFCC/ASBU publishes the international frequency-coordination schedule
# used by major broadcasters — a second, independent source from EIBI's
# community-maintained "as heard/as reported" database. Cross-checking
# against it lets us show real transmit power and real transmitter
# coordinates (EIBI carries neither), and mark entries that two
# independent sources agree on.
#
# HFCC does NOT auto-publish a stable public download URL the way EIBI
# does, and its season files (A/B, same cadence as EIBI's A26/B26) need
# a manual visit to hfcc.org's Public Data Files page. So these two
# files are committed to the repo by hand each season, not fetched here:
#   data/hfcc_schedule.txt  — the raw "A26all00.TXT"-style season file
#   data/hfcc_sites.txt     — the raw "site.txt" transmitter site table
# If either file is missing, cross-validation is silently skipped and
# every row falls back to today's behavior (kw: 0, no coordinates) —
# this can never break a deploy.
HFCC_SCHEDULE_FILE = "data/hfcc_schedule.txt"
HFCC_SITES_FILE = "data/hfcc_sites.txt"

def _hfcc_hhmm_to_min(s):
    s = s.strip()
    if len(s) != 4 or not s.isdigit():
        return None
    return int(s[:2]) * 60 + int(s[2:])

def _parse_hfcc_sites(path):
    sites = {}
    try:
        with open(path, "r", encoding="latin-1") as f:
            for line in f:
                line = line.rstrip("\r\n")
                if not line.strip() or line.startswith(";"):
                    continue
                code = line[0:3].strip()
                lat_raw = line[38:44].strip()
                lon_raw = line[44:51].strip()
                m = re.match(r"(\d+)([NS])(\d+)", lat_raw)
                m2 = re.match(r"(\d+)([EW])(\d+)", lon_raw)
                if not (code and m and m2):
                    continue
                lat = float(m.group(1)) + float(m.group(3)) / 60
                if m.group(2) == "S":
                    lat = -lat
                lon = float(m2.group(1)) + float(m2.group(3)) / 60
                if m2.group(2) == "W":
                    lon = -lon
                sites[code] = (round(lat, 3), round(lon, 3))
    except Exception:
        return {}
    return sites

def _parse_hfcc_schedule(path, sites):
    # Column boundaries read from the file's own ruler line at build time
    # (HFCC has changed column layout before — e.g. adding SLW/ANT/AFRQ
    # columns between the A06 and A26 seasons — so this locates the ruler
    # itself rather than hardcoding positions that could silently drift).
    from collections import defaultdict
    by_freq = defaultdict(list)
    try:
        with open(path, "r", encoding="latin-1") as f:
            lines = f.readlines()
    except Exception:
        return by_freq

    ruler = None
    for line in lines:
        if line.startswith(";----"):
            ruler = line.rstrip("\r\n")
            break
    if not ruler:
        return by_freq
    bounds = [0] + [i for i, c in enumerate(ruler) if c == "+"]

    def col(line, idx):
        if idx + 1 >= len(bounds):
            return ""
        return line[bounds[idx]:bounds[idx + 1]].strip()

    for line in lines:
        line = line.rstrip("\r\n")
        if not line.strip() or line.startswith(";"):
            continue
        freq = col(line, 0)
        if not freq or not freq.replace(".", "").isdigit():
            continue
        strt_min = _hfcc_hhmm_to_min(col(line, 1))
        stop_min = _hfcc_hhmm_to_min(col(line, 2))
        if strt_min is None or stop_min is None:
            continue
        loc = col(line, 4)
        powr = col(line, 5)
        lat, lon = sites.get(loc, (None, None))
        by_freq[round(float(freq))].append({
            "start": strt_min, "stop": stop_min,
            "kw": float(powr) if powr.replace(".", "").isdigit() else None,
            "lat": lat, "lon": lon,
        })
    return by_freq

def _time_overlaps(a_start, a_end, b_start, b_end):
    def segments(s, e):
        return [(s, e)] if s <= e else [(s, 1440), (0, e)]
    for s1, e1 in segments(a_start, a_end):
        for s2, e2 in segments(b_start, b_end):
            if s1 < e2 and s2 < e1:
                return True
    return False

def load_hfcc_index():
    """Returns a freq(kHz, rounded) -> [candidate records] index, or an
    empty dict if HFCC data isn't present — callers treat that as
    'no cross-validation this run', never as an error."""
    if not (os.path.exists(HFCC_SCHEDULE_FILE) and os.path.exists(HFCC_SITES_FILE)):
        return {}
    sites = _parse_hfcc_sites(HFCC_SITES_FILE)
    if not sites:
        return {}
    return _parse_hfcc_schedule(HFCC_SCHEDULE_FILE, sites)

def hfcc_match(hfcc_index, freq_mhz, s_min, e_min):
    """Looks for an HFCC record at this frequency whose time window
    overlaps [s_min, e_min). Returns (kw, lat, lon) or (None, None, None)."""
    if not hfcc_index:
        return None, None, None
    candidates = hfcc_index.get(round(freq_mhz * 1000), [])
    for c in candidates:
        if _time_overlaps(s_min, e_min, c["start"], c["stop"]):
            return c["kw"], c["lat"], c["lon"]
    return None, None, None

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

    hfcc_index = load_hfcc_index()
    hfcc_matched = 0

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

        hfcc_kw, hfcc_lat, hfcc_lon = hfcc_match(hfcc_index, mhz, s, e)
        row = {
            "freq": freq_str,
            "stn": station,
            "lang": lang,
            "s": s,
            "e": e,
            "tgt": tgt,
            "type": typ,
            "reg": reg,
            "kw": hfcc_kw if hfcc_kw is not None else 0,   # real HFCC power when cross-verified, else unknown
            "site": COUNTRY.get(itu, itu) or "Unknown",
        }
        if hfcc_kw is not None:
            hfcc_matched += 1
            row["hfcc"] = True
            if hfcc_lat is not None and hfcc_lon is not None:
                row["lat"] = hfcc_lat
                row["lon"] = hfcc_lon
        rows.append(row)

    # Sort by frequency then start time for stable diffs
    rows.sort(key=lambda r: (float(r["freq"]), r["s"]))
    if hfcc_index:
        print(f"HFCC cross-validation: {hfcc_matched}/{len(rows)} rows matched "
              f"({100*hfcc_matched/len(rows):.1f}%) — real power/coordinates applied")
    else:
        print("HFCC cross-validation: no HFCC data files present, skipped (kw stays 0 as before)")
    return rows

# ── Schedule-change tracking ────────────────────────────────────────────
# Real, dated history of what actually changed run-to-run — a station
# added, dropped, or moved frequency. No fabricated/backfilled history:
# this only ever records genuine diffs starting from whenever it first runs.
CHANGELOG = "data/schedule-changes.json"
MAX_LOG_DAYS = 90  # keep roughly 3 months of update-day entries

def load_previous_rows():
    try:
        with open(OUT, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d.get("sch", []) or []
    except Exception:
        return []

def diff_changes(old_rows, new_rows):
    old_by_stn = {}
    for r in old_rows:
        old_by_stn.setdefault(r["stn"], set()).add(r["freq"])
    new_by_stn = {}
    for r in new_rows:
        new_by_stn.setdefault(r["stn"], set()).add(r["freq"])

    old_set, new_set = set(old_by_stn), set(new_by_stn)
    changes = []

    for stn in sorted(new_set - old_set):
        freqs = sorted(new_by_stn[stn])
        detail = f"{stn} appeared in the schedule"
        detail += f" on {freqs[0]} MHz" if len(freqs) == 1 else f" on {len(freqs)} frequencies"
        changes.append({"type": "added", "stn": stn, "detail": detail})

    for stn in sorted(old_set - new_set):
        changes.append({"type": "removed", "stn": stn, "detail": f"{stn} no longer appears in the schedule"})

    # Frequency moves: only flag the unambiguous case — a station that had
    # exactly one frequency before and exactly one now, and they differ.
    # Stations with multiple simultaneous frequencies are skipped rather
    # than guessed at, to avoid a false "moved" claim.
    for stn in sorted(old_set & new_set):
        of, nf = old_by_stn[stn], new_by_stn[stn]
        if len(of) == 1 and len(nf) == 1 and of != nf:
            o, n = list(of)[0], list(nf)[0]
            changes.append({"type": "freq_change", "stn": stn, "old_freq": o, "new_freq": n,
                             "detail": f"{stn} moved from {o} MHz to {n} MHz"})

    return changes

def update_changelog(changes, updated_utc):
    if not changes:
        return
    try:
        with open(CHANGELOG, "r", encoding="utf-8") as f:
            log = json.load(f)
    except Exception:
        log = {"entries": []}
    log.setdefault("entries", [])
    log["entries"].insert(0, {"date": updated_utc, "changes": changes})
    log["entries"] = log["entries"][:MAX_LOG_DAYS]
    with open(CHANGELOG, "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Logged {len(changes)} schedule change(s) to {CHANGELOG}")

def main():
    old_rows = load_previous_rows()
    rows = build()
    if not rows or len(rows) < 200:
        # Guardrail: never overwrite a good file with a suspiciously small parse
        print(f"Parse produced {len(rows) if rows else 0} rows — refusing to overwrite. Keeping existing schedule.json.")
        sys.exit(0)

    now = datetime.datetime.utcnow()
    updated_utc = now.strftime("%Y-%m-%d %H:%M UTC")

    # Diff against what was live before this run — real history only,
    # never fabricated. First-ever run will show no changes (nothing to
    # diff against yet), which is correct.
    if old_rows:
        changes = diff_changes(old_rows, rows)
        update_changelog(changes, updated_utc)

    hfcc_count = sum(1 for r in rows if r.get("hfcc"))
    payload = {
        "updated_utc": updated_utc,
        "source": "EIBI A-26",
        "count": len(rows),
        "hfcc_verified_count": hfcc_count,   # 0 if HFCC files aren't present this run
        "sch": rows,
    }
    os.makedirs("data", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {OUT}: {len(rows)} stations from EIBI A-26")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Never let an unexpected error fail the Action — log it and keep
        # the existing schedule.json untouched, exactly like a bad fetch.
        import traceback
        print(f"Unexpected error: {e}")
        traceback.print_exc()
    sys.exit(0)
