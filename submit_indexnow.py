"""
Submits every URL in the built sitemap.xml to IndexNow (api.indexnow.org),
which fans out to Bing, Yandex, and other participating search engines.
Google does not support IndexNow — this is in addition to, not instead of,
normal Google Search Console sitemap submission.

Run this AFTER `node build.js` has produced dist/sitemap.xml.
"""
import re
import json
import urllib.request
import urllib.error

HOST = "hqshortwaveradio.com"
KEY = "c11bb943c5604e4386ab2c0a61d580b5"
KEY_LOCATION = f"https://{HOST}/{KEY}.txt"
SITEMAP_PATH = "dist/sitemap.xml"
ENDPOINT = "https://api.indexnow.org/indexnow"

def main():
    try:
        with open(SITEMAP_PATH, "r", encoding="utf-8") as f:
            xml = f.read()
    except FileNotFoundError:
        print(f"WARNING: {SITEMAP_PATH} not found — skipping IndexNow submission")
        return

    urls = re.findall(r"<loc>(.*?)</loc>", xml)
    if not urls:
        print("WARNING: no <loc> entries found in sitemap — skipping IndexNow submission")
        return

    # IndexNow allows up to 10,000 URLs per request — our sitemap is well under that
    payload = {
        "host": HOST,
        "key": KEY,
        "keyLocation": KEY_LOCATION,
        "urlList": urls,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT,
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"IndexNow: submitted {len(urls)} URLs, status {resp.status}")
    except urllib.error.HTTPError as e:
        # IndexNow returns 200/202 on success; log anything else but don't fail the build
        print(f"IndexNow: submission returned HTTP {e.code} — {e.read().decode(errors='replace')[:300]}")
    except Exception as e:
        print(f"IndexNow: submission failed — {e}")

if __name__ == "__main__":
    main()
