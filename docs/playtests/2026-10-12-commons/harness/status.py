import json, sys, urllib.request, os
P = os.path.dirname(os.path.abspath(__file__))
d = json.load(urllib.request.urlopen("http://127.0.0.1:3920/api/state"))
s, live = d["state"], d["liveness"]
bay = s["world"]["stocks"]["school"]["value"]
agents = s.get("agents", {})
alive = sum(1 for a in agents.values() if a.get("alive"))
vill = " ".join(
    f"{a['name']}:{round(a['stocks'].get('satiation',{}).get('value',0))}/{round(a['stocks'].get('fish',{}).get('value',0))}"
    + ("" if a.get("alive") else "†")
    for a in agents.values())
end = "ENDED" if live["ended"] else (f"victory@{live['victoryTick']}" if live["victoryTick"] else "")
print(f"t={s['tick']} bay={bay:.1f} alive={alive}/{len(agents)} [{vill}] active={live['activeCount']} parked={live['parkedCount']} gm={live['gmConnected']} {end}".strip())
seen_path = f"{P}/.seen"
seen = int(open(seen_path).read()) if os.path.exists(seen_path) else -1
latest = seen
for e in d["eventLog"]:
    seq = e.get("seq", -1)
    if seq <= seen: continue
    latest = max(latest, seq)
    if e.get("type") in ("said", "whispered", "thin_catch", "collapse", "death", "victory", "announced"):
        who = e.get("entity") or e.get("args", {}).get("from") or ""
        print(f"   t{e.get('tick')} {e['type']} {who}: {(e.get('text') or '')[:220]}")
for e in d.get("gmEventLog", []):
    if e.get("type") in ("rule_patched", "rule_added", "announced") and e.get("seq", -1) > seen:
        print(f"   GM t{e.get('tick')} {e['type']}: {(e.get('text') or '')[:220]}")
open(seen_path, "w").write(str(latest))
