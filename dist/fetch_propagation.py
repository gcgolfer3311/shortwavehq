"""
Fetches live space-weather numbers from NOAA SWPC and writes data/propagation.json.

Rules (so the site never shows made-up numbers):
  * Every value comes from NOAA. There are NO hardcoded fallback values.
  * If the solar flux cannot be read, nothing is written (the last good file is kept
    and the site flags it as stale once it is old). The script never fails the build.
  * "live": true marks a file written by this script from real NOAA data. The site
    ignores any propagation.json without it (older versions wrote fake defaults).
"""
import json, re, os, sys, datetime, urllib.request

NOAA = "https://services.swpc.noaa.gov/"
UA = {"User-Agent": "ShortwaveHQ/1.0 (+https://hqshortwaveradio.com)"}


def _get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8")


def fetch_json(path):
    try:
        return json.loads(_get(NOAA + path))
    except Exception as e:
        print(f"  WARN fetch {path}: {e}")
        return None


def fetch_text(path):
    try:
        return _get(NOAA + path)
    except Exception as e:
        print(f"  WARN fetch {path}: {e}")
        return None


def parse_flux(summary):
    """products/summary/10cm-flux.json -> [{"flux":93,...}] (older/other shape: {"Flux":"93"})."""
    row = summary[0] if isinstance(summary, list) and summary else summary
    if not isinstance(row, dict):
        return None
    for key in ("flux", "Flux"):
        if key in row:
            try:
                v = float(row[key])
                if 40 <= v <= 400:
                    return int(round(v))
            except (TypeError, ValueError):
                pass
    return None


def parse_kp(rows):
    """noaa-planetary-k-index.json -> rows are objects (Kp, a_running) or arrays [time, Kp, a_running, ...]."""
    if not isinstance(rows, list):
        return None, None
    for row in reversed(rows):
        try:
            if isinstance(row, dict):
                kp, a = float(row["Kp"]), row.get("a_running")
            elif isinstance(row, list):
                kp, a = float(row[1]), (row[2] if len(row) > 2 else None)
            else:
                continue
        except (KeyError, TypeError, ValueError, IndexError):
            continue
        if 0 <= kp <= 9:
            try:
                a = int(round(float(a))) if a is not None and float(a) >= 0 else None
            except (TypeError, ValueError):
                a = None
            return int(round(kp)), a
    return None, None


def parse_dsd(text):
    """text/daily-solar-indices.txt -> list of (flux, sunspot_number), oldest first."""
    out = []
    for line in (text or "").splitlines():
        if re.match(r"^\d{4} \d{2} \d{2}\s", line):
            p = line.split()
            try:
                flux, ssn = int(float(p[3])), int(p[4])
            except (IndexError, ValueError):
                continue
            out.append((flux if flux > 0 else None, ssn if ssn >= 0 else None))
    return out


BD = [
    {"n": "120M", "r": "2.3-2.5", "bd": 8, "bn": 22}, {"n": "90M", "r": "3.2-3.4", "bd": 12, "bn": 30},
    {"n": "75M", "r": "3.9-4.0", "bd": 18, "bn": 42}, {"n": "60M", "r": "4.7-5.0", "bd": 25, "bn": 55},
    {"n": "49M", "r": "5.9-6.2", "bd": 35, "bn": 68}, {"n": "41M", "r": "7.3-7.4", "bd": 45, "bn": 72},
    {"n": "31M", "r": "9.4-9.9", "bd": 62, "bn": 58}, {"n": "25M", "r": "11.6-12.1", "bd": 70, "bn": 42},
    {"n": "22M", "r": "13.5-13.8", "bd": 72, "bn": 28}, {"n": "19M", "r": "15.1-15.8", "bd": 75, "bn": 22},
    {"n": "16M", "r": "17.5-17.9", "bd": 65, "bn": 15}, {"n": "13M", "r": "21.4-21.8", "bd": 55, "bn": 10},
]


def bands_for(sfi, kp, night):
    out = []
    for b in BD:
        base = b["bn"] if night else b["bd"]
        sf = (sfi - 100) / 5.0
        kpen = (kp - 4) * 8 if kp is not None and kp > 4 else 0
        p = min(100, max(3, round(base + sf - kpen)))
        cond = "Excellent" if p >= 72 else "Good" if p >= 52 else "Fair" if p >= 32 else "Poor"
        out.append({"n": b["n"], "r": b["r"], "p": p, "cond": cond})
    return out


def main():
    dsd = parse_dsd(fetch_text("text/daily-solar-indices.txt"))
    sfi = parse_flux(fetch_json("products/summary/10cm-flux.json"))
    if sfi is None and dsd and dsd[-1][0]:
        sfi = dsd[-1][0]  # same number, from the daily indices file
    kp, a_index = parse_kp(fetch_json("products/noaa-planetary-k-index.json"))
    ssn = dsd[-1][1] if dsd else None
    hist = [f for f, _ in dsd if f][-24:]
    if sfi is None or kp is None:
        print("ERROR: NOAA flux/K unavailable (sfi=%s kp=%s); keeping existing data/propagation.json untouched" % (sfi, kp))
        return
    if not hist:
        hist = [sfi]
    hist[-1] = sfi
    now = datetime.datetime.now(datetime.timezone.utc)
    night = now.hour < 6 or now.hour > 20
    out = {
        "live": True,
        "sfi": sfi,
        "k": kp,
        "sfi_history": hist,
        "bands": bands_for(sfi, kp, night),
        "night": night,
        "updated_utc": now.strftime("%Y-%m-%d %H:%M"),
        "source": "NOAA SWPC",
    }
    if a_index is not None:
        out["a"] = a_index
    if ssn is not None:
        out["ssn"] = ssn
    os.makedirs("data", exist_ok=True)
    with open("data/propagation.json", "w") as f:
        json.dump(out, f)
    print(f"propagation.json: SFI={sfi} K={kp} A={a_index} SSN={ssn} history={len(hist)}pts night={night}")


if __name__ == "__main__":
    main()
