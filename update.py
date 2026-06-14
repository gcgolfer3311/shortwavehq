import os, json, datetime, urllib.request, sys
KEY = os.environ.get("ANTHROPIC_API_KEY","").strip()
OUT = "data/live.json"
if not KEY:
    print("No key"); sys.exit(1)
body = json.dumps({"model":"claude-haiku-4-5-20251001","max_tokens":500,"messages":[{"role":"user","content":"Write a shortwave radio daily briefing as JSON with keys: headline, highlights (array of 4 strings with kHz frequencies), changes (array of 2 strings), propagation_note. Return only JSON."}]}).encode()
req = urllib.request.Request("https://api.anthropic.com/v1/messages",data=body,headers={"content-type":"application/json","x-api-key":KEY,"anthropic-version":"2023-06-01"},method="POST")
try:
    with urllib.request.urlopen(req,timeout=30) as r:
        d = json.loads(r.read())
    text = d["content"][0]["text"].strip().strip("```json").strip("```").strip()
    result = json.loads(text)
    result["updated_utc"] = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    result["status"] = "ok"
    os.makedirs("data",exist_ok=True)
    open(OUT,"w").write(json.dumps(result,indent=2))
    print("Done:",result.get("headline",""))
except Exception as e:
    print("Failed:",e); sys.exit(1)
