import json, html, sys, os

P = os.path.dirname(os.path.abspath(__file__))
bay = json.load(open(f"{P}/bay.json"))
seats = json.load(open(f"{P}/seats.json"))

# Ticks 0-20 predate the server's history ring; these are the server's own
# readings at those ticks (start value, and counts it printed to players).
early = [[0, 30.0], [2, 20.5], [4, 19.1], [15, 22.4]]
series = early + [p for p in bay if p[0] >= 21]

# ---------- chart 1: the bay over the season ----------
W, H = 720, 300
L, R, T, B = 44, 128, 34, 34
X0, X1, Y0, Y1 = 0, 380, 0, 40
def sx(t): return L + (t - X0) / (X1 - X0) * (W - L - R)
def sy(v): return T + (1 - (v - Y0) / (Y1 - Y0)) * (H - T - B)

line = " ".join(f"{sx(t):.1f},{sy(v):.1f}" for t, v in series)
area = f"M{sx(series[0][0]):.1f},{sy(0):.1f} L" + " L".join(f"{sx(t):.1f},{sy(v):.1f}" for t, v in series) + f" L{sx(series[-1][0]):.1f},{sy(0):.1f} Z"

grid = []
for v in (0, 10, 20, 30, 40):
    grid.append(f'<line class="grid" x1="{L}" x2="{W-R}" y1="{sy(v):.1f}" y2="{sy(v):.1f}"/>'
                f'<text class="tick" x="{L-8}" y="{sy(v)+4:.1f}" text-anchor="end">{v}</text>')
for t in (0, 100, 200, 300, 380):
    grid.append(f'<text class="tick" x="{sx(t):.1f}" y="{H-B+20}" text-anchor="middle">{t}</text>')

refs = [
    (30, ["village line:", "no fishing at 30"]),
    (20, ["half the bay:", "fastest regrowth"]),
]
ref_svg = "".join(
    f'<line class="ref" x1="{L}" x2="{W-R}" y1="{sy(v):.1f}" y2="{sy(v):.1f}"/>'
    f'<text class="reflabel" x="{W-R+10}" y="{sy(v)-3:.1f}">{html.escape(a)}</text>'
    f'<text class="reflabel" x="{W-R+10}" y="{sy(v)+11:.1f}">{html.escape(b)}</text>'
    for v, (a, b) in refs)

events = [
    (222, "1", "All five agree to wait until the bay is back above 30."),
    (254, "2", "The Clerk makes that agreement a rule of the world."),
    (300, "3", "The season ends in victory, with all five alive."),
    (342, "4", "The Clerk adds the village's exception for the starving."),
]
ev_svg = "".join(
    f'<line class="event" x1="{sx(t):.1f}" x2="{sx(t):.1f}" y1="{T-2}" y2="{sy(0):.1f}"/>'
    f'<circle class="evdot" cx="{sx(t):.1f}" cy="{T-12}" r="9"/>'
    f'<text class="evnum" x="{sx(t):.1f}" y="{T-8:.1f}" text-anchor="middle">{n}</text>'
    for t, n, _ in events)
low_t, low_v = 4, 19.1
end_t, end_v = series[-1]
marks = (f'<circle class="dot" cx="{sx(low_t):.1f}" cy="{sy(low_v):.1f}" r="4"/>'
         f'<text class="note" x="{sx(low_t)+9:.1f}" y="{sy(low_v)+16:.1f}">19.1 at tick 4</text>'
         f'<circle class="dot" cx="{sx(end_t):.1f}" cy="{sy(end_v):.1f}" r="4"/>'
         f'<text class="note" x="{sx(end_t)-8:.1f}" y="{sy(end_v)-10:.1f}" text-anchor="end">{end_v:.1f}</text>')

chart1 = f'''<svg id="bay-chart" viewBox="0 0 {W} {H}" role="img" aria-labelledby="bay-title bay-desc">
<title id="bay-title">Fish in the bay, tick by tick</title>
<desc id="bay-desc">The bay starts at 30, dips to 19.1 at tick 4, holds between about 22 and 32 for the rest of the season, and closes at 33.7 at tick 380.</desc>
{''.join(grid)}{ref_svg}
<path class="area" d="{area}"/>
<polyline class="line" points="{line}"/>
{ev_svg}{marks}
<line id="bay-cross" class="cross" x1="0" x2="0" y1="{T}" y2="{sy(0):.1f}" visibility="hidden"/>
<circle id="bay-cross-dot" class="crossdot" r="5" visibility="hidden"/>
<rect id="bay-hit" x="{L}" y="{T}" width="{W-L-R}" height="{H-T-B}" fill="transparent" tabindex="0" aria-label="Explore the bay count by tick"/>
</svg>'''

# ---------- chart 2: regrowth vs bay level ----------
W2, H2 = 720, 260
L2, R2, T2, B2 = 52, 20, 20, 40
def gx(b): return L2 + b / 40 * (W2 - L2 - R2)
def gy(g): return T2 + (1 - g / 0.36) * (H2 - T2 - B2)
def growth(b): return 0.03 * b * (1 - b / 40)
curve = [(b / 4, growth(b / 4)) for b in range(0, 161)]
cpts = " ".join(f"{gx(b):.1f},{gy(g):.1f}" for b, g in curve)
carea = f"M{gx(0):.1f},{gy(0):.1f} L" + " L".join(f"{gx(b):.1f},{gy(g):.1f}" for b, g in curve) + f" L{gx(40):.1f},{gy(0):.1f} Z"
eat = 5 / 15
g2 = []
for g in (0, 0.1, 0.2, 0.3):
    g2.append(f'<line class="grid" x1="{L2}" x2="{W2-R2}" y1="{gy(g):.1f}" y2="{gy(g):.1f}"/>'
              f'<text class="tick" x="{L2-8}" y="{gy(g)+4:.1f}" text-anchor="end">{g:.1f}</text>')
for b in (0, 10, 20, 30, 40):
    g2.append(f'<text class="tick" x="{gx(b):.1f}" y="{H2-B2+20}" text-anchor="middle">{b}</text>')
g2.append(f'<text class="axislabel" x="{(L2+W2-R2)/2:.1f}" y="{H2-4}" text-anchor="middle">fish in the bay</text>')
pts = [(20, growth(20), "0.30 at 20", "middle", 0, 22),
       (30, growth(30), "0.23 at 30", "end", -10, 18)]
p_svg = "".join(
    f'<circle class="dot" cx="{gx(b):.1f}" cy="{gy(g):.1f}" r="4"/>'
    f'<text class="note" x="{gx(b)+dx:.1f}" y="{gy(g)+dy:.1f}" text-anchor="{a}">{t}</text>'
    for b, g, t, a, dx, dy in pts)
chart2 = f'''<svg id="growth-chart" viewBox="0 0 {W2} {H2}" role="img" aria-labelledby="g-title g-desc">
<title id="g-title">How fast the bay regrows at each level</title>
<desc id="g-desc">Regrowth peaks at 0.30 fish per tick when the bay holds 20, falls to about 0.23 at 30, and never reaches the 0.33 fish per tick that five villagers eat.</desc>
{''.join(g2)}
<line class="ref" x1="{L2}" x2="{W2-R2}" y1="{gy(eat):.1f}" y2="{gy(eat):.1f}"/>
<text class="reflabel" x="{W2-R2-6}" y="{gy(eat)-6:.1f}" text-anchor="end">what five villagers eat: 0.33 a tick</text>
<path class="area" d="{carea}"/>
<polyline class="line" points="{cpts}"/>
{p_svg}
<line id="g-cross" class="cross" x1="0" x2="0" y1="{T2}" y2="{gy(0):.1f}" visibility="hidden"/>
<circle id="g-cross-dot" class="crossdot" r="5" visibility="hidden"/>
<rect id="g-hit" x="{L2}" y="{T2}" width="{W2-L2-R2}" height="{H2-T2-B2}" fill="transparent" tabindex="0" aria-label="Explore regrowth by bay level"/>
</svg>'''

table_rows = "".join(f"<tr><td>{t}</td><td>{v:.1f}</td></tr>" for t, v in series if t in (0, 4, 15) or (t >= 21 and t % 20 == 0) or t == 380)

seat_rows = ""
for n in ["Ara", "Bo", "Cy", "Di", "Ed", "Clerk"]:
    s = seats[n]
    model = "Sonnet 5.5" if n == "Clerk" else "Haiku 5.5"
    role = "game master" if n == "Clerk" else "villager"
    seat_rows += (f"<tr><td>{n}</td><td>{role}</td><td>{model}</td><td>{s['passes']}</td>"
                  f"<td>{s['turns']:,}</td><td>{s['out']:,}</td><td>${s['cost']:.2f}</td></tr>")
tot_turns = sum(s["turns"] for s in seats.values())
tot_out = sum(s["out"] for s in seats.values())
tot_cost = sum(s["cost"] for s in seats.values())

data_js = json.dumps({"bay": series, "events": [[t, n, d] for t, n, d in events]})

page = open(f"{P}/page_template.html").read()
for k, v in {
    "@@CHART1@@": chart1, "@@CHART2@@": chart2, "@@TABLE@@": table_rows,
    "@@SEATS@@": seat_rows, "@@TOT_TURNS@@": f"{tot_turns:,}", "@@TOT_OUT@@": f"{tot_out:,}",
    "@@TOT_COST@@": f"${tot_cost:.2f}", "@@DATA@@": data_js,
    "@@SX@@": json.dumps([L, W - R, X0, X1, T, H - B, Y0, Y1]),
    "@@GX@@": json.dumps([L2, W2 - R2, 0, 40, T2, H2 - B2, 0, 0.36]),
}.items():
    page = page.replace(k, v)
open(f"{P}/commons-playtest.html", "w").write(page)
print("wrote", len(page), "bytes")
