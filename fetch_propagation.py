import json, urllib.request, datetime, os

def fetch(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'ShortwaveHQ/1.0 (+https://hqshortwaveradio.com)'})
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception as e:
        print(f"  WARN fetch {url}: {e}")
        return None

# Solar Flux Index
sfi = 128
sfi_summary = fetch("https://services.swpc.noaa.gov/products/summary/10cm-flux.json")
if sfi_summary and "Flux" in sfi_summary:
    try: sfi = int(float(sfi_summary["Flux"]))
    except: pass

# Kp + A-index (same endpoint)
kp = 2
a_index = 7
kp_data = fetch("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json")
if kp_data and len(kp_data) > 2:
    for row in reversed(kp_data[1:]):
        try:
            kp_val = float(row[1])
            if kp_val >= 0:
                kp = int(kp_val)
                break
        except:
            continue
    try:
        a_val = float(kp_data[-1][3])
        if a_val >= 0:
            a_index = int(round(a_val))
    except:
        a_index = kp * 3

# Sunspot Number
ssn = 87
ssn_data = fetch("https://services.swpc.noaa.gov/products/summary/solar-geophysical-activity.json")
if ssn_data:
    for key in ("SunspotNumber", "Sunspot_Number", "ssn", "ISN"):
        if key in ssn_data:
            try: ssn = int(float(ssn_data[key])); break
            except: pass
    else:
        import re
        for key in ("Report", "Text", "Summary"):
            if key in ssn_data:
                m = re.search(r'sunspot.*?(\d+)', str(ssn_data[key]), re.I)
                if m:
                    try: ssn = int(m.group(1)); break
                    except: pass

# SFI 24-hour history for sparkline
sfi_history = []
hist_data = fetch("https://services.swpc.noaa.gov/products/10cm-flux.json")
if hist_data and len(hist_data) > 2:
    for row in hist_data[1:]:
        try:
            val = int(float(row[1]))
            if 50 <= val <= 300:
                sfi_history.append(val)
        except:
            continue
    sfi_history = sfi_history[-24:]
if not sfi_history:
    sfi_history = [sfi]

# Band condition precompute
hour_utc = datetime.datetime.now(datetime.timezone.utc).hour
night = (hour_utc < 6 or hour_utc > 20)
BD = [
    {"n":"120M","r":"2.3-2.5","bd":8,"bn":22},
    {"n":"90M","r":"3.2-3.4","bd":12,"bn":30},
    {"n":"75M","r":"3.9-4.0","bd":18,"bn":42},
    {"n":"60M","r":"4.7-5.0","bd":25,"bn":55},
    {"n":"49M","r":"5.9-6.2","bd":35,"bn":68},
    {"n":"41M","r":"7.3-7.4","bd":45,"bn":72},
    {"n":"31M","r":"9.4-9.9","bd":62,"bn":58},
    {"n":"25M","r":"11.6-12.1","bd":70,"bn":42},
    {"n":"22M","r":"13.5-13.8","bd":72,"bn":28},
    {"n":"19M","r":"15.1-15.8","bd":75,"bn":22},
    {"n":"16M","r":"17.5-17.9","bd":65,"bn":15},
    {"n":"13M","r":"21.4-21.8","bd":55,"bn":10},
]
bands_now = []
for b in BD:
    base = b["bn"] if night else b["bd"]
    sf = (sfi - 100) / 5.0
    kpen = (kp - 4) * 8 if kp > 4 else 0
    p = min(100, max(3, round(base + sf - kpen)))
    cond = "Excellent" if p >= 72 else "Good" if p >= 52 else "Fair" if p >= 32 else "Poor"
    bands_now.append({"n": b["n"], "r": b["r"], "p": p, "cond": cond})

out = {
    "sfi": sfi,
    "k": kp,
    "a": a_index,
    "ssn": ssn,
    "sfi_history": sfi_history,
    "bands": bands_now,
    "night": night,
    "updated_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M"),
    "source": "NOAA SWPC"
}

os.makedirs("data", exist_ok=True)
with open("data/propagation.json", "w") as f:
    json.dump(out, f)
print(f"propagation.json: SFI={sfi} K={kp} A={a_index} SSN={ssn} history={len(sfi_history)}pts night={night}")
