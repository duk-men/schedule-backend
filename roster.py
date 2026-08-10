"""
신중동점 주간 근무표 CP-SAT 모델.
JS(ScheduleDemo)의 제약과 scoreBoard 목적함수를 그대로 옮기되,
휴게 시각을 상수 규칙이 아니라 결정변수로 둔다.
"""
import json, sys
from datetime import date, timedelta
from ortools.sat.python import cp_model

# ---------- 시간축 (JS와 동일: 30분 = 1버킷, 하루 48버킷) ----------
BUCKET = 30
BPD = 48
def tb(h, m=0): return (h * 60 + m) // BUCKET
def blabel(i): return f"{(i*BUCKET//60)%24:02d}:{(i*BUCKET)%60:02d}"

# ---------- 근무타입 ----------
# need/peak: 필수 인원, extra: 여유 자리 추가 허용치
SLOTS = {
    "jjinO":      dict(label="찐오",     frm=tb(8),  to=tb(18), need=1, peak=1, extra=0, open=True,  late=False, night=False, half=False),
    "earlyShort": dict(label="이른오전", frm=tb(8),  to=tb(15), need=0, peak=0, extra=1, open=True,  late=False, night=False, half=False),
    "jjapO":      dict(label="짭오",     frm=tb(9),  to=tb(19), need=0, peak=1, extra=1, open=True,  late=False, night=False, half=False),
    "close":      dict(label="마감",     frm=tb(12), to=tb(22), need=1, peak=1, extra=0, open=False, late=True,  night=False, half=False),
    "thirteen":   dict(label="13",       frm=tb(13), to=tb(23), need=1, peak=1, extra=0, open=False, late=True,  night=False, half=False),
    "middle":     dict(label="미들",     frm=tb(10), to=tb(20), need=0, peak=0, extra=1, open=True,  late=False, night=False, half=False),
    "night":      dict(label="야간",     frm=tb(22), to=tb(32), need=1, peak=1, extra=0, open=False, late=False, night=True,  half=False),
    "halfAm":     dict(label="오전쩜오", frm=tb(8),  to=tb(14), need=0, peak=0, extra=1, open=True,  late=False, night=False, half=True),
    "halfPm":     dict(label="마감쩜오", frm=tb(16), to=tb(22), need=0, peak=0, extra=1, open=False, late=True,  night=False, half=True),
}
DAY_SLOTS  = [k for k, v in SLOTS.items() if not v["night"]]
FULL_DAY   = [k for k in DAY_SLOTS if not SLOTS[k]["half"]]   # 휴게를 도는 자리
SHORT = {"jjinO":"8-18","earlyShort":"8-15","jjapO":"9-19","close":"12-22",
         "thirteen":"13-23","middle":"10-20","night":"22-8","halfAm":"8-14","halfPm":"16-22"}

# ---------- 휴게/빵/바 인원 기준 ----------
BREAK_LEN   = 2          # 1시간
BREAD_AT_WD = tb(16)     # 평일 빵 도착
BREAD_AT_PK = tb(17, 30) # 금토일 빵 도착
BREAD_LEN   = 1          # 30분
FLOOR_FROM, FLOOR_UNTIL = tb(11), tb(17)
FLOOR_MIN   = 2
MAX_FLOOR   = 3
WEEK_CAP    = 6

# ---------- 목적함수 가중치 (JS scoreBoard 대응) ----------
W_GAP_WD, W_GAP_PK = 1, 4    # 커버리지 부족 1분당
W_GAP_DAY          = 20      # 부족이 걸린 날 1일당
W_FLOOR            = 2       # 바 인원 미달 1분당
W_OVER             = 1.5     # 과잉 인원 1분당
W_RANGE            = 100     # 근무일수 최대-최소 차이 (0.5일 단위)
W_MINWEEK          = 500     # 주 최소근무일 미달 (0.5일 단위)

# ---------- 직원 ----------
# avail: (시작, 종료) 버킷. 이 범위 안에 슬롯이 통째로 들어가야 배정 가능
EMPLOYEES = [
    dict(id=1, name="김선우", kind="day",   maxw=5, minw=0, maxhalf=4, jjino=True,  avail=None, fixed=[1,3,6], home=True),
    dict(id=2, name="김규리", kind="day",   maxw=5, minw=0, maxhalf=4, jjino=True,  avail=None, fixed=[],      home=True),
    dict(id=3, name="김호찬", kind="day",   maxw=5, minw=0, maxhalf=4, jjino=True,  avail=None, fixed=[],      home=True),
    dict(id=4, name="탁류빈", kind="day",   maxw=5, minw=0, maxhalf=4, jjino=False, avail=None, fixed=[],      home=True),
    dict(id=5, name="나수미", kind="day",   maxw=5, minw=0, maxhalf=4, jjino=False, avail=None, fixed=[],      home=True),
    dict(id=6, name="배정서", kind="day",   maxw=4, minw=3, maxhalf=4, jjino=False, avail=(tb(8),tb(15)), fixed=[], home=True),
    dict(id=7, name="조은솔", kind="night", maxw=5, minw=0, maxhalf=0, jjino=False, avail=None, fixed=[],      home=True),
    # 타 지점 야간. JS runAuto가 kind=="night"를 전부 후보로 넣는 것과 동일
    dict(id=8, name="강백호", kind="night", maxw=5, minw=0, maxhalf=0, jjino=False, avail=None, fixed=[],      home=False),
    dict(id=9, name="신유리", kind="night", maxw=5, minw=0, maxhalf=0, jjino=False, avail=None, fixed=[],      home=False),
]
VACATIONS, UNTIL, PINS = {}, {}, {}

# ---------- 날짜 ----------
WEEK_START = date(2026, 8, 10)          # 월요일
DATES = [WEEK_START + timedelta(days=i) for i in range(7)]
WD = ["월","화","수","목","금","토","일"]
def is_peak(d): return d.weekday() >= 4   # 금토일

def need_of(key, d):
    s = SLOTS[key]
    return s["peak"] if is_peak(d) else s["need"]

def demand_curve(d):
    """그날 시간대별 필요 인원. 야간은 다음날 새벽까지 넘어간다"""
    arr = [0]*BPD
    for key, s in SLOTS.items():
        if s["half"]: continue
        n = need_of(key, d)
        if not n: continue
        for i in range(s["frm"], s["to"]):
            arr[i % BPD] += n
    return arr

# ---------- 배정 가능 여부 ----------
def eligible(e, key, d):
    s = SLOTS[key]
    if s["night"] != (e["kind"] == "night"): return False
    if key == "jjinO" and not e["jjino"]: return False
    if e["avail"] and not (s["frm"] >= e["avail"][0] and s["to"] <= e["avail"][1]): return False
    if s["half"] and e["maxhalf"] == 0: return False
    if d.isoformat() in VACATIONS.get(e["id"], []): return False
    u = UNTIL.get(e["id"])
    if u and d.isoformat() > u: return False
    return True

# ==================================================================
m = cp_model.CpModel()
D, E = len(DATES), len(EMPLOYEES)
x = {}   # x[e,d,slot] = 그 직원이 그날 그 자리에 서는가
for ei, e in enumerate(EMPLOYEES):
    for di, d in enumerate(DATES):
        for key in SLOTS:
            if eligible(e, key, d):
                x[ei, di, key] = m.NewBoolVar(f"x{ei}_{di}_{key}")

def X(ei, di, key): return x.get((ei, di, key))
def works(ei, di):  return [v for k, v in x.items() if k[0] == ei and k[1] == di]

# --- 1. 하루 한 자리 ---
for ei in range(E):
    for di in range(D):
        w = works(ei, di)
        if w: m.Add(sum(w) <= 1)

# --- 2. 자리별 인원 상한 (필수 + 여유) ---
for di, d in enumerate(DATES):
    for key, s in SLOTS.items():
        cap = 1 if s["half"] else need_of(key, d) + s["extra"]
        v = [X(ei, di, key) for ei in range(E) if X(ei, di, key) is not None]
        if v: m.Add(sum(v) <= cap)

# --- 3. 같은 시각 중복 출근 금지 (마감 제외). 8시 출근 그룹만 해당 ---
EIGHT = ["jjinO", "earlyShort", "halfAm"]
for di in range(D):
    used = []
    for key in EIGHT:
        v = [X(ei, di, key) for ei in range(E) if X(ei, di, key) is not None]
        u = m.NewBoolVar(f"use{di}_{key}")
        if v:
            m.AddMaxEquality(u, v)
        else:
            m.Add(u == 0)
        used.append(u)
    m.Add(sum(used) <= 1)

# --- 4. 주 근무일 상한. 쩜오는 0.5일이므로 전부 2배 단위로 센다 ---
def unit(key): return 1 if SLOTS[key]["half"] else 2
load = {}
for ei, e in enumerate(EMPLOYEES):
    terms = [unit(k[2]) * v for k, v in x.items() if k[0] == ei]
    lv = m.NewIntVar(0, 2 * WEEK_CAP, f"load{ei}")
    m.Add(lv == sum(terms) if terms else lv == 0)
    load[ei] = lv
    m.Add(lv <= 2 * min(e["maxw"], WEEK_CAP))

# --- 5. 주 최소 근무일 (미달 시 벌점) ---
minw_short = []
for ei, e in enumerate(EMPLOYEES):
    if e["minw"] <= 0: continue
    sv = m.NewIntVar(0, 2 * e["minw"], f"minshort{ei}")
    m.Add(sv >= 2 * e["minw"] - load[ei])
    minw_short.append(sv)

# --- 6. 쩜오 횟수 상한 ---
for ei, e in enumerate(EMPLOYEES):
    hv = [v for k, v in x.items() if k[0] == ei and SLOTS[k[2]]["half"]]
    if hv: m.Add(sum(hv) <= e["maxhalf"])

# --- 7. 고정 근무 요일 (발주 등) ---
for ei, e in enumerate(EMPLOYEES):
    for di, d in enumerate(DATES):
        if d.weekday() in e["fixed"]:
            w = works(ei, di)
            if w: m.Add(sum(w) == 1)

# --- 8. 마감 다음날 오픈은 주 1회까지 ---
OPEN_K = [k for k, s in SLOTS.items() if s["open"]]
LATE_K = [k for k, s in SLOTS.items() if s["late"]]
def any_of(ei, di, keys, tag):
    v = [X(ei, di, k) for k in keys if X(ei, di, k) is not None]
    b = m.NewBoolVar(f"{tag}{ei}_{di}")
    if v: m.AddMaxEquality(b, v)
    else: m.Add(b == 0)
    return b
OP = {(ei, di): any_of(ei, di, OPEN_K, "op") for ei in range(E) for di in range(D)}
LA = {(ei, di): any_of(ei, di, LATE_K, "la") for ei in range(E) for di in range(D)}

for ei in range(E):
    clo = []
    for di in range(D - 1):
        c = m.NewBoolVar(f"clo{ei}_{di}")
        m.AddMultiplicationEquality(c, [LA[ei, di], OP[ei, di + 1]])
        clo.append(c)
    if clo: m.Add(sum(clo) <= 1)

# --- 9. 마감-오픈-마감 3일 패턴 금지 ---
for ei in range(E):
    for di in range(1, D - 1):
        m.Add(LA[ei, di - 1] + OP[ei, di] + LA[ei, di + 1] <= 2)

# --- 10. 휴게 시각. 출근 2시간 뒤 ~ 퇴근 1시간 전 사이에서 고른다 ---
brk = {}
for ei, e in enumerate(EMPLOYEES):
    if e["kind"] == "night": continue
    for di in range(D):
        avail_t = {}
        for key in FULL_DAY:
            if X(ei, di, key) is None: continue
            s = SLOTS[key]
            for t in range(s["frm"] + 4, s["to"] - BREAK_LEN + 1):
                avail_t.setdefault(t, []).append(key)
        if not avail_t: continue
        for t, keys in avail_t.items():
            b = m.NewBoolVar(f"b{ei}_{di}_{t}")
            brk[ei, di, t] = b
            m.Add(b <= sum(X(ei, di, k) for k in keys))
        full = [X(ei, di, k) for k in FULL_DAY if X(ei, di, k) is not None]
        m.Add(sum(brk[ei, di, t] for t in avail_t) == sum(full))

# 동시에 한 명만 쉰다
for di in range(D):
    for t in range(BPD):
        on = [b for (ei, dd, st), b in brk.items()
              if dd == di and st <= t < st + BREAK_LEN]
        if len(on) > 1: m.Add(sum(on) <= 1)

# --- 11. 커버리지 부족 ---
# 야간은 다음날 새벽으로 넘어간다. 주 첫날 새벽은 지난주 야간이 채운 것으로 본다
def cover_expr(di, t):
    terms = []
    for key, s in SLOTS.items():
        if s["night"]:
            if s["frm"] <= t < BPD:                       # 당일 22~24시
                src = di
            elif t < s["to"] - BPD:                       # 다음날 0~8시
                src = di - 1
            else:
                continue
            if src < 0: continue
        else:
            if not (s["frm"] <= t < s["to"]): continue
            src = di
        terms += [X(ei, src, key) for ei in range(E) if X(ei, src, key) is not None]
    return sum(terms) if terms else 0

gap_terms, day_has_gap = [], []
for di, d in enumerate(DATES):
    dem = demand_curve(d)
    gs = []
    for t in range(BPD):
        need = dem[t]
        if need == 0: continue
        if di == 0 and t < tb(8):   # 지난주 야간은 채워져 있다고 가정
            continue
        g = m.NewIntVar(0, need, f"gap{di}_{t}")
        m.Add(g >= need - cover_expr(di, t))
        gs.append(g)
        gap_terms.append((g, W_GAP_PK if is_peak(d) else W_GAP_WD))
    hg = m.NewBoolVar(f"hasgap{di}")
    if gs:
        tot = m.NewIntVar(0, 999, f"gtot{di}")
        m.Add(tot == sum(gs))
        m.Add(tot <= 999 * hg)
        m.Add(tot >= hg)
    day_has_gap.append(hg)

# --- 12. 바 인원 (휴게·빵 빠진 실제 인원) ---
def floor_expr(di, t, bread):
    terms = []
    for key, s in SLOTS.items():
        if s["night"] or not (s["frm"] <= t < s["to"]): continue
        terms += [X(ei, di, key) for ei in range(E) if X(ei, di, key) is not None]
    out = sum(terms) if terms else 0
    off = [b for (ei, dd, st), b in brk.items() if dd == di and st <= t < st + BREAK_LEN]
    if off: out = out - sum(off)
    if bread <= t < bread + BREAD_LEN: out = out - 1
    return out

floor_short, over_terms = [], []
for di, d in enumerate(DATES):
    bread = BREAD_AT_PK if is_peak(d) else BREAD_AT_WD
    dem = demand_curve(d)
    for t in range(tb(8), tb(23)):
        fe = floor_expr(di, t, bread)
        if FLOOR_FROM <= t < FLOOR_UNTIL:
            sv = m.NewIntVar(0, FLOOR_MIN, f"fs{di}_{t}")
            m.Add(sv >= FLOOR_MIN - fe)
            floor_short.append(sv)
        ceil = max(MAX_FLOOR, dem[t])
        ov = m.NewIntVar(0, E, f"ov{di}_{t}")
        m.Add(ov >= fe - ceil)
        over_terms.append(ov)

# --- 13. 근무일수 형평 (분산 대신 최대-최소 차이) ---
home_ids = [ei for ei, e in enumerate(EMPLOYEES) if e["home"]]
lmax = m.NewIntVar(0, 2*WEEK_CAP, "lmax")
lmin = m.NewIntVar(0, 2*WEEK_CAP, "lmin")
m.AddMaxEquality(lmax, [load[ei] for ei in home_ids])
m.AddMinEquality(lmin, [load[ei] for ei in home_ids])
rng = m.NewIntVar(0, 2*WEEK_CAP, "rng")
m.Add(rng == lmax - lmin)

# --- 목적함수 ---
obj = []
obj += [int(w * BUCKET) * g for g, w in gap_terms]
obj += [W_GAP_DAY * b for b in day_has_gap]
obj += [int(W_FLOOR * BUCKET) * s for s in floor_short]
obj += [int(W_OVER * BUCKET) * o for o in over_terms]
obj.append(W_RANGE * rng)
obj += [W_MINWEEK * s for s in minw_short]
m.Minimize(sum(obj))

solver = cp_model.CpSolver()
solver.parameters.max_time_in_seconds = 120
solver.parameters.num_workers = 8
solver.parameters.log_search_progress = False
st = solver.Solve(m)

print("상태:", solver.StatusName(st))
print("목적함수:", solver.ObjectiveValue(), " / 하한:", solver.BestObjectiveBound())
print("탐색시간: %.1fs" % solver.WallTime())
if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
    sys.exit(1)

# ---------- 출력 ----------
res = {}
for di, d in enumerate(DATES):
    day = {}
    for key in SLOTS:
        ids = [EMPLOYEES[ei]["name"] for ei in range(E)
               if X(ei, di, key) is not None and solver.Value(X(ei, di, key))]
        if ids: day[key] = ids
    res[d.isoformat()] = day

print("\n=== 주간 표 ===")
hdr = "        " + " ".join(f"{WD[d.weekday()]}{d.day:2d} " for d in DATES)
print(hdr)
for ei, e in enumerate(EMPLOYEES):
    row = f"{e['name']:<7}"
    any_row = False
    for di in range(D):
        cell = "  ·  "
        for key in SLOTS:
            v = X(ei, di, key)
            if v is not None and solver.Value(v):
                cell = f"{SHORT[key]:^5}"; any_row = True
        row += cell + " "
    if any_row or e["home"]:
        print(row, f" {solver.Value(load[ei])/2:g}/{min(e['maxw'],WEEK_CAP)}일")

print("\n=== 날짜별 진단 ===")
for di, d in enumerate(DATES):
    dem = demand_curve(d)
    bread = BREAD_AT_PK if is_peak(d) else BREAD_AT_WD
    gmin = 0
    for t in range(BPD):
        if dem[t] == 0: continue
        if di == 0 and t < tb(8): continue
        c = cover_expr(di, t)
        cv = solver.Value(c) if not isinstance(c, int) else c
        gmin += max(0, dem[t] - cv) * BUCKET
    fl = []
    for t in range(FLOOR_FROM, FLOOR_UNTIL):
        fe = floor_expr(di, t, bread)
        fl.append(solver.Value(fe) if not isinstance(fe, int) else fe)
    tag = "금토일" if is_peak(d) else "평일  "
    print(f"{WD[d.weekday()]} {d.day:2d} {tag}  부족 {gmin:3d}분   11-17시 바 최소 {min(fl)}명")

print("\n=== 휴게 배치 ===")
for di, d in enumerate(DATES):
    rows = sorted((t, EMPLOYEES[ei]["name"])
                  for (ei, dd, t), b in brk.items() if dd == di and solver.Value(b))
    bread = BREAD_AT_PK if is_peak(d) else BREAD_AT_WD
    s = ", ".join(f"{n} {blabel(t)}~{blabel(t+BREAK_LEN)}" for t, n in rows)
    print(f"{WD[d.weekday()]} {d.day:2d}  {s}  | 빵 {blabel(bread)}")

with open("/mnt/user-data/outputs/roster_result.json", "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, indent=2)
