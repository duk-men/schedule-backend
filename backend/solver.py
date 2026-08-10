"""CP-SAT 모델. roster.py를 함수화하고 일반화한 것 (SPEC.md 6절).

roster.py 대비 추가된 것:
  - 다매장: 야간 슬롯만 타 매장 인력 후보 허용, 주간은 자기 매장만 (eligible)
  - existing 반영: 이중 배정 차단 (taken_elsewhere), 경계일 마감/오픈 문맥 (LA_prev)
  - locked 반영: 그 날짜는 x 변수를 만들지 않고 existing 값을 그대로 통과시킨다
  - pins / until
  - startShared로 일반화한 "같은 시각 출근 그룹" 배타 제약
  - shortage 모드별 평일 extra/half 상한
  - requireSlotFill (9.1에서 true로 확정)
  - fixedDays 하드 제약 + 배정 불가능시 명시적 INFEASIBLE (9.2에서 확정)
"""
import time
from collections import defaultdict

from ortools.sat.python import cp_model

from domain import BPD, BUCKET, blabel, is_peak, shift_date, tb, weekday_of
from schemas import (
    Diagnostics,
    Penalties,
    PerDayDiag,
    PerEmployeeDiag,
    SolveRequest,
    SolveResponse,
)


def _val(solver, x):
    """상수(int)면 그대로, CP 변수면 solver.Value로 뽑는다."""
    return x if isinstance(x, int) else solver.Value(x)


def solve(req: SolveRequest) -> SolveResponse:
    t0 = time.time()
    m = cp_model.CpModel()

    dates = req.dates
    D = len(dates)
    locked_set = set(req.locked) & set(dates)
    date_index = {d: i for i, d in enumerate(dates)}

    # ---------- 슬롯 ----------
    SLOTS = {
        s.key: dict(
            label=s.label, frm=s.from_, to=s.to, need=s.need, peak=s.peak,
            extra=s.extra, open=s.open, late=s.late, night=s.night, half=s.half,
        )
        for s in req.slots
    }

    def need_of(key, d_str):
        s = SLOTS[key]
        return s["peak"] if is_peak(d_str) else s["need"]

    # frm(시작 시각)별로 묶은 비half 슬롯 (야간 포함 — 원래 demand_curve도 야간을
    # 포함했다). 3절 그룹 배타 제약과 같은 기준이다 — 같은 frm에 슬롯이 여럿(대체
    # 가능한 그룹, 예: 찐오/이른오전/오전쩜오)이면 그중 하나만 그날 실제로 쓰인다.
    frm_groups = defaultdict(list)
    for key, s in SLOTS.items():
        if s["half"]:
            continue
        frm_groups[s["frm"]].append(key)
    sorted_frms = sorted(frm_groups)

    def demand_curve(d_str):
        arr = [0] * BPD
        for idx, frm in enumerate(sorted_frms):
            keys = frm_groups[frm]
            n = max(need_of(k, d_str) for k in keys)
            if not n:
                continue
            cap_to = max(SLOTS[k]["to"] for k in keys)
            active_keys = [k for k in keys if k not in req.rules.startShared]
            if len(active_keys) >= 2:
                # 대체 그룹은 그중 한 슬롯만 실제로 서므로, 그룹 대표(가장 긴 슬롯,
                # 예: 찐오 8-18)의 전체 길이를 그대로 요구하면 이른오전(8-15)이 대신
                # 배정된 날 15~18시가 "유령 부족"으로 잡힌다. 그날 필요한 다음 그룹이
                # 시작하는 시점까지만 이 그룹 전용 수요로 잡고, 그 이후는 다음 그룹
                # (짭오 등)이 이어받는다고 본다.
                for later_frm in sorted_frms[idx + 1:]:
                    later_keys = frm_groups[later_frm]
                    if max(need_of(k, d_str) for k in later_keys) > 0:
                        cap_to = min(cap_to, later_frm)
                        break
            for i in range(frm, cap_to):
                arr[i % BPD] += n
        return arr

    # 8시에 출근하는 자리 전부 (찐오/이른오전/오전쩜오 등, half 포함). canEightStart 자격
    # 판정과 3번 제약(같은 시각 출근 그룹 배타)이 이미 이 기준으로 묶여 있는 것과 동일한 정의다.
    EIGHT_K = {key for key, s in SLOTS.items() if not s["night"] and s["frm"] == tb(8)}

    # 같은 frm에 길이가 다른 대체 슬롯이 여럿(half 제외, 예: 찐오 8-18 / 이른오전
    # 8-15)이면 그중 가장 긴 슬롯을 할 수 있는 사람은 짧은 쪽을 못 하게 한다.
    # 이른오전 같은 짧은 자리는 avail로 그만큼만 묶인 사람(배정서 등) 전용이다 —
    # 찐오가 가능한 사람이 굳이 이른오전을 골라 15~18시를 다른 사람에게 떠넘기지 않도록.
    LONGER_IN_GROUP = {}
    for frm, keys in frm_groups.items():
        non_half = [k for k in keys if not SLOTS[k]["half"]]
        if len(non_half) < 2:
            continue
        longest = max(non_half, key=lambda k: SLOTS[k]["to"])
        for k in non_half:
            if k != longest:
                LONGER_IN_GROUP[k] = longest

    # ---------- 직원 ----------
    EMP = []
    for e in req.employees:
        EMP.append(dict(
            id=e.id, name=e.name, storeId=e.storeId, kind=e.kind,
            maxw=e.maxPerWeek, minw=e.minPerWeek, maxweekday=e.maxWeekday, maxhalf=e.maxHalf,
            eightstart=e.canEightStart, until=e.until, avail=e.avail,
            fixed=set(e.fixedDays), pins=e.pins, vacations=set(e.vacations),
        ))
    E = len(EMP)
    id_to_ei = {e["id"]: ei for ei, e in enumerate(EMP)}

    # 다른 매장에 이미 배정되어 우리 매장에서 후보가 될 수 없는 (empId, date)
    taken_elsewhere = set()
    for store_id, store_board in req.existing.items():
        if store_id == req.storeId:
            continue
        for d_str, day_data in store_board.items():
            if d_str not in date_index:
                continue
            for _key, ids in day_data.items():
                for emp_id in ids:
                    taken_elsewhere.add((emp_id, d_str))

    def eligible(e, key, d_str):
        s = SLOTS[key]
        if s["night"] != (e["kind"] == "night"):
            return False
        if key in EIGHT_K and not e["eightstart"]:
            return False
        if not s["night"] and e["storeId"] != req.storeId:
            return False  # 주간 슬롯은 자기 매장만
        if e["avail"]:
            window = e["avail"].peak if is_peak(d_str) else e["avail"].weekday
            if window is not None and not (s["frm"] >= window[0] and s["to"] <= window[1]):
                return False
        if s["half"] and e["maxhalf"] == 0:
            return False
        if d_str in e["vacations"]:
            return False
        if e["until"] and d_str > e["until"]:
            return False
        if (e["id"], d_str) in taken_elsewhere:
            return False
        longer = LONGER_IN_GROUP.get(key)
        if longer and eligible(e, longer, d_str):
            return False
        return True

    # ---------- 결정 변수 ----------
    x = {}
    for ei, e in enumerate(EMP):
        for di, d_str in enumerate(dates):
            if d_str in locked_set:
                continue  # 잠금일은 변수를 만들지 않는다 (existing을 그대로 통과)
            for key in SLOTS:
                if eligible(e, key, d_str):
                    x[ei, di, key] = m.NewBoolVar(f"x{ei}_{di}_{key}")

    def X(ei, di, key):
        return x.get((ei, di, key))

    def works(ei, di):
        return [v for k, v in x.items() if k[0] == ei and k[1] == di]

    def existing_day(store_id, d_str):
        return req.existing.get(store_id, {}).get(d_str, {})

    def slot_count(di, key):
        """그 날짜/슬롯에 배정된 인원 수. 잠금일이면 existing에서 상수로."""
        d_str = dates[di]
        if d_str in locked_set:
            return len(existing_day(req.storeId, d_str).get(key, []))
        terms = [X(ei, di, key) for ei in range(E) if X(ei, di, key) is not None]
        return sum(terms) if terms else 0

    def night_prev_count(di, key):
        if di - 1 >= 0:
            return slot_count(di - 1, key)
        prev_date = shift_date(dates[0], -1)
        return len(existing_day(req.storeId, prev_date).get(key, []))

    infeasible_notes = []

    # ---------- 1. 하루 한 자리 ----------
    for ei in range(E):
        for di in range(D):
            w = works(ei, di)
            if w:
                m.Add(sum(w) <= 1)

    # ---------- 2. 자리별 인원 상한 (필수 + 여유, shortage 모드 반영) ----------
    def slot_cap(key, d_str):
        s = SLOTS[key]
        peak = is_peak(d_str)
        need = need_of(key, d_str)
        if s["half"]:
            if not peak and req.rules.shortage in ("leave", "extra"):
                return 0
            return 1
        extra = s["extra"]
        if not peak and req.rules.shortage in ("leave", "half"):
            extra = 0
        return need + extra

    for di, d_str in enumerate(dates):
        if d_str in locked_set:
            continue
        for key in SLOTS:
            cap = slot_cap(key, d_str)
            v = [X(ei, di, key) for ei in range(E) if X(ei, di, key) is not None]
            if v:
                m.Add(sum(v) <= cap)

    # ---------- 2.5 requireSlotFill (9.1 확정: true, 완화 모드에서는 소프트) ----------
    # 같은 시각 출근 그룹(3번 제약과 동일하게 묶음) 단위로 건다. "찐오가 꼭 필요하다"보다는
    # "8시에 여는 사람이 꼭 필요하다"가 실제 요구이고, 그 8시 자리는 어차피 그룹 배타 제약
    # 때문에 한 명만 쓸 수 있다. 그래서 이른오전/오전쩜오가 그 한 명을 맡아도 찐오의
    # 필요인원을 채운 것으로 본다 (배정서처럼 찐오 자격 없이 8시대만 가능한 사람을 위함).
    #
    # 인원이 진짜로 모자라면(예: 종료일이 지나 후보가 줄어든 주) 이 자체가 INFEASIBLE의
    # 원인이 된다. "완전히 실패" 대신 "빈 자리 표시하면서 최선을 다한 표"를 위해 하드가
    # 아니라 아주 무거운 페널티를 주는 소프트 제약으로 둔다 — 채울 수 있으면 페널티가
    # 다른 모든 항을 압도하므로 사실상 하드와 같고, 정말 못 채울 때만 그 자리를 비운 채로
    # 최선의 나머지 배치를 찾는다. fill_shortfall은 결과 추출 단계에서 warnings로 남긴다.
    fill_shortfall = []
    if req.rules.requireSlotFill:
        fill_groups = defaultdict(list)
        for key, s in SLOTS.items():
            if s["night"]:
                continue
            fill_groups[s["frm"]].append(key)
        for di, d_str in enumerate(dates):
            if d_str in locked_set:
                continue
            for _frm, keys in fill_groups.items():
                need = max(need_of(k, d_str) for k in keys)
                if need <= 0:
                    continue
                label = SLOTS[max(keys, key=lambda k: need_of(k, d_str))]["label"]
                v = [X(ei, di, k) for k in keys for ei in range(E) if X(ei, di, k) is not None]
                if v:
                    short = m.NewIntVar(0, need, f"reqfail_{di}_{_frm}")
                    m.Add(short >= need - sum(v))
                else:
                    short = need  # 배정 가능한 후보 자체가 없어 항상 이만큼 못 채운다
                fill_shortfall.append((short, d_str, label, need))

    # ---------- 3. 같은 시각 출근 그룹 배타 (startShared 일반화) ----------
    # 쩜오(half)도 포함한다 — 8시 출근(찐오/이른오전/오전쩜오)은 슬롯 종류가 달라도
    # 그 시각엔 오직 한 명만 가능하다는 게 실제 규칙이다.
    groups = defaultdict(list)
    for key, s in SLOTS.items():
        if s["night"]:
            continue
        groups[s["frm"]].append(key)
    for _frm, keys in groups.items():
        active_keys = [k for k in keys if k not in req.rules.startShared]
        if len(active_keys) < 2:
            continue
        for di, d_str in enumerate(dates):
            if d_str in locked_set:
                continue
            used = []
            for key in active_keys:
                v = [X(ei, di, key) for ei in range(E) if X(ei, di, key) is not None]
                u = m.NewBoolVar(f"use{di}_{key}")
                if v:
                    m.AddMaxEquality(u, v)
                else:
                    m.Add(u == 0)
                used.append(u)
            m.Add(sum(used) <= 1)

    # ---------- 4. 주 근무 상한 (버그1 수정: 출근 횟수와 근무일수를 분리 집계) ----------
    def unit(key):
        return 1 if SLOTS[key]["half"] else 2

    locked_units = defaultdict(int)
    locked_shift_count = defaultdict(int)
    locked_half_count = defaultdict(int)
    for d_str in locked_set:
        day_data = existing_day(req.storeId, d_str)
        for key, ids in day_data.items():
            s = SLOTS.get(key)
            if s is None:
                continue
            u = unit(key)
            for emp_id in ids:
                ei = id_to_ei.get(emp_id)
                if ei is None:
                    continue
                locked_units[ei] += u
                locked_shift_count[ei] += 1
                if s["half"]:
                    locked_half_count[ei] += 1

    load, shift_count = {}, {}
    for ei, e in enumerate(EMP):
        week_cap = req.rules.weekCap
        terms = [unit(k[2]) * v for k, v in x.items() if k[0] == ei]
        lv = m.NewIntVar(0, 2 * week_cap + max(0, req.rules.overtime.maxExtraUnits), f"load{ei}")
        m.Add(lv == sum(terms) + locked_units[ei])
        load[ei] = lv
        m.Add(lv <= 2 * min(e["maxw"], week_cap) + req.rules.overtime.maxExtraUnits)

        cterms = [v for k, v in x.items() if k[0] == ei]
        cv = m.NewIntVar(0, week_cap, f"shiftcount{ei}")
        m.Add(cv == sum(cterms) + locked_shift_count[ei])
        shift_count[ei] = cv
        m.Add(cv <= min(e["maxw"] + req.rules.overtime.maxExtraShifts, week_cap))

    # ---------- 4.5 평일 전용 상한 ----------
    # 여기서 "평일"은 수요 계산에 쓰는 is_peak(금토일=피크)과는 별개로 월~금이다.
    # 배정서처럼 maxWeekday가 걸린 직원은 금요일도 평일로 쳐서 상한에 넣는다 —
    # 예: 월/수/목(비피크 3) + 금(피크 1) = 4일이 되는 걸 막기 위함.
    def is_mon_fri(d_str):
        return weekday_of(d_str) < 5

    locked_weekday_count = defaultdict(int)
    for d_str in locked_set:
        if not is_mon_fri(d_str):
            continue
        for _key, ids in existing_day(req.storeId, d_str).items():
            for emp_id in ids:
                ei = id_to_ei.get(emp_id)
                if ei is not None:
                    locked_weekday_count[ei] += 1

    for ei, e in enumerate(EMP):
        if e["maxweekday"] is None:
            continue
        terms = [v for (eei, di, _key), v in x.items() if eei == ei and is_mon_fri(dates[di])]
        wv = m.NewIntVar(0, req.rules.weekCap, f"weekdaycount{ei}")
        m.Add(wv == sum(terms) + locked_weekday_count[ei])
        m.Add(wv <= e["maxweekday"])

    # ---------- 4.6 오전/오후 계열 편중 방지 ----------
    # 오전(9/10시 시작)과 오후(12/13시 시작)를 각각 별도 계열로 보고, 한 계열을 주당
    # familyStartCap회 넘게 서지 못하게 한다. avail로 이미 한 계열에 묶인 직원(예: 배정서는
    # 8-15만 가능해 이 두 계열 자체에 해당하는 x 변수가 없다)에게는 자연히 걸리지 않는다.
    FAMILY_STARTS = {"morning": (tb(9), tb(10)), "afternoon": (tb(12), tb(13))}
    family_keys = {
        fam: [key for key, s in SLOTS.items() if not s["night"] and s["frm"] in starts]
        for fam, starts in FAMILY_STARTS.items()
    }
    locked_family_count = {fam: defaultdict(int) for fam in FAMILY_STARTS}
    for d_str in locked_set:
        day_data = existing_day(req.storeId, d_str)
        for fam, keys in family_keys.items():
            for key in keys:
                for emp_id in day_data.get(key, []):
                    ei = id_to_ei.get(emp_id)
                    if ei is not None:
                        locked_family_count[fam][ei] += 1

    for fam, keys in family_keys.items():
        if not keys:
            continue
        for ei, e in enumerate(EMP):
            terms = [X(ei, di, key) for di in range(D) for key in keys if X(ei, di, key) is not None]
            if not terms:
                continue
            m.Add(sum(terms) + locked_family_count[fam][ei] <= req.rules.familyStartCap)

    # ---------- 4.7 쩜오는 정규 근무일수를 다 채운 뒤에만 ----------
    # 쩜오(half)를 하나라도 쓰려면, 그 직원의 풀타임(찐/오픈/마감 등 half가 아닌) 출근
    # 횟수가 이미 정규 상한(min(maxw, weekCap))에 도달해 있어야 한다. 4.5/5처럼 정규
    # 상한을 못 채운 채 쩜오로 대충 채우는 걸 막고, 쩜오는 상한을 다 채운 뒤 초과분으로만
    # 쓰이게 한다.
    for ei, e in enumerate(EMP):
        half_terms = [
            X(ei, di, key) for di in range(D) for key, s in SLOTS.items()
            if s["half"] and X(ei, di, key) is not None
        ]
        if not half_terms:
            continue
        full_terms = [
            X(ei, di, key) for di in range(D) for key, s in SLOTS.items()
            if not s["half"] and not s["night"] and X(ei, di, key) is not None
        ]
        half_expr = sum(half_terms) + locked_half_count[ei]
        full_expr = sum(full_terms) + (locked_shift_count[ei] - locked_half_count[ei])
        cap = min(e["maxw"], req.rules.weekCap)
        has_half = m.NewBoolVar(f"hashalf{ei}")
        m.Add(half_expr <= D * has_half)
        m.Add(full_expr >= cap).OnlyEnforceIf(has_half)

    # ---------- 5. 주 최소 근무 (미달 시 벌점) ----------
    minw_short = {}
    for ei, e in enumerate(EMP):
        if e["minw"] <= 0:
            continue
        sv = m.NewIntVar(0, 2 * e["minw"], f"minshort{ei}")
        m.Add(sv >= 2 * e["minw"] - load[ei])
        minw_short[ei] = sv

    # ---------- 6. 쩜오 횟수 상한 ----------
    for ei, e in enumerate(EMP):
        hv = [v for k, v in x.items() if k[0] == ei and SLOTS[k[2]]["half"]]
        if hv:
            m.Add(sum(hv) <= e["maxhalf"])

    # ---------- 7. 고정 근무 요일 (9.2 확정: 하드) ----------
    for ei, e in enumerate(EMP):
        for di, d_str in enumerate(dates):
            if d_str in locked_set:
                continue
            if weekday_of(d_str) in e["fixed"]:
                w = works(ei, di)
                if w:
                    m.Add(sum(w) == 1)
                else:
                    z = m.NewBoolVar(f"fixedfail_{ei}_{di}")
                    m.Add(z == 0)
                    m.Add(z == 1)
                    infeasible_notes.append(
                        f"{e['name']}: {d_str} 고정 요일이지만 그 날 배정 가능한 자리가 없습니다 "
                        "(휴가/자격 제한/타 매장 중복 등)."
                    )

    # ---------- 7.5 pins (못박은 근무) ----------
    for ei, e in enumerate(EMP):
        for d_str, key in e["pins"].items():
            if d_str not in date_index or d_str in locked_set:
                continue
            di = date_index[d_str]
            v = X(ei, di, key)
            if v is not None:
                m.Add(v == 1)
            else:
                z = m.NewBoolVar(f"pinfail_{ei}_{di}")
                m.Add(z == 0)
                m.Add(z == 1)
                infeasible_notes.append(
                    f"{e['name']}: {d_str} {key} 고정 배정(pin)이 자격/휴가 조건과 맞지 않습니다."
                )

    # ---------- 8/9. 마감→오픈 주 1회, 마감-오픈-마감 금지 (경계일 문맥 포함) ----------
    OPEN_K = [k for k, s in SLOTS.items() if s["open"] and not s["night"] and not s["half"]]
    LATE_K = [k for k, s in SLOTS.items() if s["late"] and not s["night"] and not s["half"]]

    def any_of_var(ei, di, keys, tag):
        v = [X(ei, di, k) for k in keys if X(ei, di, k) is not None]
        b = m.NewBoolVar(f"{tag}{ei}_{di}")
        if v:
            m.AddMaxEquality(b, v)
        else:
            m.Add(b == 0)
        return b

    def any_of_const(emp_id, day_data, keys):
        for k in keys:
            if emp_id in day_data.get(k, []):
                return 1
        return 0

    def mul_bool(a, b, tag):
        if isinstance(a, int) and isinstance(b, int):
            return a * b
        if isinstance(a, int):
            return b if a else 0
        if isinstance(b, int):
            return a if b else 0
        c = m.NewBoolVar(tag)
        m.AddMultiplicationEquality(c, [a, b])
        return c

    prev_date = shift_date(dates[0], -1) if dates else None
    OP, LA, LA_prev = {}, {}, {}
    # 그 날 무슨 자리든 하나라도 서면 근무일로 본다 (쉬는 날 판정용, 마감-오픈-마감을
    # 캘린더 인접일이 아니라 실제 근무일 인접으로 일반화하는 데 쓴다).
    ALL_DAY_K = [k for k, s in SLOTS.items() if not s["night"]]
    WORKED = {}

    for ei, e in enumerate(EMP):
        if e["kind"] == "night":
            continue
        prev_day_data = existing_day(req.storeId, prev_date) if prev_date else {}
        LA_prev[ei] = any_of_const(e["id"], prev_day_data, LATE_K)
        for di, d_str in enumerate(dates):
            if d_str in locked_set:
                day_data = existing_day(req.storeId, d_str)
                OP[ei, di] = any_of_const(e["id"], day_data, OPEN_K)
                LA[ei, di] = any_of_const(e["id"], day_data, LATE_K)
                WORKED[ei, di] = any_of_const(e["id"], day_data, ALL_DAY_K)
            else:
                OP[ei, di] = any_of_var(ei, di, OPEN_K, "op")
                LA[ei, di] = any_of_var(ei, di, LATE_K, "la")
                WORKED[ei, di] = any_of_var(ei, di, ALL_DAY_K, "wk")

    def chain_step(prev_active, worked, la, tag):
        """worked면 이 날의 la로 갱신, 쉬는 날이면 prev_active를 그대로 이어간다."""
        if isinstance(worked, int):
            return la if worked else prev_active
        nxt = m.NewBoolVar(tag)
        m.Add(nxt == la).OnlyEnforceIf(worked)
        m.Add(nxt == prev_active).OnlyEnforceIf(worked.Not())
        return nxt

    for ei, e in enumerate(EMP):
        if e["kind"] == "night":
            continue
        clo_terms = [mul_bool(LA_prev[ei], OP[ei, 0], f"clopre{ei}")] if D else []
        for di in range(D - 1):
            clo_terms.append(mul_bool(LA[ei, di], OP[ei, di + 1], f"clo{ei}_{di}"))
        if clo_terms:
            m.Add(sum(clo_terms) <= 1)

        if D == 0:
            continue
        # 마감-오픈-마감 금지: 캘린더상 바로 옆날이 아니라, 쉬는 날을 건너뛰고 그 직원이
        # 실제로 일한 바로 전날/다음날을 기준으로 같은 걸 검사한다. 마감→(휴무)→오픈→
        # (휴무)→마감처럼 반복되는 것도 생활 리듬이 흔들리므로 막아야 하기 때문이다.
        prev_active = {0: LA_prev[ei]}
        for di in range(D - 1):
            prev_active[di + 1] = chain_step(
                prev_active[di], WORKED[ei, di], LA[ei, di], f"pla{ei}_{di + 1}"
            )
        next_active = {D - 1: 0}
        for di in range(D - 2, -1, -1):
            next_active[di] = chain_step(
                next_active[di + 1], WORKED[ei, di + 1], LA[ei, di + 1], f"nla{ei}_{di}"
            )
        for di in range(D):
            m.Add(sum([prev_active[di], OP[ei, di], next_active[di]]) <= 2)

    # ---------- 10. 휴게 시각 (결정변수) ----------
    br = req.rules.break_
    BREAK_LEN = br.len
    FULL_DAY = [k for k, s in SLOTS.items() if not s["night"] and not s["half"]]

    brk = {}
    for ei, e in enumerate(EMP):
        if e["kind"] == "night":
            continue
        for di, d_str in enumerate(dates):
            if d_str in locked_set:
                continue  # 서버가 잠금일 휴게는 계산하지 않는다 (7.3: 프론트가 breakPlan으로 대체)
            avail_t = defaultdict(list)
            for key in FULL_DAY:
                v = X(ei, di, key)
                if v is None:
                    continue
                s = SLOTS[key]
                for t in range(s["frm"] + br.afterStart, s["to"] - BREAK_LEN - br.beforeEnd + 1):
                    avail_t[t].append(key)
            if not avail_t:
                continue
            for t, keys in avail_t.items():
                b = m.NewBoolVar(f"b{ei}_{di}_{t}")
                brk[ei, di, t] = b
                m.Add(b <= sum(X(ei, di, k) for k in keys))
            full = [X(ei, di, k) for k in FULL_DAY if X(ei, di, k) is not None]
            m.Add(sum(brk[ei, di, t] for t in avail_t) == sum(full))

    for di, d_str in enumerate(dates):
        if d_str in locked_set:
            continue
        for t in range(BPD):
            on = [b for (ei, dd, st), b in brk.items() if dd == di and st <= t < st + BREAK_LEN]
            if len(on) > br.concurrent:
                m.Add(sum(on) <= br.concurrent)

    # ---------- 11. 커버리지 부족 ----------
    def cover_expr(di, t):
        terms = []
        for key, s in SLOTS.items():
            if s["night"]:
                if s["frm"] <= t < BPD:
                    terms.append(slot_count(di, key))
                elif t < s["to"] - BPD:
                    terms.append(night_prev_count(di, key))
            else:
                if s["frm"] <= t < s["to"]:
                    terms.append(slot_count(di, key))
        return sum(terms) if terms else 0

    gap_terms, day_has_gap = [], []
    for di, d_str in enumerate(dates):
        dem = demand_curve(d_str)
        peak = is_peak(d_str)
        gs = []
        for t in range(BPD):
            need = dem[t]
            if need == 0:
                continue
            if di == 0 and t < tb(8) and req.assumePrevNightCovered:
                continue
            c = cover_expr(di, t)
            if isinstance(c, int):
                g = max(0, need - c)
            else:
                g = m.NewIntVar(0, need, f"gap{di}_{t}")
                m.Add(g >= need - c)
            gs.append(g)
            gap_terms.append((g, req.weights.gapPeak if peak else req.weights.gapWeekday))
        if not gs:
            day_has_gap.append(0)
        elif all(isinstance(g, int) for g in gs):
            day_has_gap.append(1 if sum(gs) > 0 else 0)
        else:
            hg = m.NewBoolVar(f"hasgap{di}")
            tot = m.NewIntVar(0, 999999, f"gtot{di}")
            m.Add(tot == sum(gs))
            m.Add(tot <= 999999 * hg)
            m.Add(tot >= hg)
            day_has_gap.append(hg)

    # ---------- 12. 바 인원 (휴게·빵 제외) ----------
    fr = req.rules.floor
    bd = req.rules.bread

    def floor_expr(di, t, bread):
        d_str = dates[di]
        terms = []
        for key, s in SLOTS.items():
            if s["night"]:
                # 자정을 넘겨 다음날 새벽까지 이어지는 야간도 바 인원에 넣는다.
                # cover_expr의 야간 처리(11절)와 같은 방식이다.
                if s["frm"] <= t < BPD:
                    terms.append(slot_count(di, key))
                elif t < s["to"] - BPD:
                    terms.append(night_prev_count(di, key))
                continue
            if not (s["frm"] <= t < s["to"]):
                continue
            terms.append(slot_count(di, key))
        out = sum(terms) if terms else 0
        if d_str not in locked_set:
            off = [b for (ei, dd, st), b in brk.items() if dd == di and st <= t < st + BREAK_LEN]
            if off:
                out = out - sum(off)
        if bread <= t < bread + bd.len:
            out = out - 1
        return out

    floor_short, over_terms = [], []
    for di, d_str in enumerate(dates):
        peak = is_peak(d_str)
        bread = bd.peak if peak else bd.weekday
        dem = demand_curve(d_str)
        for t in range(tb(8), tb(23)):
            fe = floor_expr(di, t, bread)
            if fr.from_ <= t < fr.until:
                if isinstance(fe, int):
                    sv = max(0, fr.min - fe)
                else:
                    sv = m.NewIntVar(0, fr.min, f"fs{di}_{t}")
                    m.Add(sv >= fr.min - fe)
                floor_short.append(sv)
            ceil = max(fr.ceil, dem[t])
            if isinstance(fe, int):
                ov = max(0, fe - ceil)
            else:
                ov = m.NewIntVar(0, E, f"ov{di}_{t}")
                m.Add(ov >= fe - ceil)
            over_terms.append(ov)

    # ---------- 12.5 바 인원 최소 보장 (사실상 하드, 정말 못 채우면 소프트로 완화) ----------
    # 금토일 12~17시는 최소 3명, 그 앞뒤(11~21시 나머지)는 최소 2명. 평일은 12~21시
    # 최소 2명. 기존 floor(11~17, 요일 무관, min 2, 12절)는 훨씬 약한 페널티라 부족해질
    # 수 있어서 별도로 건다. requireSlotFill과 같은 이유로 진짜 하드가 아니라 아주 무거운
    # 페널티로 둔다 — 채울 수 있으면 페널티가 다른 항을 압도해 사실상 하드지만, 인원이
    # 정말 모자라면 그 시간대만 미달로 남기고 나머지는 최선으로 채운다. 잠긴 날짜는
    # 서버가 못 바꾸는 확정 배치라 그대로 warnings로만 남긴다(사후 집계, 아래 참고).
    def hard_floor_need(d_str, t):
        if is_peak(d_str):
            if tb(12) <= t < tb(17):
                return 3
            if tb(11) <= t < tb(21):
                return 2
            return 0
        if tb(12) <= t < tb(21):
            return 2
        return 0

    hard_floor_shortfall = []
    for di, d_str in enumerate(dates):
        peak = is_peak(d_str)
        bread = bd.peak if peak else bd.weekday
        lo, hi = (tb(11), tb(21)) if peak else (tb(12), tb(21))
        for t in range(lo, hi):
            need_here = hard_floor_need(d_str, t)
            if need_here <= 0:
                continue
            fe = floor_expr(di, t, bread)
            if isinstance(fe, int):
                short = max(0, need_here - fe)
                if d_str in locked_set and short > 0:
                    infeasible_notes.append(
                        f"{d_str} {blabel(t)}: 잠긴 배치라 바 인원 {need_here}명을 못 채웁니다 "
                        f"(현재 {fe}명)."
                    )
                    continue
            else:
                short = m.NewIntVar(0, need_here, f"hfloor_{di}_{t}")
                m.Add(short >= need_here - fe)
            hard_floor_shortfall.append((short, d_str, t, need_here))

    # ---------- 13. 형평 (max-min) ----------
    home_ids = [ei for ei, e in enumerate(EMP) if e["storeId"] == req.storeId]
    if home_ids:
        cap_hi = 2 * req.rules.weekCap + max(0, req.rules.overtime.maxExtraUnits)
        lmax = m.NewIntVar(0, cap_hi, "lmax")
        lmin = m.NewIntVar(0, cap_hi, "lmin")
        m.AddMaxEquality(lmax, [load[ei] for ei in home_ids])
        m.AddMinEquality(lmin, [load[ei] for ei in home_ids])
        rng = m.NewIntVar(0, cap_hi, "rng")
        m.Add(rng == lmax - lmin)
    else:
        rng = 0

    # ---------- 13.5 남는 여력 최대한 활용 ----------
    # 인력이 빠듯한 상황에서 누군가 개인 상한을 다 못 채운 채 남고 다른 사람은
    # 초과근무까지 쓰는 건 비효율적이다. 형평(13절)은 사람들 사이 편차만 줄일 뿐
    # 상한까지 채우도록 밀어주진 않으므로, 남는 여력을 상한까지 채우도록 소프트로
    # 유도한다. 지원 인력(타 매장)은 이 매장 상한을 채울 이유가 없어 제외한다.
    under_week = {}
    for ei in home_ids:
        e = EMP[ei]
        cap_units = 2 * min(e["maxw"], req.rules.weekCap)
        uv = m.NewIntVar(0, cap_units, f"under{ei}")
        m.Add(uv >= cap_units - load[ei])
        under_week[ei] = uv

    # ---------- 14. 초과근무 ----------
    overtime_units = {}
    BIG = 1000  # 문제 규모가 작아 타이트한 도메인이 필요 없다. 넉넉히 잡아 domain 충돌을 피한다.
    for ei, e in enumerate(EMP):
        day_over = m.NewIntVar(-BIG, BIG, f"dayover{ei}")
        m.Add(day_over == load[ei] - 2 * e["maxw"])
        count_over = m.NewIntVar(-BIG, BIG, f"countover{ei}")
        m.Add(count_over == shift_count[ei] - e["maxw"])
        ov = m.NewIntVar(0, BIG, f"overunits{ei}")
        m.Add(ov >= day_over)
        m.Add(ov >= count_over)
        m.Add(ov >= 0)
        overtime_units[ei] = ov

    # ---------- 14.5 월~목 다 채우고 남는 여유를 일>토>금 순으로 ----------
    # 필요 인원을 다 채우고도 남는 선택의 여지(추가/여유 자리, 쩜오 포함, 특히 13.5절
    # underWeek가 밀어붙이는 남는 여력)가 있을 때 일>토>금 순으로 더 배치되길 바란다는
    # 요청을 목적함수의 보상(음수 비용)으로 반영한다. over(과잉 인원) 페널티의 요일별
    # 차이를 이길 만큼 충분히 세게 잡아야 실제로 방향을 튼다 — 너무 작으면 평일 쪽
    # over 페널티가 더 낮다는 이유만으로 평일로 새 버린다. 그래도 gapDay·overtime·
    # minWeek·underWeek보다는 약해서 그 항들의 우선순위는 뒤엎지 않는다. 야간은 대상 밖.
    w = req.weights
    WEEKEND_EXTRA_W = {6: w.weekendExtraSun, 5: w.weekendExtraSat, 4: w.weekendExtraFri}
    weekend_extra_terms = []
    for (eei, di, key), v in x.items():
        wt = WEEKEND_EXTRA_W.get(weekday_of(dates[di]))
        if wt and not SLOTS[key]["night"]:
            weekend_extra_terms.append((v, wt))

    # ---------- 목적함수 ----------
    obj = []
    obj += [int(round(w.requireFillShort)) * s for s, _, _, _ in fill_shortfall]
    obj += [int(round(w.hardFloorShort)) * s for s, _, _, _ in hard_floor_shortfall]
    obj += [int(round(wt * BUCKET)) * g for g, wt in gap_terms]
    obj += [int(round(w.gapDay)) * b for b in day_has_gap]
    obj += [int(round(w.floor * BUCKET)) * s for s in floor_short]
    obj += [int(round(w.over * BUCKET)) * o for o in over_terms]
    obj.append(int(round(w.fairness)) * rng)
    obj += [int(round(w.minWeek)) * s for s in minw_short.values()]
    obj += [int(round(w.overtime)) * ov for ov in overtime_units.values()]
    obj += [int(round(w.underWeek)) * u for u in under_week.values()]
    obj += [-int(round(wt)) * v for v, wt in weekend_extra_terms]
    m.Minimize(sum(obj))

    # ---------- 풀기 ----------
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = req.timeLimitSec
    solver.parameters.num_workers = 8
    solver.parameters.log_search_progress = False
    status = solver.Solve(m)
    wall = time.time() - t0

    warnings = list(infeasible_notes)
    if req.assumePrevNightCovered:
        warnings.append("첫날 00~08시는 지난주 야간이 채워진 것으로 가정했습니다.")
    if locked_set:
        warnings.append("잠금된 날짜는 휴게 시간을 서버가 재계산하지 않았습니다 (기존 배치 유지).")

    if status == cp_model.INFEASIBLE:
        return SolveResponse(status="INFEASIBLE", wallTimeSec=wall, warnings=warnings)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return SolveResponse(
            status="TIMEOUT", wallTimeSec=wall,
            warnings=warnings + ["시간 내에 해를 찾지 못했습니다."],
        )

    status_label = "OPTIMAL" if status == cp_model.OPTIMAL else "TIMEOUT"

    # 완화 제약(2.5, 12.5)이 실제로 못 채운 만큼을 사람이 읽을 수 있는 문장으로 남긴다.
    # "완전히 실패" 대신 이렇게 최선을 다한 결과에 어디가 비었는지 알려주는 목적.
    for short, d_str, label, need in fill_shortfall:
        val = _val(solver, short)
        if val > 0:
            warnings.append(f"{d_str} {label}: 필요 인원 {need}명 중 {val}명을 못 채웠습니다 (인력 부족).")
    for short, d_str, t, need_here in hard_floor_shortfall:
        val = _val(solver, short)
        if val > 0:
            warnings.append(
                f"{d_str} {blabel(t)}: 바 인원 최소 {need_here}명 중 {val}명을 못 채웠습니다 (인력 부족)."
            )

    # ---------- 결과 추출 ----------
    board = {req.storeId: {d: {} for d in dates}}
    for di, d_str in enumerate(dates):
        if d_str in locked_set:
            board[req.storeId][d_str] = existing_day(req.storeId, d_str)
            continue
        for key in SLOTS:
            ids = [EMP[ei]["id"] for ei in range(E)
                   if X(ei, di, key) is not None and solver.Value(X(ei, di, key))]
            if ids:
                board[req.storeId][d_str][key] = ids

    # 타 매장 야간 인력을 빌려온 경우, 그 직원 소속 매장 board에도 야간 배정을 남겨
    # (읽기 전용 문맥으로) 이중 배정을 막는다.
    for ei, e in enumerate(EMP):
        if e["storeId"] == req.storeId:
            continue
        for di, d_str in enumerate(dates):
            if d_str in locked_set:
                continue
            v = X(ei, di, "night")
            if v is not None and solver.Value(v):
                board.setdefault(e["storeId"], {}).setdefault(d_str, {}).setdefault("night", []).append(e["id"])

    breaks = defaultdict(list)
    for (ei, di, t), b in brk.items():
        if solver.Value(b):
            breaks[dates[di]].append({"empId": EMP[ei]["id"], "from": t, "to": t + BREAK_LEN})

    # ---------- 진단 ----------
    per_day = []
    for di, d_str in enumerate(dates):
        peak = is_peak(d_str)
        dem = demand_curve(d_str)
        gmin = 0
        for t in range(BPD):
            if dem[t] == 0:
                continue
            if di == 0 and t < tb(8) and req.assumePrevNightCovered:
                continue
            c = cover_expr(di, t)
            gmin += max(0, dem[t] - _val(solver, c)) * BUCKET
        bread = bd.peak if peak else bd.weekday
        floor_vals = [_val(solver, floor_expr(di, t, bread)) for t in range(fr.from_, fr.until)]
        over_min = 0
        for t in range(tb(8), tb(23)):
            fe = _val(solver, floor_expr(di, t, bread))
            over_min += max(0, fe - max(fr.ceil, dem[t])) * BUCKET
        per_day.append(PerDayDiag(
            date=d_str, peak=peak, gapMinutes=gmin,
            floorMin=min(floor_vals) if floor_vals else 0, overMinutes=over_min,
        ))

    per_emp = []
    for ei, e in enumerate(EMP):
        per_emp.append(PerEmployeeDiag(
            empId=e["id"],
            shifts=_val(solver, shift_count[ei]),
            cap=min(e["maxw"], req.rules.weekCap),
            workDays=_val(solver, load[ei]) / 2,
            # overUnits는 "0.5일당 1"인 원 단위 그대로 반환한다 (HANDOFF.md 5절: 초과근무 0.5일당 180점).
            overUnits=_val(solver, overtime_units[ei]),
            minShortfall=(_val(solver, minw_short[ei]) / 2 if ei in minw_short else 0),
        ))

    penalties = Penalties(
        gap=sum(int(round(wt * BUCKET)) * _val(solver, g) for g, wt in gap_terms),
        gapDays=sum(int(round(w.gapDay)) * _val(solver, b) for b in day_has_gap),
        floor=sum(int(round(w.floor * BUCKET)) * _val(solver, s) for s in floor_short),
        over=sum(int(round(w.over * BUCKET)) * _val(solver, o) for o in over_terms),
        fairness=int(round(w.fairness)) * _val(solver, rng),
        minWeek=sum(int(round(w.minWeek)) * _val(solver, s) for s in minw_short.values()),
        overtime=sum(int(round(w.overtime)) * _val(solver, ov) for ov in overtime_units.values()),
        weekendExtra=sum(-int(round(wt)) * _val(solver, v) for v, wt in weekend_extra_terms),
        underWeek=sum(int(round(w.underWeek)) * _val(solver, u) for u in under_week.values()),
        requireFillShort=sum(int(round(w.requireFillShort)) * _val(solver, s) for s, _, _, _ in fill_shortfall),
        hardFloorShort=sum(int(round(w.hardFloorShort)) * _val(solver, s) for s, _, _, _ in hard_floor_shortfall),
    )

    diagnostics = Diagnostics(perDay=per_day, perEmployee=per_emp, penalties=penalties)

    return SolveResponse(
        status=status_label,
        objective=solver.ObjectiveValue(),
        bound=solver.BestObjectiveBound(),
        wallTimeSec=wall,
        board=board,
        breaks=breaks,
        diagnostics=diagnostics,
        warnings=warnings,
    )
