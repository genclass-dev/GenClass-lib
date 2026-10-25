# Summarize hunt sessions: python3 summarize.py out/<files...>
import json, sys, re
print("| tag | scenario | slow_ms | key ms | loads | explore verdict | DOM oracle wrong (seeded / baseline) | groups |")
print("|---|---|---|---|---|---|---|---|")
for f in sys.argv[1:]:
    d = json.load(open(f))
    s = d["summary"]
    groups = len(re.findall(r"^## ", d["report"], re.M))
    print(f"| {s['tag']} | {s['scenario']} | {s['slow_ms']} | {s['keyDelay']} | {s['loads']} | {s['explore']} | {s['oracleWrongSeeded']}/{s['loads']-2} / {s['oracleWrongBaseline']}/2 | {groups} |")
