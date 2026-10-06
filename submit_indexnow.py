"""
Submits NEW or CHANGED URLs from the built sitemap.xml to IndexNow
(api.indexnow.org), which fans out to Bing, Yandex, and other participating
search engines. Google does not support IndexNow — this is in addition to,
not instead of, normal Google Search Console sitemap submission.

Bing flags "batch mode" when every URL is resubmitted daily, so this script
only sends pages whose content changed since the previous build:
  * the previous build is read from git (HEAD:dist/...), because the workflow
    commits dist/ after every run and build.js rewrites it before this runs;
  * the comparison ignores the volatile "on air now" text and compares only
    each page's title, meta description, h1 and schedule tables;
  * the homepage is always sent, and at most MAX_URLS are sent per run
    (new pages first).

Run this AFTER `node build.js` has produced dist/sitemap.xml.
"""
import hashlib
import json
import os
import re
import subprocess
import urllib.error
import urllib.request

HOST = "hqshortwaveradio.com"
KEY = "c11bb943c5604e4386ab2c0a61d580b5"
KEY_LOCATION = f"https://{HOST}/{KEY}.txt"
SITEMAP_PATH = "dist/sitemap.xml"
ENDPOINT = "https://api.indexnow.org/indexnow"
MAX_URLS = 100
ALWAYS = ["/"]


def url_to_file(path):
    if path.endswith("/"):
        return "dist" + path + "index.html"
    return "dist" + path


def signature(html):
    """Hash of the parts of a page that matter for search: title, description,
    h1 and the schedule tables. Timestamps and 'on air now' sentences outside
    tables are ignored, so a page only counts as changed when its data did."""
    parts = []
    for pat in (r"<title>(.*?)</title>",
                r'<meta name="description" content="(.*?)"',
                r"<h1[^>]*>(.*?)</h1>"):
        m = re.search(pat, html, re.S)
        parts.append(m.group(1) if m else "")
    parts.extend(re.findall(r"<table.*?</table>", html, re.S))
    return hashlib.sha1("\x1f".join(parts).encode("utf-8", "replace")).hexdigest()


def previous_html(rel_path):
    """Content of the file at HEAD (the previous build), or None if absent."""
    try:
        out = subprocess.run(["git", "show", f"HEAD:{rel_path}"], capture_output=True, timeout=20)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    return out.stdout.decode("utf-8", "replace")


def git_available():
    try:
        r = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], capture_output=True, timeout=20)
        return r.returncode == 0
    except Exception:
        return False


def main():
    try:
        with open(SITEMAP_PATH, "r", encoding="utf-8") as f:
            xml = f.read()
    except FileNotFoundError:
        print(f"WARNING: {SITEMAP_PATH} not found — skipping IndexNow submission")
        return

    locs = re.findall(r"<loc>(.*?)</loc>", xml)
    if not locs:
        print("WARNING: no <loc> entries found in sitemap — skipping IndexNow submission")
        return
    prefix = f"https://{HOST}"
    paths = [u[len(prefix):] if u.startswith(prefix) else u for u in locs]

    if not git_available():
        print("IndexNow: git history not available — submitting only the homepage this run")
        chosen = [prefix + p for p in ALWAYS]
    else:
        new_urls, changed_urls = [], []
        for path in paths:
            rel = url_to_file(path)
            try:
                with open(rel, "r", encoding="utf-8", errors="replace") as f:
                    cur = f.read()
            except OSError:
                continue
            prev = previous_html(rel)
            if prev is None:
                new_urls.append(path)
            elif signature(prev) != signature(cur):
                changed_urls.append(path)
        picked = []
        for p in ALWAYS + new_urls + changed_urls:
            if p in paths and p not in picked:
                picked.append(p)
        print(f"IndexNow: {len(new_urls)} new, {len(changed_urls)} changed of {len(paths)} URLs")
        if len(picked) > MAX_URLS:
            print(f"IndexNow: capping {len(picked)} URLs at {MAX_URLS} for this run")
        chosen = [prefix + p for p in picked[:MAX_URLS]]

    if not chosen:
        print("IndexNow: nothing to submit")
        return

    payload = {"host": HOST, "key": KEY, "keyLocation": KEY_LOCATION, "urlList": chosen}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT,
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"IndexNow: submitted {len(chosen)} URLs, status {resp.status}")
    except urllib.error.HTTPError as e:
        # IndexNow returns 200/202 on success; log anything else but don't fail the build
        print(f"IndexNow: submission returned HTTP {e.code} — {e.read().decode(errors='replace')[:300]}")
    except Exception as e:
        print(f"IndexNow: submission failed — {e}")


if __name__ == "__main__":
    main()
