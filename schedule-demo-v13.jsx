import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { health, solveWeek, SolveError } from "./src/api.js";
import { supabase, APP_STATE_ID } from "./src/supabaseClient.js";

/* ------------------------------------------------------------------
   색상 토큰
   ------------------------------------------------------------------ */
const INK = "#16202B";
const PAPER = "#F1F0EC";
const CARD = "#FBFAF7";
const RULE = "#D8D5CC";
const MUTED = "#6E7480";
const MARK = "#E9E44B";
const ALERT = "#B4472C";
const EMPTY = "#DEDCD4";
const FILLED = "#2F6F5E";
const GUEST = "#8A6A2F";
const TIGHT = "#C08A2E";

/* ------------------------------------------------------------------
   시간축. 하루를 30분 단위 48칸으로 쪼갠다
   ------------------------------------------------------------------ */
const BUCKET = 30;
const BPD = (24 * 60) / BUCKET;
const tb = (h, m = 0) => (h * 60 + m) / BUCKET;
function pad2(n) {
  return String(n).padStart(2, "0");
}
const bucketLabel = (i) => {
  const mins = i * BUCKET;
  return `${pad2(Math.floor(mins / 60) % 24)}:${pad2(mins % 60)}`;
};
// 표에 넣는 축약 표기. 8-18 처럼 시 단위로만 적는다
const rangeLabel = (s) =>
  `${Math.floor((s.from * BUCKET) / 60) % 24}-${Math.floor((s.to * BUCKET) / 60) % 24}`;

/* ------------------------------------------------------------------
   근무타입
   ------------------------------------------------------------------ */
const SHIFTS = [
  { key: "jjinO", label: "찐오", from: tb(8), to: tb(18), need: 1, extra: 0, open: true, color: "#2F6F5E" },
  { key: "earlyShort", label: "이른오전", from: tb(8), to: tb(15), need: 0, extra: 1, open: true, color: "#4A7C6F" },
  { key: "jjapO", label: "짭오", from: tb(9), to: tb(19), need: 1, peak: 1, extra: 0, open: true, color: "#3D5A98" },
  { key: "close", label: "마감", from: tb(12), to: tb(22), need: 1, peak: 1, extra: 0, late: true, color: "#B4472C" },
  { key: "thirteen", label: "13", from: tb(13), to: tb(23), need: 1, extra: 0, late: true, color: "#6B4A7A" },
  { key: "middle", label: "미들", from: tb(10), to: tb(20), need: 0, extra: 1, open: true, color: "#8A6A2F" },
  { key: "night", label: "야간", from: tb(22), to: tb(32), need: 1, extra: 0, night: true, color: "#16202B" },
];

const HALF = [
  { key: "halfAm", label: "오전쩜오", from: tb(8), to: tb(14), open: true, half: true, color: "#7A8290" },
  { key: "halfPm", label: "마감쩜오", from: tb(16), to: tb(22), late: true, half: true, color: "#7A8290" },
];

const ALL_SLOTS = [...SHIFTS, ...HALF].map((s) => ({ ...s, short: rangeLabel(s) }));
const slotInfo = (key) => ALL_SLOTS.find((s) => s.key === key);
const timeText = (s) => `${bucketLabel(s.from)}–${bucketLabel(s.to)}`;

// 마감만 여러 명이 같은 시각에 출근할 수 있다. 8시 출근(찐오/이른오전/오전쩜오)과
// 9시 출근(짭오)은 그 시각에 오직 한 명만 — 슬롯 종류가 달라도 마찬가지다.
const START_SHARED = ["close"];
function startTaken(day, slot) {
  if (START_SHARED.includes(slot.key)) return false;
  return ALL_SLOTS.some(
    (s) =>
      s.key !== slot.key &&
      s.from === slot.from &&
      !START_SHARED.includes(s.key) &&
      (day[s.key] || []).length > 0
  );
}

// 같은 from에 길이가 다른 대체 슬롯이 여럿(half 제외, 예: 찐오 8-18 / 이른오전
// 8-15)이면 그중 가장 긴 슬롯을 할 수 있는 사람은 짧은 쪽을 못 고르게 한다.
// 이른오전 같은 짧은 자리는 avail로 그만큼만 묶인 사람(배정서 등) 전용이다.
const LONGER_IN_GROUP = {};
{
  const byFrom = {};
  ALL_SLOTS.forEach((s) => {
    if (s.half) return;
    (byFrom[s.from] = byFrom[s.from] || []).push(s);
  });
  Object.values(byFrom).forEach((group) => {
    if (group.length < 2) return;
    const longest = group.reduce((a, b) => (b.to > a.to ? b : a));
    group.forEach((s) => {
      if (s.key !== longest.key) LONGER_IN_GROUP[s.key] = longest.key;
    });
  });
}

const WEEK_CAP = 6; // 어떤 경우에도 주 6일을 넘길 수 없다
// 자동 배정 시 여러 시드로 시도해 보고 가장 점수 낮은 걸 고른다.
// 1000회는 시작점(무작위 시드 기준점)에 따라 가끔 더 나쁜 결과에 걸렸다
// (같은 조건을 6번 반복 실행했을 때 1000회는 종종 나쁜 지역해에 빠졌지만,
// 2500회부터는 6번 다 똑같이 가장 좋은 결과를 찾았다). 그래서 2500으로 둔다.
const AUTO_TRIES = 2500;
const AUTO_CHUNK = 10; // 한 틱에 처리할 시도 수. 이 단위로 쪼개서 화면이 안 멈추게 한다
const FILL_ORDER = ["jjinO", "jjapO", "thirteen", "close", "earlyShort", "middle"];

/* ------------------------------------------------------------------
   날짜 유틸
   ------------------------------------------------------------------ */
const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => new Date(s + "T00:00:00");
const WD = ["월", "화", "수", "목", "금", "토", "일"];
const wdIndex = (d) => (d.getDay() + 6) % 7;

const isPeak = (dateStr) => wdIndex(parse(dateStr)) >= 4;
// 규칙 탭에서 바꾼 값을 담아 둔다. 없으면 슬롯 기본값을 쓴다
let NEED_OVERRIDE = {};
let DEMAND_CACHE = {};
function applyNeeds(next) {
  NEED_OVERRIDE = next;
  DEMAND_CACHE = {};
}
const rawNeed = (slot, peak) => {
  const o = NEED_OVERRIDE[slot.key];
  if (o) return peak ? o.peak : o.weekday;
  return peak && slot.peak != null ? slot.peak : slot.need;
};
const needOf = (slot, dateStr) => rawNeed(slot, isPeak(dateStr));

function canWork(e, slot, dateStr) {
  const win = isPeak(dateStr) ? e.avail?.peak : e.avail?.weekday;
  if (!win) return true;
  return slot.from >= win[0] && slot.to <= win[1];
}

function weekKey(dateStr) {
  const d = parse(dateStr);
  d.setDate(d.getDate() - wdIndex(d));
  return fmt(d);
}

function monthDates(year, month) {
  const last = new Date(year, month, 0).getDate();
  return Array.from({ length: last }, (_, i) => `${year}-${pad(month)}-${pad(i + 1)}`);
}

const shiftDate = (dateStr, diff) => {
  const d = parse(dateStr);
  d.setDate(d.getDate() + diff);
  return fmt(d);
};

// 달 앞뒤로 걸친 주까지 포함한 날짜 목록. 배정은 이 범위로 돌린다
function gridRange(year, month) {
  const md = monthDates(year, month);
  const out = [];
  let cur = weekKey(md[0]);
  const last = shiftDate(weekKey(md[md.length - 1]), 6);
  while (cur <= last) {
    out.push(cur);
    cur = shiftDate(cur, 1);
  }
  return out;
}

/* ------------------------------------------------------------------
   필요 인원 곡선
   ------------------------------------------------------------------ */
function buildDemand(peak) {
  const arr = new Array(BPD).fill(0);
  // from(시작 시각)별로 묶는다. 같은 from에 대체 가능한 슬롯이 여럿(찐오/이른오전/
  // 오전쩜오 같은 8시 그룹)이면 그중 하나만 그날 실제로 쓰인다(마감만 여러 명이
  // 같은 시각에 출근 가능 — startShared 참고). 그룹 대표(가장 긴 슬롯, 찐오)의
  // 전체 길이를 그대로 요구하면, 이른오전이 대신 배정된 날 그 차이 구간이 실제로는
  // 다음 그룹(짭오 등)이 이미 커버하는데도 "유령 부족"으로 잡힌다. 그래서 대체
  // 그룹은 그날 필요한 다음 그룹이 시작하는 시점까지만 전용 수요로 잡는다.
  const groups = {};
  ALL_SLOTS.forEach((s) => {
    if (s.half) return;
    (groups[s.from] = groups[s.from] || []).push(s);
  });
  const froms = Object.keys(groups)
    .map(Number)
    .sort((a, b) => a - b);
  froms.forEach((frm, idx) => {
    const keys = groups[frm];
    const n = Math.max(...keys.map((s) => rawNeed(s, peak)));
    if (!n) return;
    let capTo = Math.max(...keys.map((s) => s.to));
    const activeKeys = keys.filter((s) => !START_SHARED.includes(s.key));
    if (activeKeys.length >= 2) {
      for (const laterFrm of froms.slice(idx + 1)) {
        const laterN = Math.max(...groups[laterFrm].map((s) => rawNeed(s, peak)));
        if (laterN > 0) {
          capTo = Math.min(capTo, laterFrm);
          break;
        }
      }
    }
    for (let i = frm; i < capTo; i++) arr[i % BPD] += n;
  });
  return arr;
}
function demandFor(dateStr) {
  const k = isPeak(dateStr) ? "p" : "w";
  if (!DEMAND_CACHE[k]) DEMAND_CACHE[k] = buildDemand(k === "p");
  return DEMAND_CACHE[k];
}

/* ------------------------------------------------------------------
   휴게와 바 인원 기준
   ------------------------------------------------------------------ */
const BREAK_LEN = tb(1);
const OPEN_BREAK_AT = tb(12, 30);
const LATE_BREAK_AT = tb(15, 30);
const BREAD_LEN = tb(0, 30);
const FLOOR_FROM = tb(11); // 개점 직후는 한가하므로 이때부터 본다
const FLOOR_UNTIL = tb(17);
const FLOOR_MIN = 2;
const FLOOR_OK = 3;
const MAX_FLOOR = 3; // 평일 필수 최댓값과 같은, 동시 근무 최적 상한

function coverage(day, prevDay) {
  const arr = new Array(BPD).fill(0);
  const add = (from, to) => {
    for (let i = from; i < to; i++) if (i < BPD) arr[i] += 1;
  };
  Object.entries(day || {}).forEach(([key, ids]) => {
    const s = slotInfo(key);
    if (!s) return;
    ids.forEach(() => add(s.from, Math.min(s.to, BPD)));
  });
  const nightSlot = slotInfo("night");
  (prevDay?.night || []).forEach(() => add(0, nightSlot.to - BPD));
  return arr;
}

const gapOf = (cov, dateStr) => demandFor(dateStr).map((n, i) => Math.max(0, n - cov[i]));
const gapMinutes = (gap) => gap.reduce((a, b) => a + b, 0) * BUCKET;

function gapCut(slot, gap) {
  let n = 0;
  for (let i = slot.from; i < Math.min(slot.to, BPD); i++) if (gap[i] > 0) n += 1;
  return n;
}

function breakPlan(day) {
  const collect = (pred) =>
    ALL_SLOTS.filter(pred)
      .flatMap((s) => (day[s.key] || []).map((id) => ({ id, slot: s })))
      .sort((a, b) => a.slot.from - b.slot.from);

  // 쩜오는 6시간 근무라 휴게를 돌지 않는다
  const openers = collect((s) => s.open && !s.half);
  const closers = collect((s) => s.late && !s.half);

  const rows = [];
  let t = OPEN_BREAK_AT;
  openers.forEach(({ id, slot }) => {
    const from = Math.min(t, slot.to - BREAK_LEN);
    rows.push({ empId: id, slotKey: slot.key, from, to: from + BREAK_LEN });
    t += BREAK_LEN;
  });
  t = Math.max(LATE_BREAK_AT, t);
  closers.forEach(({ id, slot }) => {
    const from = Math.min(t, slot.to - BREAK_LEN);
    rows.push({ empId: id, slotKey: slot.key, from, to: from + BREAK_LEN });
    t += BREAK_LEN;
  });
  return rows;
}

// 휴게·빵으로 빠지기 전, 그 시간에 출근해 있는 인원(야간 제외)
// prevDay: 전날 배정(야간이 자정을 넘겨 오늘 새벽까지 이어지는 걸 반영하기 위함).
// coverage()의 야간 처리와 같은 방식이다.
function staffOnFloor(day, prevDay) {
  const arr = new Array(BPD).fill(0);
  Object.entries(day || {}).forEach(([key, ids]) => {
    const s = slotInfo(key);
    if (!s) return;
    if (s.night) return; // 야간은 아래에서 겹침(자정 넘김)까지 따로 처리
    ids.forEach(() => {
      for (let i = s.from; i < Math.min(s.to, BPD); i++) arr[i] += 1;
    });
  });
  const nightSlot = slotInfo("night");
  (day?.night || []).forEach(() => {
    for (let i = nightSlot.from; i < BPD; i++) arr[i] += 1;
  });
  (prevDay?.night || []).forEach(() => {
    for (let i = 0; i < nightSlot.to - BPD; i++) arr[i] += 1;
  });
  return arr;
}

function floorCurve(day, breaks, breadAt, prevDay) {
  const arr = staffOnFloor(day, prevDay);
  breaks.forEach((b) => {
    for (let i = b.from; i < Math.min(b.to, BPD); i++) arr[i] -= 1;
  });
  for (let i = breadAt; i < Math.min(breadAt + BREAD_LEN, BPD); i++) arr[i] -= 1;
  return arr;
}

function floorGap(floor) {
  return floor.map((n, i) =>
    i >= FLOOR_FROM && i < FLOOR_UNTIL ? Math.max(0, FLOOR_MIN - n) : 0
  );
}

/* ------------------------------------------------------------------
   초기 데이터
   ------------------------------------------------------------------ */
const STORES = [
  { id: "sinjung", name: "신중동점" },
  { id: "songdo", name: "송도점 (샘플)" },
];
const storeName = (id) => STORES.find((s) => s.id === id)?.name || id;

const NOW = new Date();
const THIS_MONTH = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}`;

let seq = 0;
const mk = (storeId, name, opt = {}) => ({
  id: ++seq,
  storeId,
  name,
  kind: opt.kind || "day",
  maxPerWeek: opt.maxPerWeek ?? 5,
  minPerWeek: opt.minPerWeek ?? 0,
  maxWeekday: opt.maxWeekday ?? null, // 평일(비피크)만 따로 거는 상한. null이면 제한 없음
  maxHalf: opt.maxHalf ?? 4,
  canEightStart: opt.canEightStart ?? true, // 8시 시작 자리(찐오/이른오전/오전쩜오) 전부에 대한 자격
  isRookie: opt.isRookie ?? false, // 신입 여부. 신입 둘이 같은 날 오픈조(8시+9시)를 못 나눠 맡음
  until: opt.until || null,
  avail: opt.avail || { weekday: null, peak: null },
  fixedDays: opt.fixedDays || [],
  pins: opt.pins || {},
  vacations: [],
});

const INITIAL_EMPLOYEES = [
  mk("sinjung", "김선우", { fixedDays: [1, 3, 6] }), // 화, 목, 일 발주
  mk("sinjung", "김규리"),
  mk("sinjung", "김호찬"),
  mk("sinjung", "탁류빈", {
    canEightStart: false,
    until: `${THIS_MONTH}-22`,
    pins: { [`${THIS_MONTH}-22`]: "jjapO" },
  }),
  mk("sinjung", "나수미", { canEightStart: false, isRookie: true }),
  mk("sinjung", "배정서", {
    // 찐오는 못 하지만 8-15(이른오전)는 avail로 못박아 그것만 하는 사람이라 예외로 둔다.
    canEightStart: true,
    isRookie: true,
    minPerWeek: 3,
    maxPerWeek: 4, // 평일+주말 합쳐 최대 4번
    maxWeekday: 3, // 평일만 최대 3번
    maxHalf: 0, // 쩜오(8-14)로 쪼개지 않고 무조건 이른오전(8-15)로만 들어가게
    avail: { weekday: [tb(8), tb(15)], peak: [tb(8), tb(15)] },
  }),
  mk("sinjung", "조은솔", {
    kind: "night",
    maxHalf: 0,
    canEightStart: false,
    minPerWeek: 6, // 무조건 주 6일 — 나머지 하루만 타 매장 지원으로 채운다
    maxPerWeek: 6,
  }),

  mk("songdo", "김서준"),
  mk("songdo", "이하윤"),
  mk("songdo", "박도현"),
  mk("songdo", "최수아", { maxPerWeek: 4, maxHalf: 2 }),
  mk("songdo", "정민재"),
  mk("songdo", "한지우"),
  mk("songdo", "오세라"),
  mk("songdo", "윤태경", { canEightStart: false }),
  mk("songdo", "강백호", { kind: "night", maxHalf: 0, canEightStart: false }),
  mk("songdo", "신유리", { kind: "night", maxHalf: 0, canEightStart: false }),
];

/* ------------------------------------------------------------------
   DB(Supabase) 직렬화 — 직원 객체 <-> employees 테이블 행
   ------------------------------------------------------------------ */
function empToDb(e) {
  return {
    id: e.id,
    store_id: e.storeId,
    name: e.name,
    kind: e.kind,
    max_per_week: e.maxPerWeek,
    min_per_week: e.minPerWeek,
    max_weekday: e.maxWeekday,
    max_half: e.maxHalf,
    can_eight_start: e.canEightStart,
    is_rookie: e.isRookie,
    until: e.until,
    avail: e.avail,
    fixed_days: e.fixedDays,
    pins: e.pins,
    vacations: e.vacations,
  };
}
function empFromDb(r) {
  return {
    id: r.id,
    storeId: r.store_id,
    name: r.name,
    kind: r.kind,
    maxPerWeek: r.max_per_week,
    minPerWeek: r.min_per_week,
    maxWeekday: r.max_weekday,
    maxHalf: r.max_half,
    canEightStart: r.can_eight_start,
    isRookie: r.is_rookie || false,
    until: r.until,
    avail: r.avail || { weekday: null, peak: null },
    fixedDays: r.fixed_days || [],
    pins: r.pins || {},
    vacations: r.vacations || [],
  };
}
// 배정표·설정 등 나머지 전체 상태는 app_state 테이블 한 행에 통째로 담는다
function appStateToDb({ board, lockMap, needs, breadWeekday, breadPeak, shortage, serverBreaks }) {
  return {
    id: APP_STATE_ID,
    board,
    lock_map: lockMap,
    needs,
    bread_weekday: breadWeekday,
    bread_peak: breadPeak,
    shortage,
    server_breaks: serverBreaks,
  };
}

/* ------------------------------------------------------------------
   자동 배정
   ------------------------------------------------------------------ */
// 같은 조건이면 늘 같은 답이 나오지 않도록 시드를 쓴다
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function autoAssignAll({
  dates,
  employees,
  prevBoard,
  lockMap,
  shortage,
  breadWeekday,
  breadPeak,
  seed = 1,
}) {
  const rng = mulberry32(seed);
  const jitter = {};
  const jOf = (id, date) => {
    const k = `${id}|${date}`;
    if (jitter[k] === undefined) jitter[k] = rng();
    return jitter[k];
  };
  const board = {};
  STORES.forEach((s) => (board[s.id] = {}));

  const weekCount = {};
  const total = {};
  const halfCount = {};
  const cloCount = {};
  const busyOn = {};

  const breadAtOf = (date) => (isPeak(date) ? breadPeak : breadWeekday);
  const useSet = (date) => (busyOn[date] = busyOn[date] || new Set());
  const wcOf = (id, date) => weekCount[`${id}|${weekKey(date)}`] || 0;
  const bump = (id, date, isHalf) => {
    const k = `${id}|${weekKey(date)}`;
    weekCount[k] = (weekCount[k] || 0) + (isHalf ? 0.5 : 1);
    total[id] = (total[id] || 0) + (isHalf ? 0.5 : 1);
    if (isHalf) halfCount[id] = (halfCount[id] || 0) + 1;
  };

  const slotsOn = (empId, date) => {
    const keys = [];
    STORES.forEach((s) => {
      Object.entries(board[s.id][date] || {}).forEach(([k, ids]) => {
        if (ids.includes(empId)) keys.push(k);
      });
    });
    return keys;
  };
  const isLateOn = (id, date) => slotsOn(id, date).some((k) => slotInfo(k).late);
  const isOpenOn = (id, date) => slotsOn(id, date).some((k) => slotInfo(k).open);

  // 마감 다음날 오픈이 성립하면 그 주 식별자를 돌려준다
  const clopenWeek = (id, date, slot) => {
    if (slot.open && isLateOn(id, shiftDate(date, -1))) return weekKey(date);
    if (slot.late && isOpenOn(id, shiftDate(date, 1))) return weekKey(shiftDate(date, 1));
    return null;
  };
  const clopenBlocked = (id, date, slot) => {
    const wk = clopenWeek(id, date, slot);
    return wk ? (cloCount[`${id}|${wk}`] || 0) >= 1 : false;
  };

  // 마감 - 오픈 - 마감 3일 패턴은 아예 만들지 않는다
  const sandwichBlocked = (id, date, slot) => {
    if (slot.late) {
      if (isOpenOn(id, shiftDate(date, -1)) && isLateOn(id, shiftDate(date, -2))) return true;
      if (isOpenOn(id, shiftDate(date, 1)) && isLateOn(id, shiftDate(date, 2))) return true;
    }
    if (slot.open) {
      if (isLateOn(id, shiftDate(date, -1)) && isLateOn(id, shiftDate(date, 1))) return true;
    }
    return false;
  };

  STORES.forEach((s) => {
    dates.forEach((date) => {
      if (!(lockMap[s.id] || {})[date]) return;
      const day = (prevBoard[s.id] || {})[date] || {};
      board[s.id][date] = day;
      Object.entries(day).forEach(([slot, ids]) =>
        ids.forEach((id) => {
          bump(id, date, slot.startsWith("half"));
          useSet(date).add(id);
        })
      );
    });
  });

  // dates 범위가 한 주뿐이어도(주간 배정) 마감-오픈 연속 근무 판정이 무너지지
  // 않도록, 그 범위 바로 앞뒤 하루씩은 실제 기존 배정을 읽기 전용으로 심어둔다.
  // weekCount 등 집계에는 넣지 않는다 — 이 두 날짜는 이번 배정 대상이 아니다.
  STORES.forEach((s) => {
    const before = shiftDate(dates[0], -1);
    const after = shiftDate(dates[dates.length - 1], 1);
    [before, after].forEach((d) => {
      if (!board[s.id][d]) board[s.id][d] = (prevBoard[s.id] || {})[d] || {};
    });
  });

  // 주 안에서 뒤로 밀리는 요일이 매번 목요일로 고정되지 않도록 섞는다
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // 주 단위로 묶고 금토일을 앞으로 보낸다. 인력이 빠듯한 주는 그룹 안 순서에 따라
  // 어느 요일이 뒤로 밀릴지가 갈리므로, 시드마다 그 순서를 바꿔가며 시도해 본다.
  const weeks = {};
  dates.forEach((d) => {
    const k = weekKey(d);
    (weeks[k] = weeks[k] || []).push(d);
  });
  const ordered = [];
  Object.keys(weeks)
    .sort()
    .forEach((k) => {
      const ds = weeks[k];
      ordered.push(...shuffle(ds.filter(isPeak)), ...shuffle(ds.filter((d) => !isPeak(d))));
    });

  // 그 주에 필수 자리를 다 채우고도 인력이 남는지 미리 본다
  const weekSlack = {};
  const weekBuckets = {};
  dates.forEach((d) => {
    const k = weekKey(d);
    (weekBuckets[k] = weekBuckets[k] || []).push(d);
  });
  STORES.forEach((store) => {
    Object.entries(weekBuckets).forEach(([wk, ds]) => {
      let demand = 0;
      ds.forEach((d) =>
        ALL_SLOTS.forEach((s) => {
          if (s.half || s.night) return;
          demand += needOf(s, d);
        })
      );
      const supply = employees
        .filter((e) => e.storeId === store.id && e.kind === "day")
        .reduce((a, e) => {
          const usable = ds.filter(
            (d) => !e.vacations.includes(d) && (!e.until || d <= e.until)
          ).length;
          return a + Math.min(e.maxPerWeek, WEEK_CAP, usable);
        }, 0);
      weekSlack[`${store.id}|${wk}`] = supply - demand;
    });
  });

  const pool = (storeId, slot, date, { capBonus = 0, foreign = false } = {}) => {
    if (startTaken(board[storeId][date] || {}, slot)) return [];
    // 쩜오는 0.5일이므로 넣은 뒤 값이 상한을 넘지 않는지로 판단한다
    const unit = slot.half ? 0.5 : 1;
    return employees
      .filter((e) => (foreign ? e.storeId !== storeId : e.storeId === storeId))
      .filter((e) => (slot.night ? e.kind === "night" : e.kind === "day"))
      .filter((e) => !e.until || date <= e.until)
      .filter((e) => slot.from !== tb(8) || slot.night || e.canEightStart)
      .filter((e) => !e.vacations.includes(date))
      .filter((e) => !useSet(date).has(e.id))
      .filter((e) => canWork(e, slot, date))
      .filter((e) => !clopenBlocked(e.id, date, slot))
      .filter((e) => !sandwichBlocked(e.id, date, slot))
      // 개인 상한과 전체 상한 중 낮은 쪽을 쓴다
      .filter((e) => wcOf(e.id, date) + unit <= Math.min(e.maxPerWeek + capBonus, WEEK_CAP))
      .sort((a, b) => {
        const am = wcOf(a.id, date) < a.minPerWeek ? 0 : 1;
        const bm = wcOf(b.id, date) < b.minPerWeek ? 0 : 1;
        if (am !== bm) return am - bm;
        const dt = (total[a.id] || 0) - (total[b.id] || 0);
        if (dt !== 0) return dt;
        const dw = wcOf(a.id, date) - wcOf(b.id, date);
        if (dw !== 0) return dw;
        return jOf(a.id, date) - jOf(b.id, date);
      });
  };

  const place = (storeId, date, key, list, isHalf = false) => {
    const slot = slotInfo(key);
    const day = (board[storeId][date] = board[storeId][date] || {});
    list.forEach((e) => {
      const wk = clopenWeek(e.id, date, slot);
      if (wk) cloCount[`${e.id}|${wk}`] = (cloCount[`${e.id}|${wk}`] || 0) + 1;
      useSet(date).add(e.id);
      bump(e.id, date, isHalf);
    });
    day[key] = [...(day[key] || []), ...list.map((e) => e.id)];
  };

  const placeAnywhere = (storeId, date, day, e) => {
    if (wcOf(e.id, date) + 1 > Math.min(e.maxPerWeek, WEEK_CAP)) return false;
    for (const key of FILL_ORDER) {
      const slot = slotInfo(key);
      if (needOf(slot, date) + slot.extra - (day[key] || []).length <= 0) continue;
      if (startTaken(day, slot)) continue;
      if (slot.from === tb(8) && !slot.night && !e.canEightStart) continue;
      if (!canWork(e, slot, date)) continue;
      if (clopenBlocked(e.id, date, slot)) continue;
      if (sandwichBlocked(e.id, date, slot)) continue;
      place(storeId, date, key, [e]);
      return true;
    }
    return false;
  };

  const combinedGap = (day, prevDayObj, date) => {
    const g1 = gapOf(coverage(day, prevDayObj), date);
    const g2 = floorGap(floorCurve(day, breakPlan(day), breadAtOf(date)));
    return g1.map((v, i) => Math.max(v, g2[i]));
  };

  // 이미 충분한 시간대만 더 채우려는 건지(순수 패딩) 판단한다.
  // 상한은 MAX_FLOOR와 실제 필요 인원 중 큰 쪽이라 금토일 필수 커버리지는 막지 않는다.
  const overCap = (day, date, slot) => {
    const floor = floorCurve(day, breakPlan(day), breadAtOf(date));
    const demand = demandFor(date);
    for (let i = slot.from; i < Math.min(slot.to, BPD); i++) {
      const ceil = Math.max(MAX_FLOOR, demand[i] || 0);
      if (floor[i] < ceil) return false;
    }
    return true;
  };

  const isLocked = (storeId, date) => !!(lockMap[storeId] || {})[date];

  for (const date of ordered) {
    const nightSlot = slotInfo("night");

    // 1단계: 모든 매장 야간부터. 자기 매장 → 주6일 → 타 매장 지원
    for (const store of STORES) {
      if (isLocked(store.id, date)) continue;
      board[store.id][date] = board[store.id][date] || {};
      let want = needOf(nightSlot, date) - (board[store.id][date].night || []).length;
      if (want <= 0) continue;
      const attempts = [
        { capBonus: 0, foreign: false },
        { capBonus: 1, foreign: false },
        { capBonus: 0, foreign: true },
        { capBonus: 1, foreign: true },
      ];
      for (const opt of attempts) {
        if (want <= 0) break;
        const picks = pool(store.id, nightSlot, date, opt).slice(0, want);
        if (picks.length === 0) continue;
        place(store.id, date, "night", picks);
        want -= picks.length;
      }
    }

    // 2단계: 매장별 주간 배정
    for (const store of STORES) {
      if (isLocked(store.id, date)) continue;
      const day = (board[store.id][date] = board[store.id][date] || {});
      const prevDayObj = board[store.id][shiftDate(date, -1)] || {};
      const wd = wdIndex(parse(date));

      const dayStaff = (extra = () => true) =>
        employees
          .filter((e) => e.storeId === store.id && e.kind === "day")
          .filter((e) => !e.until || date <= e.until)
          .filter((e) => !e.vacations.includes(date))
          .filter((e) => !useSet(date).has(e.id))
          .filter(extra);

      // 못박은 근무가 가장 먼저
      employees
        .filter((e) => e.storeId === store.id && e.pins?.[date])
        .filter((e) => !e.vacations.includes(date))
        .filter((e) => !useSet(date).has(e.id))
        .forEach((e) => place(store.id, date, e.pins[date], [e]));

      // 고정 근무 요일
      dayStaff((e) => (e.fixedDays || []).includes(wd)).forEach((e) =>
        placeAnywhere(store.id, date, day, e)
      );

      // 주 최소 근무일이 걸린 사람은 자리 경쟁에서 밀리기 쉬워 먼저 넣는다
      dayStaff((e) => e.minPerWeek > 0 && wcOf(e.id, date) < e.minPerWeek)
        .sort((a, b) => (total[a.id] || 0) - (total[b.id] || 0))
        .forEach((e) => placeAnywhere(store.id, date, day, e));

      // 필수 인원. 13(마감보다 1시간 늦게 끝남)을 마감보다 먼저 채운다.
      // 사람이 한 명만 남는 날, 마감이 이기면 22~23시가 비지만 13이 이기면
      // 그 시간까지 커버된다. (아래 '판단 기준' 설명 참고: 매 순간 실제
      // 부족분을 계산해서 고르는 방식도 시도해봤지만, 이 상황은 여러 자리가
      // 수학적으로 완전히 동점이라 결국 순서로 결판나는 경우였다. 그래서
      // 정교한 계산 대신, 여러 조건으로 검증해 항상 같거나 나은 이 순서를 쓴다.)
      for (const key of FILL_ORDER) {
        const slot = slotInfo(key);
        const want = needOf(slot, date) - (day[key] || []).length;
        if (want <= 0) continue;
        place(store.id, date, key, pool(store.id, slot, date).slice(0, want));
      }

      // 여유분. 그 주에 인력이 남고, 실제로 그 시간대가 부족할 때만 쓴다
      if ((weekSlack[`${store.id}|${weekKey(date)}`] || 0) > 0) {
        for (const key of FILL_ORDER) {
          const slot = slotInfo(key);
          const room = needOf(slot, date) + slot.extra - (day[key] || []).length;
          if (room <= 0) continue;
          if (gapCut(slot, combinedGap(day, prevDayObj, date)) < 1) continue;
          if (overCap(day, date, slot)) continue;
          place(store.id, date, key, pool(store.id, slot, date).slice(0, room));
        }
      }

      // 금토일은 비면 안 되므로 설정과 무관하게 총동원
      const mode = isPeak(date) ? "both" : shortage;
      const useHalf = mode !== "leave" && (mode === "half" || mode === "both");
      const useExtra = mode !== "leave" && (mode === "extra" || mode === "both");

      if (useHalf) {
        for (let round = 0; round < 4; round++) {
          const gap = combinedGap(day, prevDayObj, date);
          if (gapMinutes(gap) === 0) break;
          const ranked = HALF.map((h) => ({ h: slotInfo(h.key), cut: gapCut(slotInfo(h.key), gap) }))
            .filter((r) => r.cut > 0 && !overCap(day, date, r.h))
            .sort((a, b) => b.cut - a.cut);
          if (ranked.length === 0) break;

          let placed = false;
          for (const { h } of ranked) {
            const pick = pool(store.id, h, date, { capBonus: 1 }).find(
              (e) => (halfCount[e.id] || 0) < e.maxHalf
            );
            if (!pick) continue;
            place(store.id, date, h.key, [pick], true);
            placed = true;
            break;
          }
          if (!placed) break;
        }
      }

      if (useExtra) {
        for (const key of FILL_ORDER) {
          const slot = slotInfo(key);
          const room = needOf(slot, date) + slot.extra - (day[key] || []).length;
          if (room <= 0) continue;
          // 30분짜리 구멍 하나 때문에 사람을 통째로 넣지는 않는다
          if (gapCut(slot, combinedGap(day, prevDayObj, date)) < 2) continue;
          if (overCap(day, date, slot)) continue;
          place(store.id, date, key, pool(store.id, slot, date, { capBonus: 1 }).slice(0, 1));
        }
      }

    }
  }

  return board;
}

/* ------------------------------------------------------------------
   결과 채점. 값이 낮을수록 좋은 근무표
   ------------------------------------------------------------------ */
function scoreBoard(board, dates, employees, breadWeekday, breadPeak) {
  let penalty = 0;
  const perEmp = {};

  STORES.forEach((st) =>
    dates.forEach((d) => {
      const day = board[st.id][d] || {};
      const prev = board[st.id][shiftDate(d, -1)] || {};
      const dayGapMin = gapMinutes(gapOf(coverage(day, prev), d));
      // 금토일 결손은 훨씬 무겁게 본다
      penalty += dayGapMin * (isPeak(d) ? 4 : 1);
      // 총 부족 시간이 같다면, 여러 날에 흩어지는 것보다 하루에 몰리는 쪽이
      // 손보기 쉬우므로 부족이 걸리는 날 수 자체에도 약하게 감점을 준다
      if (dayGapMin > 0) penalty += 20;
      const floor = floorCurve(day, breakPlan(day), isPeak(d) ? breadPeak : breadWeekday);
      penalty += gapMinutes(floorGap(floor)) * 2;
      // 필요 이상으로 사람이 몰리는 시간대도 감점 (적은 인원을 효율적으로 쓰기 위함)
      const demand = demandFor(d);
      floor.forEach((n, i) => {
        const ceil = Math.max(MAX_FLOOR, demand[i] || 0);
        if (n > ceil) penalty += (n - ceil) * BUCKET * 1.5;
      });
      Object.entries(day).forEach(([slot, ids]) =>
        ids.forEach((id) => {
          perEmp[id] = (perEmp[id] || 0) + (slot.startsWith("half") ? 0.5 : 1);
        })
      );
    })
  );

  // 근무일수가 사람마다 들쭉날쭉하면 감점
  const vals = employees.map((e) => perEmp[e.id] || 0);
  const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  penalty += (vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length || 1)) * 40;

  return penalty;
}

/* ------------------------------------------------------------------
   이력 스냅샷 표시 (읽기 전용) — 직원 탭/규칙 탭과 같은 필드를 그대로 보여주되
   버튼 대신 텍스트로. 이력 팝업에서만 쓴다.
   ------------------------------------------------------------------ */
function SnapshotEmployeeCard({ e }) {
  return (
    <div className="rounded-lg p-3" style={{ background: CARD, border: `1px solid ${RULE}` }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{e.name}</span>
        {e.until && (
          <span
            className="rounded px-1 py-[1px] font-mono text-[10px]"
            style={{ background: "#F7E6E1", color: ALERT }}
          >
            {e.until.slice(5).replace("-", "/")}까지
          </span>
        )}
        {Object.keys(e.pins || {}).length > 0 && (
          <span
            className="rounded px-1 py-[1px] font-mono text-[10px]"
            style={{ background: "#E4EDE9", color: FILLED }}
          >
            {Object.entries(e.pins)
              .map(([d, k]) => `${Number(d.slice(8))}일 ${slotInfo(k)?.label ?? k}`)
              .join(", ")}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px]" style={{ color: MUTED }}>
          {e.kind === "night" ? "야간" : "주간"}
        </span>
      </div>

      {e.kind === "day" && (
        <div
          className="mt-2 font-mono text-[11px]"
          style={{ color: e.canEightStart ? FILLED : MUTED }}
        >
          8시 시작 {e.canEightStart ? "가능" : "불가"}
        </div>
      )}
      {e.isRookie && (
        <div className="mt-1 font-mono text-[11px]" style={{ color: GUEST }}>
          신입
        </div>
      )}

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]" style={{ color: MUTED }}>
        <div>
          주 최대 <span style={{ color: INK }}>{e.maxPerWeek}</span>
        </div>
        <div>
          주 최소 <span style={{ color: INK }}>{e.minPerWeek}</span>
        </div>
        <div>
          평일 최대 <span style={{ color: INK }}>{e.maxWeekday ?? "제한없음"}</span>
        </div>
        <div>
          쩜오 상한 <span style={{ color: INK }}>{e.maxHalf}</span>
        </div>
      </div>

      <div className="mt-2 font-mono text-[11px]" style={{ color: MUTED }}>
        가능 시간 · 평일{" "}
        {e.avail?.weekday
          ? `${bucketLabel(e.avail.weekday[0])}~${bucketLabel(e.avail.weekday[1])}`
          : "종일"}{" "}
        / 금토일{" "}
        {e.avail?.peak ? `${bucketLabel(e.avail.peak[0])}~${bucketLabel(e.avail.peak[1])}` : "종일"}
      </div>

      {(e.fixedDays || []).length > 0 && (
        <div className="mt-2 font-mono text-[11px]" style={{ color: MUTED }}>
          고정 요일 · {e.fixedDays.map((i) => WD[i]).join(", ")}
        </div>
      )}

      {(e.vacations || []).length > 0 && (
        <div className="mt-2 font-mono text-[11px]" style={{ color: MUTED }}>
          휴가 · {e.vacations.map((d) => d.slice(5).replace("-", "/")).join(", ")}
        </div>
      )}
    </div>
  );
}

function SnapshotRules({ rules, needs }) {
  const shortageLabel = {
    leave: "비워두기",
    half: "쩜오만",
    extra: "하루 더만",
    both: "쩜오 먼저, 그래도 모자라면 하루 더",
  }[rules.shortage];
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg p-4" style={{ background: CARD, border: `1px solid ${RULE}` }}>
        <div className="text-sm font-semibold">근무타입</div>
        <div className="mt-1 font-mono text-[10px]" style={{ color: MUTED }}>
          평일 / 금토일
        </div>
        <div className="mt-2 flex flex-col gap-1">
          {ALL_SLOTS.map((s) => (
            <div key={s.key} className="flex items-center gap-2 py-1">
              <span
                className="w-9 rounded text-center font-mono text-[9px] font-semibold"
                style={{ background: s.color, color: PAPER }}
              >
                {s.short}
              </span>
              <span className="w-14 text-xs font-medium">{s.label}</span>
              <span className="font-mono text-[11px]" style={{ color: MUTED }}>
                {timeText(s)}
              </span>
              <span className="ml-auto font-mono text-[11px]" style={{ color: MUTED }}>
                {s.half ? "보충" : `${needs?.[s.key]?.weekday ?? 0} / ${needs?.[s.key]?.peak ?? 0}명`}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg p-4" style={{ background: CARD, border: `1px solid ${RULE}` }}>
        <div className="text-sm font-semibold">연속 근무·휴게·빵</div>
        <div className="mt-2 font-mono text-[11px] leading-relaxed" style={{ color: MUTED }}>
          주 근무일 상한 {rules.weekCap}일 · 초과근무 허용 +{rules.overtime?.maxExtraShifts}회 / +
          {rules.overtime?.maxExtraUnits}단위
          <br />
          바 인원 기준 {rules.floor?.from != null ? bucketLabel(rules.floor.from) : "-"}~
          {rules.floor?.until != null ? bucketLabel(rules.floor.until) : "-"} 최소 {rules.floor?.min}명
          / 상한 {rules.floor?.ceil}명
          <br />
          빵 배송 · 평일 {rules.bread?.weekday != null ? bucketLabel(rules.bread.weekday) : "-"} / 금토일{" "}
          {rules.bread?.peak != null ? bucketLabel(rules.bread.peak) : "-"}
        </div>
      </div>

      <div className="rounded-lg p-4" style={{ background: CARD, border: `1px solid ${RULE}` }}>
        <div className="text-sm font-semibold">평일에 인원이 모자랄 때</div>
        <div className="mt-2 font-mono text-[11px]" style={{ color: MUTED }}>
          {shortageLabel ?? rules.shortage} · requireSlotFill {String(rules.requireSlotFill)}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
   화면
   ------------------------------------------------------------------ */
export default function ScheduleDemo() {
  const [year, setYear] = useState(NOW.getFullYear());
  const [month, setMonth] = useState(NOW.getMonth() + 1);
  const [view, setView] = useState("week"); // week | month
  const [weekStart, setWeekStart] = useState(weekKey(fmt(NOW)));
  const [storeId, setStoreId] = useState(STORES[0].id);
  const [employees, setEmployees] = useState(INITIAL_EMPLOYEES);
  const [board, setBoard] = useState({});
  const [lockMap, setLockMap] = useState({});
  const [autoMap, setAutoMap] = useState({});
  const [autoBusy, setAutoBusy] = useState(false);
  const [serverBreaks, setServerBreaks] = useState({}); // date -> [{empId,from,to}], 서버가 계산한 휴게
  const [diagnostics, setDiagnostics] = useState(null); // 마지막 계산 결과의 penalties/perDay 등
  const [solveMeta, setSolveMeta] = useState(null); // { status, objective, bound, wallTimeSec, warnings }
  const [solveError, setSolveError] = useState(null);
  const [serverOk, setServerOk] = useState(null); // null=확인중 | true | false
  const [copyStatus, setCopyStatus] = useState("idle"); // idle | copied | error
  const [selected, setSelected] = useState(null);
  const [picker, setPicker] = useState(null);
  const [tab, setTab] = useState("board");
  const [vacFor, setVacFor] = useState(null);
  const [shortage, setShortage] = useState("both");
  const [breadWeekday, setBreadWeekday] = useState(tb(16));
  const [breadPeak, setBreadPeak] = useState(tb(17, 30));
  const [needs, setNeeds] = useState(() => {
    const o = {};
    ALL_SLOTS.forEach((sl) => {
      if (sl.half) return;
      o[sl.key] = { weekday: sl.need, peak: sl.peak != null ? sl.peak : sl.need };
    });
    applyNeeds(o);
    return o;
  });

  const demandWeekday = useMemo(() => buildDemand(false), [needs]);
  const demandPeak = useMemo(() => buildDemand(true), [needs]);

  // 계산 서버가 떠 있는지 기동 시 1회 확인한다 (SPEC.md 7.5)
  useEffect(() => {
    health().then((h) => setServerOk(!!h.ok));
  }, []);

  // ---------------------------------------------------------------
  // DB(Supabase) 자동 저장/불러오기. 로그인 없는 내부 도구라 브라우저가
  // anon key로 직접 읽고 쓴다 (SPEC.md "DB" 절 참고).
  // ---------------------------------------------------------------
  const [dbLoaded, setDbLoaded] = useState(false);
  const [dbError, setDbError] = useState(null);

  // 기동 시 1회: 저장된 직원·배정표를 불러온다. 테이블이 비어 있으면(첫 실행)
  // 지금 코드의 기본값(INITIAL_EMPLOYEES 등)으로 DB를 채운다.
  useEffect(() => {
    if (!supabase) {
      setDbLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [{ data: empRows, error: empErr }, { data: stateRow, error: stateErr }] = await Promise.all([
          supabase.from("employees").select("*").order("id"),
          supabase.from("app_state").select("*").eq("id", APP_STATE_ID).maybeSingle(),
        ]);
        if (empErr) throw empErr;
        if (stateErr) throw stateErr;
        if (cancelled) return;

        if (empRows && empRows.length > 0) {
          setEmployees(empRows.map(empFromDb));
        } else {
          const { error } = await supabase.from("employees").upsert(INITIAL_EMPLOYEES.map(empToDb));
          if (error) throw error;
        }

        if (stateRow) {
          setBoard(stateRow.board || {});
          setLockMap(stateRow.lock_map || {});
          if (stateRow.needs && Object.keys(stateRow.needs).length) {
            applyNeeds(stateRow.needs);
            setNeeds(stateRow.needs);
          }
          if (stateRow.bread_weekday != null) setBreadWeekday(stateRow.bread_weekday);
          if (stateRow.bread_peak != null) setBreadPeak(stateRow.bread_peak);
          if (stateRow.shortage) setShortage(stateRow.shortage);
          setServerBreaks(stateRow.server_breaks || {});
        } else {
          const { error } = await supabase
            .from("app_state")
            .upsert(appStateToDb({ board: {}, lockMap: {}, needs, breadWeekday, breadPeak, shortage, serverBreaks: {} }));
          if (error) throw error;
        }
      } catch (err) {
        console.error("[supabase] 초기 로드 실패", err);
        if (!cancelled) setDbError(err.message || String(err));
      } finally {
        if (!cancelled) setDbLoaded(true);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 직원 목록이 바뀌면(추가/수정) 잠시 후 통째로 업서트한다. 삭제는 removeEmployee가
  // 즉시 따로 처리한다 — upsert만으로는 빠진 행이 안 지워지기 때문이다.
  // pendingEmpSaveRef에 "지금 당장 저장" 함수를 넣어둬서, 디바운스가 끝나기 전에
  // 탭을 벗어나도(아래 flush 효과) 놓치지 않게 한다.
  const pendingEmpSaveRef = useRef(null);
  const saveEmpTimer = useRef(null);
  useEffect(() => {
    if (!dbLoaded || !supabase) return;
    const doSave = () => {
      clearTimeout(saveEmpTimer.current);
      pendingEmpSaveRef.current = null;
      supabase
        .from("employees")
        .upsert(employees.map(empToDb))
        .then(({ error }) => {
          if (error) console.error("[supabase] 직원 저장 실패", error);
        });
    };
    pendingEmpSaveRef.current = doSave;
    clearTimeout(saveEmpTimer.current);
    saveEmpTimer.current = setTimeout(doSave, 400);
    return () => clearTimeout(saveEmpTimer.current);
  }, [employees, dbLoaded]);

  // 배정표·설정이 바뀌면 잠시 후 app_state 한 행에 통째로 저장한다 (같은 flush 대상)
  const pendingStateSaveRef = useRef(null);
  const saveStateTimer = useRef(null);
  useEffect(() => {
    if (!dbLoaded || !supabase) return;
    const doSave = () => {
      clearTimeout(saveStateTimer.current);
      pendingStateSaveRef.current = null;
      supabase
        .from("app_state")
        .upsert(appStateToDb({ board, lockMap, needs, breadWeekday, breadPeak, shortage, serverBreaks }))
        .then(({ error }) => {
          if (error) console.error("[supabase] 배정표 저장 실패", error);
        });
    };
    pendingStateSaveRef.current = doSave;
    clearTimeout(saveStateTimer.current);
    saveStateTimer.current = setTimeout(doSave, 400);
    return () => clearTimeout(saveStateTimer.current);
  }, [board, lockMap, needs, breadWeekday, breadPeak, shortage, serverBreaks, dbLoaded]);

  // 탭을 벗어나거나(새로고침·닫기·다른 탭 전환 포함) 숨겨지는 순간, 디바운스를 기다리던
  // 저장이 있으면 즉시 실행한다. 이게 없으면 "방금 만든 결과를 보자마자 새로고침"할 때
  // 저장 전에 페이지가 닫혀 변경이 통째로 날아가는 게 여러 사람이 같이 쓸 때 특히
  // 눈에 띄는 버그였다.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden") {
        pendingEmpSaveRef.current?.();
        pendingStateSaveRef.current?.();
      }
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  // 이력 탭: 이 매장·이 주에 대해 과거 자동 배정 스냅샷(schedule_runs)을 불러온다
  const [runs, setRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState(null);
  const [selectedRun, setSelectedRun] = useState(null);

  useEffect(() => {
    if (tab !== "history" || !supabase) return;
    let cancelled = false;
    setRunsLoading(true);
    setRunsError(null);
    supabase
      .from("schedule_runs")
      .select("*")
      .eq("store_id", storeId)
      .eq("week_start", weekStart)
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setRunsError(error.message);
        else setRuns(data || []);
        setRunsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, storeId, weekStart]);

  // 필요 인원을 바꾸면 곡선 캐시를 비우고 다시 계산하게 한다
  function patchNeed(key, kind, value) {
    const next = { ...needs, [key]: { ...needs[key], [kind]: value } };
    applyNeeds(next);
    setNeeds(next);
  }

  const dates = useMemo(() => monthDates(year, month), [year, month]);
  const gridDates = useMemo(() => gridRange(year, month), [year, month]);
  const weekDates = useMemo(
    () => Array.from({ length: 7 }, (_, i) => shiftDate(weekStart, i)),
    [weekStart]
  );

  const assign = board[storeId] || {};
  const locked = lockMap[storeId] || {};
  const autoDates = autoMap[storeId] || {};
  const staff = useMemo(() => employees.filter((e) => e.storeId === storeId), [employees, storeId]);

  const empById = useCallback((id) => employees.find((e) => e.id === id), [employees]);
  const dayOf = useCallback((date) => assign[date] || {}, [assign]);
  const breadAtOf = useCallback(
    (date) => (isPeak(date) ? breadPeak : breadWeekday),
    [breadPeak, breadWeekday]
  );
  const covOf = useCallback((date) => coverage(dayOf(date), dayOf(shiftDate(date, -1))), [dayOf]);
  const gapMinOf = useCallback((date) => gapMinutes(gapOf(covOf(date), date)), [covOf]);
  // 서버가 돌려준 휴게를 우선 쓴다. 단, 그 날을 수동 편집(=잠금)했다면 서버 휴게는
  // 더 이상 실제 배정과 맞지 않을 수 있어 무효로 보고 기존 breakPlan으로 되돌린다.
  // (SPEC.md 7.3) 서버 응답엔 slotKey가 없어 그 날 배정에서 역으로 찾아 붙인다.
  const breaksOf = useCallback(
    (date) => {
      const raw = !locked[date] ? serverBreaks[date] : null;
      if (!raw) return breakPlan(dayOf(date));
      const day = dayOf(date);
      return raw
        .map((b) => {
          const entry = Object.entries(day).find(
            ([key, ids]) => ids.includes(b.empId) && !slotInfo(key).half && !slotInfo(key).night
          );
          return entry ? { empId: b.empId, from: b.from, to: b.to, slotKey: entry[0] } : null;
        })
        .filter(Boolean);
    },
    [locked, serverBreaks, dayOf]
  );
  const floorOf = useCallback(
    (date) => floorCurve(dayOf(date), breaksOf(date), breadAtOf(date), dayOf(shiftDate(date, -1))),
    [dayOf, breaksOf, breadAtOf]
  );
  const floorMinOf = useCallback(
    (date) => Math.min(...floorOf(date).slice(FLOOR_FROM, FLOOR_UNTIL)),
    [floorOf]
  );
  // 출근 인원 중 휴게·빵으로 자리를 비운 인원만 뽑은 곡선
  const restOf = useCallback(
    (date) => staffOnFloor(dayOf(date), dayOf(shiftDate(date, -1))).map((n, i) => n - floorOf(date)[i]),
    [dayOf, floorOf]
  );

  function moveMonth(diff) {
    const d = new Date(year, month - 1 + diff, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setSelected(null);
  }

  // 주를 옮기면 그 주의 목요일이 속한 달로 달력도 따라간다
  function moveWeek(diff) {
    const next = shiftDate(weekStart, diff * 7);
    setWeekStart(next);
    const mid = parse(shiftDate(next, 3));
    if (mid.getFullYear() !== year || mid.getMonth() + 1 !== month) {
      setYear(mid.getFullYear());
      setMonth(mid.getMonth() + 1);
    }
    setSelected(null);
  }

  // 직원 한 명을 API의 Employee 형태로 바꾼다 (SPEC.md 5절)
  function empForApi(e) {
    return {
      id: e.id,
      storeId: e.storeId,
      name: e.name,
      kind: e.kind,
      maxPerWeek: e.maxPerWeek,
      minPerWeek: e.minPerWeek,
      maxWeekday: e.maxWeekday ?? null,
      maxHalf: e.maxHalf,
      canEightStart: e.canEightStart,
      isRookie: e.isRookie,
      until: e.until || null,
      avail: e.avail || null,
      fixedDays: e.fixedDays || [],
      pins: e.pins || {},
      vacations: e.vacations || [],
    };
  }

  // 슬롯 정의 + 규칙 탭에서 바꾼 필요 인원(needs)을 API의 Slot 형태로 바꾼다
  function slotsForApi() {
    return ALL_SLOTS.map((s) => ({
      key: s.key,
      label: s.label,
      from: s.from,
      to: s.to,
      need: s.half ? 0 : needs[s.key]?.weekday ?? s.need ?? 0,
      peak: s.half ? 0 : needs[s.key]?.peak ?? (s.peak != null ? s.peak : s.need) ?? 0,
      extra: s.extra ?? 0,
      open: !!s.open,
      late: !!s.late,
      night: !!s.night,
      half: !!s.half,
    }));
  }

  async function runAuto() {
    // 현재 선택된 매장 + 현재 보고 있는 주만 서버(CP-SAT)에 보내 최적해를 받는다.
    setAutoBusy(true);
    setSolveError(null);

    // 이 매장 직원 + 다른 매장의 야간 직원(지원 백업용)까지 포함한다.
    // 신중동처럼 야간 인력이 1명뿐이면 혼자서는 주 7일을 못 채우므로,
    // 예전 "전 매장 동시 배정" 때 있던 야간 지원을 여기서도 살려둔다.
    const targetEmployees = employees.filter(
      (e) => e.storeId === storeId || e.kind === "night"
    );
    const lockedThisWeek = weekDates.filter((d) => (lockMap[storeId] || {})[d]);

    // 읽기 전용 문맥: 첫날 바로 전날(마감→오픈 판정용), 잠긴 날짜의 실제 배정,
    // 타 매장의 이번 주 배정(야간 지원 여부 판단·이중 배정 방지용)
    const existing = {};
    const own = {};
    const before = shiftDate(weekDates[0], -1);
    if (board[storeId]?.[before]) own[before] = board[storeId][before];
    lockedThisWeek.forEach((d) => {
      own[d] = (board[storeId] || {})[d] || {};
    });
    if (Object.keys(own).length) existing[storeId] = own;
    STORES.forEach((s) => {
      if (s.id === storeId) return;
      const otherWeek = {};
      weekDates.forEach((d) => {
        if (board[s.id]?.[d]) otherWeek[d] = board[s.id][d];
      });
      if (Object.keys(otherWeek).length) existing[s.id] = otherWeek;
    });

    const payload = {
      storeId,
      dates: weekDates,
      employees: targetEmployees.map(empForApi),
      slots: slotsForApi(),
      rules: {
        weekCap: WEEK_CAP,
        startShared: START_SHARED,
        floor: { from: FLOOR_FROM, until: FLOOR_UNTIL, min: FLOOR_MIN, ceil: MAX_FLOOR },
        break: { len: BREAK_LEN, afterStart: tb(2), beforeEnd: 0, concurrent: 1 },
        bread: { weekday: breadWeekday, peak: breadPeak, len: BREAD_LEN },
        overtime: { maxExtraShifts: 1, maxExtraUnits: 2 },
        shortage,
        requireSlotFill: true,
      },
      existing,
      locked: lockedThisWeek,
      assumePrevNightCovered: true,
      timeLimitSec: 30,
    };

    try {
      const res = await solveWeek(payload);

      // 이 매장·이 주 날짜만 갈아끼운다(잠긴 날짜는 그대로 둔다). 다른 매장이나
      // 다른 주에 이미 짜둔 스케줄은 건드리지 않는다. 다만 다른 매장 야간 직원을
      // 지원으로 빌려 썼다면 그 매장 쪽 야간 칸에도 반영해서, 나중에 그 매장을
      // 따로 돌릴 때 같은 사람을 이중으로 넣지 않게 한다(주간 근무 칸은 안 건드림).
      // board/serverBreaks는 지역 변수로도 계산해 아래 즉시 저장에 그대로 쓴다 —
      // setState 직후엔 React state가 바로 안 바뀌어서 state를 다시 읽으면 안 된다.
      const nextBoard = { ...board };
      const ownNext = { ...(board[storeId] || {}) };
      weekDates.forEach((d) => {
        if (lockedThisWeek.includes(d)) return;
        ownNext[d] = res.board?.[storeId]?.[d] || {};
      });
      nextBoard[storeId] = ownNext;
      STORES.forEach((s) => {
        if (s.id === storeId) return;
        const otherDay = { ...(board[s.id] || {}) };
        weekDates.forEach((d) => {
          const night = res.board?.[s.id]?.[d]?.night;
          if (night) otherDay[d] = { ...(otherDay[d] || {}), night };
        });
        nextBoard[s.id] = otherDay;
      });
      setBoard(nextBoard);

      setAutoMap((prev) => {
        const store = { ...(prev[storeId] || {}) };
        weekDates.forEach((d) => {
          if (!lockedThisWeek.includes(d)) store[d] = true;
        });
        return { ...prev, [storeId]: store };
      });

      const nextServerBreaks = { ...serverBreaks };
      weekDates.forEach((d) => {
        if (!lockedThisWeek.includes(d)) nextServerBreaks[d] = res.breaks?.[d] || [];
      });
      setServerBreaks(nextServerBreaks);

      setDiagnostics(res.diagnostics || null);
      setSolveMeta({
        status: res.status,
        objective: res.objective,
        bound: res.bound,
        wallTimeSec: res.wallTimeSec,
        warnings: res.warnings || [],
      });
      // 요일을 클릭해야 상세가 보인다는 걸 모르는 사용자를 위해 월요일을 미리 열어 보여준다
      setSelected(weekDates[0]);

      // 자동배정 결과는 디바운스(아래 saveStateTimer)를 기다리지 않고 바로 저장한다.
      // 만들자마자 다른 기기에서 확인하거나 새로고침하는 경우가 많아서, 이 결과가
      // 가장 자주 저장 전에 사라지기 쉬운 결과였다.
      if (supabase) {
        supabase
          .from("app_state")
          .upsert(
            appStateToDb({
              board: nextBoard,
              lockMap,
              needs,
              breadWeekday,
              breadPeak,
              shortage,
              serverBreaks: nextServerBreaks,
            })
          )
          .then(({ error }) => {
            if (error) console.error("[supabase] 배정표 저장 실패", error);
          });
      }

      // 이번에 쓴 설정값 + 결과를 스냅샷으로 남긴다 (나중에 직원 설정·규칙이 바뀌어도
      // "그때 왜 이렇게 나왔는지" 추적할 수 있게). 실패해도 화면 흐름은 막지 않는다.
      if (supabase) {
        const weekBoard = {};
        weekDates.forEach((d) => {
          weekBoard[d] = res.board?.[storeId]?.[d] || {};
        });
        supabase
          .from("schedule_runs")
          .insert({
            store_id: storeId,
            week_start: weekStart,
            employees_snapshot: payload.employees,
            rules_snapshot: payload.rules,
            needs_snapshot: needs,
            board_result: weekBoard,
            status: res.status,
            warnings: res.warnings || [],
            diagnostics: res.diagnostics || null,
          })
          .then(({ error }) => {
            if (error) console.error("[supabase] 배정 스냅샷 저장 실패", error);
          });
      }
    } catch (e) {
      if (e instanceof SolveError && e.kind === "infeasible") {
        setSolveError([e.message, ...(e.detail || [])].join("\n"));
      } else {
        setSolveError(e?.message || String(e));
      }
    } finally {
      setAutoBusy(false);
    }
  }

  function clearAll() {
    setBoard({});
    setLockMap({});
    setAutoMap({});
  }

  function markEdited(date) {
    setLockMap((p) => ({ ...p, [storeId]: { ...(p[storeId] || {}), [date]: true } }));
    setAutoMap((p) => ({ ...p, [storeId]: { ...(p[storeId] || {}), [date]: false } }));
  }

  function addTo(date, slotKey, empId) {
    setBoard((p) => {
      const store = { ...(p[storeId] || {}) };
      const day = { ...(store[date] || {}) };
      day[slotKey] = [...(day[slotKey] || []), empId];
      store[date] = day;
      return { ...p, [storeId]: store };
    });
    markEdited(date);
    setPicker(null);
  }

  function removeFrom(date, slotKey, empId) {
    setBoard((p) => {
      const store = { ...(p[storeId] || {}) };
      const day = { ...(store[date] || {}) };
      day[slotKey] = (day[slotKey] || []).filter((i) => i !== empId);
      store[date] = day;
      return { ...p, [storeId]: store };
    });
    markEdited(date);
  }

  function unlock(date) {
    setLockMap((p) => {
      const store = { ...(p[storeId] || {}) };
      delete store[date];
      return { ...p, [storeId]: store };
    });
  }

  function toggleVacation(empId, date) {
    setEmployees((prev) =>
      prev.map((e) =>
        e.id !== empId
          ? e
          : {
              ...e,
              vacations: e.vacations.includes(date)
                ? e.vacations.filter((d) => d !== date)
                : [...e.vacations, date],
            }
      )
    );
  }

  const patchEmp = (empId, patch) =>
    setEmployees((prev) => prev.map((e) => (e.id === empId ? { ...e, ...patch } : e)));

  function editUntil(e) {
    const input = prompt("근무 종료일 (YYYY-MM-DD, 비우면 해제)", e.until || "");
    if (input === null) return;
    patchEmp(e.id, { until: input.trim() || null });
  }

  function editAvail(e, kind) {
    const cur = e.avail[kind];
    const text = cur ? `${bucketLabel(cur[0])}-${bucketLabel(cur[1])}` : "";
    const input = prompt(
      `${kind === "weekday" ? "평일" : "금토일"} 가능 시간 (08:00-15:00 형식, 비우면 제한 없음)`,
      text
    );
    if (input === null) return;
    const t = input.trim();
    if (!t) {
      patchEmp(e.id, { avail: { ...e.avail, [kind]: null } });
      return;
    }
    const m = t.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) {
      alert("08:00-15:00 형식으로 입력해 주세요");
      return;
    }
    patchEmp(e.id, { avail: { ...e.avail, [kind]: [tb(+m[1], +m[2]), tb(+m[3], +m[4])] } });
  }

  function addEmployee() {
    const name = prompt("직원 이름");
    if (!name?.trim()) return;
    setEmployees((prev) => {
      // mk()의 seq는 모듈 로드시 기본 목록 기준이라, DB에서 더 큰 id를 불러온
      // 뒤에는 현재 목록 기준으로 다시 계산해야 충돌하지 않는다.
      const nextId = prev.reduce((m, e) => Math.max(m, e.id), 0) + 1;
      return [...prev, { ...mk(storeId, name.trim()), id: nextId }];
    });
  }

  function removeEmployee(empId) {
    if (!confirm("이 직원을 삭제할까요? 배정된 근무도 함께 지워집니다.")) return;
    setEmployees((prev) => prev.filter((e) => e.id !== empId));
    setBoard((p) => {
      const nb = {};
      Object.entries(p).forEach(([sid, days]) => {
        nb[sid] = {};
        Object.entries(days).forEach(([d, day]) => {
          const nd = {};
          Object.entries(day).forEach(([s, ids]) => (nd[s] = ids.filter((i) => i !== empId)));
          nb[sid][d] = nd;
        });
      });
      return nb;
    });
    setVacFor(null);
    // upsert만으로는 빠진 행이 안 지워지므로 삭제는 즉시 따로 반영한다
    if (supabase) {
      supabase
        .from("employees")
        .delete()
        .eq("id", empId)
        .then(({ error }) => {
          if (error) console.error("[supabase] 직원 삭제 실패", error);
        });
    }
  }

  const hasSchedule = Object.values(assign).some((d) => Object.values(d).some((v) => v.length));
  const scopeDates = view === "week" ? weekDates : dates;
  const shortDays = useMemo(
    () => (hasSchedule ? scopeDates.filter((d) => gapMinOf(d) > 0) : []),
    [scopeDates, gapMinOf, hasSchedule]
  );
  const peakShortDays = useMemo(() => shortDays.filter(isPeak), [shortDays]);
  // 이 범위의 첫날 새벽(00~08시)은 그 전날 밤 근무자가 있어야 채워지는데,
  // 그 전날이 아직 하나도 배정 안 되어 있으면 항상 부족으로 잡힌다.
  // 이번 주만 놓고 보면 원인을 알 수 없어 헷갈리기 쉬워 따로 짚어준다.
  const firstDayBoundaryGap = useMemo(() => {
    if (!hasSchedule || scopeDates.length === 0) return false;
    const first = scopeDates[0];
    const prevEmpty = Object.keys(dayOf(shiftDate(first, -1))).length === 0;
    return prevEmpty && gapMinOf(first) > 0;
  }, [hasSchedule, scopeDates, dayOf, gapMinOf]);
  // 잠긴 날짜는 자동 배정이 손대지 않고 그대로 둔다. 수동으로 편집했던 날이
  // 계속 남아 아무리 다시 돌려도 그 자리가 안 채워지는 걸 놓치기 쉬워 따로 알려준다.
  const weekLockedDays = useMemo(() => weekDates.filter((d) => locked[d]), [weekDates, locked]);
  const floorRiskDays = useMemo(
    () => (hasSchedule ? scopeDates.filter((d) => floorMinOf(d) < FLOOR_MIN) : []),
    [scopeDates, floorMinOf, hasSchedule]
  );
  const totalShortHours = useMemo(
    () => Math.round(scopeDates.reduce((a, d) => a + gapMinOf(d), 0) / 60),
    [scopeDates, gapMinOf]
  );

  // 이번 주 결과를 마크다운 표로 만들어 클립보드에 복사한다 (피드백 요청용)
  async function copyResultMarkdown() {
    const lines = [];
    lines.push(
      `## ${storeName(storeId)} ${weekStart.slice(5).replace("-", "/")}–${shiftDate(weekStart, 6)
        .slice(5)
        .replace("-", "/")}`
    );
    lines.push("");
    if (peakShortDays.length > 0) lines.push(`- ⚠️ 금토일 ${peakShortDays.length}일이 비었습니다.`);
    if (floorRiskDays.length > 0)
      lines.push(`- ⚠️ ${floorRiskDays.length}일은 휴게·빵 시간대에 바 인원이 ${FLOOR_MIN}명 미만입니다.`);
    if (shortDays.length > 0)
      lines.push(`- ⚠️ 이번 주 ${shortDays.length}일에 빈 자리, 합쳐서 ${totalShortHours}시간 부족.`);
    if (weekLockedDays.length > 0)
      lines.push(`- 🔒 잠긴 날짜: ${weekLockedDays.map((d) => Number(d.slice(8))).join(", ")}일`);
    if (firstDayBoundaryGap)
      lines.push(
        `- ℹ️ ${Number(scopeDates[0]?.slice(8))}일 새벽 부족은 전날(전주) 야간 미배정 때문일 수 있음.`
      );
    lines.push("");

    const header = ["직원", ...weekDates.map((d) => `${WD[wdIndex(parse(d))]}${Number(d.slice(8))}`)];
    lines.push(`| ${header.join(" | ")} |`);
    lines.push(`|${header.map(() => "---").join("|")}|`);
    weekRows.forEach((e) => {
      const guest = e.storeId !== storeId;
      const name = guest ? `${e.name}(지원)` : e.name;
      const cells = weekDates.map((d) => {
        const key = slotOfEmp(e.id, d);
        if (key) return slotInfo(key).short;
        if (e.vacations.includes(d)) return "휴";
        if (e.until && d > e.until) return "-";
        return "·";
      });
      lines.push(`| ${name} | ${cells.join(" | ")} |`);
    });
    lines.push("");
    lines.push("### 이번 주 근무일수 (쩜오 0.5)");
    lines.push("| 직원 | 근무일수 | 상한 |");
    lines.push("|---|---|---|");
    weekRows.forEach((e) => {
      const guest = e.storeId !== storeId;
      const n = weekDaysOf(e.id);
      const cap = Math.min(e.maxPerWeek, WEEK_CAP);
      lines.push(`| ${guest ? `${e.name}(지원)` : e.name} | ${n} | ${guest ? "-" : cap} |`);
    });

    const md = lines.join("\n");
    try {
      await navigator.clipboard.writeText(md);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
    setTimeout(() => setCopyStatus("idle"), 2000);
  }

  const stats = useMemo(() => {
    const s = {};
    Object.entries(board).forEach(([sid, days]) =>
      dates.forEach((d) =>
        Object.entries(days[d] || {}).forEach(([slot, ids]) => {
          const isHalf = slot.startsWith("half");
          ids.forEach((id) => {
            s[id] = s[id] || { days: 0, half: 0, guest: 0 };
            s[id].days += isHalf ? 0.5 : 1;
            if (isHalf) s[id].half += 1;
            if (empById(id) && empById(id).storeId !== sid) s[id].guest += 1;
          });
        })
      )
    );
    return s;
  }, [board, dates, empById]);

  const cells = useMemo(() => {
    const lead = wdIndex(new Date(year, month - 1, 1));
    return [...Array(lead).fill(null), ...dates];
  }, [year, month, dates]);

  const slotOfEmp = useCallback(
    (empId, date) => {
      const day = dayOf(date);
      for (const [k, ids] of Object.entries(day)) if (ids.includes(empId)) return k;
      return null;
    },
    [dayOf]
  );

  const weekRows = useMemo(() => {
    const extra = [];
    weekDates.forEach((d) =>
      Object.values(dayOf(d)).forEach((ids) =>
        ids.forEach((id) => {
          const e = empById(id);
          if (e && e.storeId !== storeId && !extra.some((x) => x.id === id)) extra.push(e);
        })
      )
    );
    return [...staff, ...extra];
  }, [weekDates, dayOf, empById, staff, storeId]);

  // 이번 주 근무일수. 전 매장을 합쳐야 지원 나간 날이 빠지지 않는다
  const weekDaysOf = useCallback(
    (empId) => {
      let n = 0;
      weekDates.forEach((d) =>
        Object.values(board).forEach((days) =>
          Object.entries(days[d] || {}).forEach(([slot, ids]) => {
            if (ids.includes(empId)) n += slot.startsWith("half") ? 0.5 : 1;
          })
        )
      );
      return n;
    },
    [weekDates, board]
  );

  // 이 매장에서만 센 이번 주 근무일수
  const storeDaysOf = useCallback(
    (empId) => {
      let n = 0;
      weekDates.forEach((d) =>
        Object.entries(dayOf(d)).forEach(([slot, ids]) => {
          if (ids.includes(empId)) n += slot.startsWith("half") ? 0.5 : 1;
        })
      );
      return n;
    },
    [weekDates, dayOf]
  );

  function busyElsewhere(date) {
    const s = new Set();
    Object.entries(board).forEach(([sid, days]) => {
      if (sid === storeId) return;
      Object.values(days[date] || {}).forEach((ids) => ids.forEach((i) => s.add(i)));
    });
    return s;
  }

  function candidates(date, slotKey) {
    const slot = slotInfo(slotKey);
    if (startTaken(dayOf(date), slot)) return [];
    const isNight = !!slot.night;
    const busy = new Set(Object.values(dayOf(date)).flat());
    const elsewhere = busyElsewhere(date);
    const base = isNight ? employees : staff;
    return base.filter((e) => {
      if (isNight ? e.kind !== "night" : e.kind === "night") return false;
      if (!isNight && e.storeId !== storeId) return false;
      if (e.until && date > e.until) return false;
      if (slot.from === tb(8) && !slot.night && !e.canEightStart) return false;
      if (!canWork(e, slot, date)) return false;
      const longer = LONGER_IN_GROUP[slot.key];
      if (longer && canWork(e, slotInfo(longer), date)) return false;
      if (busy.has(e.id) || elsewhere.has(e.id)) return false;
      if (e.vacations.includes(date)) return false;
      return true;
    });
  }

  function weekLoad(empId, date) {
    const wk = weekKey(date);
    let n = 0;
    Object.values(board).forEach((days) =>
      gridDates.forEach((d) => {
        if (weekKey(d) !== wk) return;
        Object.entries(days[d] || {}).forEach(([slot, ids]) => {
          if (ids.includes(empId)) n += slot.startsWith("half") ? 0.5 : 1;
        });
      })
    );
    return n;
  }

  /* 세로축 눈금·시간마다 세로 기준선·막대 안 숫자가 있는 막대 그래프.
     막대 자체는 30분 단위 실제값을 그대로 다 그린다(합쳐서 값을 지우지 않는다).
     다만 x축 눈금·세로 기준선은 시(1시간) 단위로만 찍어서, 같은 시간에 속한
     반시간 두 칸이 한 덩어리로 붙어 보이게 한다. 이러면 모바일 폭에도 맞고
     휴게처럼 반시간만 반짝 튀는 값도 그대로 보인다. 같은 규격 차트끼리는 세로
     기준선이 같은 x 위치에 찍혀서, 위아래로 나란히 두면 같은 시간대를 눈으로 맞춰 볼 수 있다. */
  const CHART_H = 72;
  function AxisChart({ values, top, colorAt, guide }) {
    const levels = Array.from({ length: top + 1 }, (_, i) => i);
    const hourCount = Math.ceil(values.length / 2);
    return (
      <div className="flex flex-col">
        <div className="flex">
          <div
            className="flex w-5 shrink-0 flex-col-reverse justify-between pr-1 text-right"
            style={{ height: CHART_H }}
          >
            {levels.map((v) => (
              <span key={v} className="font-mono leading-none" style={{ fontSize: 8, color: MUTED }}>
                {v}
              </span>
            ))}
          </div>
          <div className="relative flex-1" style={{ height: CHART_H }}>
            {levels.map((v) => (
              <div
                key={v}
                className="absolute left-0 right-0"
                style={{
                  bottom: `${(v / top) * 100}%`,
                  height: 1,
                  background: v === guide ? ALERT : RULE,
                  opacity: v === guide ? 0.7 : 0.45,
                }}
              />
            ))}
            {Array.from({ length: hourCount }, (_, h) =>
              h > 0 ? (
                <div
                  key={`vg${h}`}
                  className="absolute top-0 bottom-0"
                  style={{ left: `${(h / hourCount) * 100}%`, borderLeft: `1px dashed ${RULE}`, opacity: 0.6 }}
                />
              ) : null
            )}
            <div className="absolute inset-0 flex items-end">
              {Array.from({ length: hourCount }, (_, h) => (
                <div key={h} className="flex h-full flex-1 items-end gap-[1px]">
                  {[h * 2, h * 2 + 1]
                    .filter((i) => i < values.length)
                    .map((i) => {
                      const v = Math.max(0, values[i]);
                      const barColor = colorAt(values[i], i);
                      return (
                        <div key={i} className="relative flex h-full flex-1 items-end justify-center">
                          <span
                            className="absolute font-mono font-bold"
                            style={{
                              bottom: `calc(${(v / top) * 100}% + 2px)`,
                              fontSize: 9,
                              color: barColor === ALERT ? ALERT : INK,
                            }}
                          >
                            {v}
                          </span>
                          <div
                            style={{
                              width: "80%",
                              height: `${(v / top) * 100}%`,
                              background: barColor,
                              borderRadius: 2,
                            }}
                          />
                        </div>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* 시간은 정시 단위로 한 번씩만 찍는다 */}
        <div className="flex">
          <div className="w-5 shrink-0" />
          <div className="flex flex-1">
            {Array.from({ length: hourCount }, (_, h) => (
              <div
                key={h}
                className="flex-1 text-center font-mono leading-none"
                style={{ fontSize: 8, color: MUTED }}
              >
                {pad2(h)}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  /* 누가 언제 쉬는지 시간축에 맞춰 보여준다 */
  function BreakTimeline({ date }) {
    const rows = breaksOf(date);
    const breadAt = breadAtOf(date);
    return (
      <div className="flex flex-col gap-[2px]">
        {rows.map((b, i) => {
          const slot = slotInfo(b.slotKey);
          return (
            <div key={i} className="flex">
              <div className="w-5 shrink-0" />
              <div className="relative h-5 flex-1 rounded" style={{ background: "#EAE8E1" }}>
                <div
                  className="absolute inset-y-0 flex items-center justify-center rounded"
                  style={{
                    left: `${(b.from / BPD) * 100}%`,
                    width: `${((b.to - b.from) / BPD) * 100}%`,
                    background: slot.color,
                  }}
                >
                  <span className="truncate px-1" style={{ fontSize: 8, color: PAPER }}>
                    {empById(b.empId)?.name}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        <div className="flex">
          <div className="w-5 shrink-0" />
          <div className="relative h-5 flex-1 rounded" style={{ background: "#EAE8E1" }}>
            <div
              className="absolute inset-y-0 flex items-center justify-center rounded"
              style={{
                left: `${(breadAt / BPD) * 100}%`,
                width: `${(BREAD_LEN / BPD) * 100}%`,
                background: GUEST,
              }}
            >
              <span style={{ fontSize: 8, color: PAPER }}>빵</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const Ticks = () => (
    <div className="flex">
      <div className="w-5 shrink-0" />
      <div className="mt-1 flex flex-1 justify-between font-mono" style={{ fontSize: 9, color: MUTED }}>
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h}>{pad2(h % 24)}</span>
        ))}
      </div>
    </div>
  );

  if (!dbLoaded) {
    return (
      <div
        className="flex min-h-screen w-full items-center justify-center font-sans text-sm"
        style={{ background: PAPER, color: MUTED }}
      >
        불러오는 중…
      </div>
    );
  }

  const headTitle =
    view === "week"
      ? `${weekStart.slice(5).replace("-", "/")} – ${shiftDate(weekStart, 6).slice(5).replace("-", "/")}`
      : pad(month);

  return (
    <div
      className="min-h-screen w-full font-sans"
      style={{ background: PAPER, color: INK, paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {/* 상단 바 */}
      <header
        className="sticky top-0 z-20 px-4 pt-3 pb-2"
        style={{ background: PAPER, borderBottom: `1px solid ${RULE}` }}
      >
        <div className="flex items-end justify-between">
          <div className="flex items-baseline gap-2">
            <span
              className="font-mono font-bold tracking-tighter"
              style={{ fontSize: view === "week" ? 20 : 30 }}
            >
              {headTitle}
            </span>
            <span className="font-mono text-xs" style={{ color: MUTED }}>
              {year}
            </span>
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => (view === "week" ? moveWeek(-1) : moveMonth(-1))}
              className="h-9 w-9 rounded-full font-mono active:opacity-60"
              style={{ border: `1px solid ${RULE}`, background: CARD }}
            >
              ‹
            </button>
            <button
              onClick={() => (view === "week" ? moveWeek(1) : moveMonth(1))}
              className="h-9 w-9 rounded-full font-mono active:opacity-60"
              style={{ border: `1px solid ${RULE}`, background: CARD }}
            >
              ›
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-1">
          {STORES.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setStoreId(s.id);
                setSelected(null);
                setVacFor(null);
              }}
              className="rounded-full px-3 py-1 text-xs font-medium active:opacity-70"
              style={
                storeId === s.id
                  ? { background: INK, color: PAPER }
                  : { border: `1px solid ${RULE}`, color: MUTED }
              }
            >
              {s.name}
            </button>
          ))}

          {tab === "board" && (
            <div className="ml-auto flex gap-1">
              {[
                ["week", "주"],
                ["month", "월"],
              ].map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => {
                    setView(k);
                    setSelected(null);
                  }}
                  className="h-7 w-8 rounded text-xs font-medium active:opacity-70"
                  style={
                    view === k
                      ? { background: INK, color: PAPER }
                      : { border: `1px solid ${RULE}`, color: MUTED }
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-2 flex gap-1">
          {[
            ["board", "근무표"],
            ["people", "직원"],
            ["rules", "규칙"],
            ["history", "이력"],
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="flex-1 rounded-md py-2 text-sm font-medium active:opacity-70"
              style={
                tab === key
                  ? { background: INK, color: PAPER }
                  : { background: CARD, border: `1px solid ${RULE}`, color: MUTED }
              }
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {/* 근무표 */}
      {tab === "board" && (
        <div className="px-4 pb-8">
          {serverOk === false && (
            <div
              className="mt-3 rounded-md px-3 py-2 text-xs font-semibold leading-relaxed"
              style={{ background: ALERT, color: PAPER }}
            >
              계산 서버가 꺼져 있습니다. backend 폴더에서 uvicorn을 실행해 주세요.
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <button
              onClick={runAuto}
              disabled={autoBusy}
              className="flex-1 rounded-md py-3 text-sm font-semibold active:opacity-70"
              style={{
                background: INK,
                color: PAPER,
                opacity: autoBusy ? 0.7 : 1,
                cursor: autoBusy ? "default" : "pointer",
              }}
            >
              {autoBusy ? (
                <span className="flex items-center justify-center gap-2">
                  <span
                    className="h-3 w-3 animate-spin rounded-full"
                    style={{ border: `2px solid ${PAPER}`, borderTopColor: "transparent" }}
                  />
                  계산 중…
                </span>
              ) : (
                `이번 주 자동으로 짜기 (${storeName(storeId)})`
              )}
            </button>
            {hasSchedule && (
              <button
                onClick={clearAll}
                disabled={autoBusy}
                className="rounded-md px-4 text-sm active:opacity-70"
                style={{ border: `1px solid ${RULE}`, background: CARD, color: MUTED }}
              >
                비우기
              </button>
            )}
          </div>

          {solveError && (
            <div
              className="mt-2 whitespace-pre-line rounded-md px-3 py-2 text-xs leading-relaxed"
              style={{ background: "#F5EAD6", color: "#7A5A18" }}
            >
              {solveError}
            </div>
          )}

          {diagnostics && solveMeta && (
            <details className="mt-2 rounded-md px-3 py-2 text-xs" style={{ border: `1px solid ${RULE}`, background: CARD, color: MUTED }}>
              <summary className="cursor-pointer font-medium" style={{ color: INK }}>
                {solveMeta.status === "OPTIMAL" ? "최적해" : solveMeta.status === "TIMEOUT" ? "근사해" : solveMeta.status}
                {" "}({Math.round(solveMeta.objective ?? 0)}점) · {solveMeta.wallTimeSec.toFixed(1)}초
              </summary>
              <div className="mt-1 leading-relaxed">
                형평 {Math.round(diagnostics.penalties.fairness)} · 부족 {Math.round(diagnostics.penalties.gap)} ·
                {" "}부족일수 {Math.round(diagnostics.penalties.gapDays)} · 바인원 {Math.round(diagnostics.penalties.floor)} ·
                {" "}과잉 {Math.round(diagnostics.penalties.over)} · 최소근무 {Math.round(diagnostics.penalties.minWeek)} ·
                {" "}초과근무 {Math.round(diagnostics.penalties.overtime)}
              </div>
              {solveMeta.warnings.length > 0 && (
                <div className="mt-1 leading-relaxed" style={{ color: "#7A5A18" }}>
                  {solveMeta.warnings.map((w, i) => (
                    <div key={i}>· {w}</div>
                  ))}
                </div>
              )}
            </details>
          )}

          {view === "week" && hasSchedule && (
            <button
              onClick={copyResultMarkdown}
              className="mt-2 w-full rounded-md py-2 text-xs font-medium active:opacity-70"
              style={{ border: `1px solid ${RULE}`, background: CARD, color: MUTED }}
            >
              {copyStatus === "copied"
                ? "복사됨 ✓ — 붙여넣기 해서 공유하세요"
                : copyStatus === "error"
                ? "복사 실패 — 브라우저 권한을 확인해 주세요"
                : "📋 이번 주 결과 마크다운으로 복사"}
            </button>
          )}

          {peakShortDays.length > 0 && (
            <div
              className="mt-3 rounded-md px-3 py-2 text-xs font-semibold leading-relaxed"
              style={{ background: ALERT, color: PAPER }}
            >
              금토일 {peakShortDays.length}일이 비었습니다. 이 날은 채워야 하니 직접 조정하세요.
            </div>
          )}

          {floorRiskDays.length > 0 && (
            <div
              className="mt-2 rounded-md px-3 py-2 text-xs leading-relaxed"
              style={{ background: "#F5EAD6", color: "#7A5A18" }}
            >
              {floorRiskDays.length}일은 휴게와 빵 받는 시간이 겹쳐 바에 {FLOOR_MIN}명이 안 남습니다.
            </div>
          )}

          {shortDays.length > 0 && (
            <div
              className="mt-2 rounded-md px-3 py-2 text-xs leading-relaxed"
              style={{ background: "#F7E6E1", color: ALERT }}
            >
              {view === "week" ? "이번 주" : "이번 달"} {shortDays.length}일에 빈 자리가 있고, 합쳐서{" "}
              {totalShortHours}시간 부족합니다.
            </div>
          )}

          {view === "week" && weekLockedDays.length > 0 && (
            <div
              className="mt-2 rounded-md px-3 py-2 text-xs leading-relaxed"
              style={{ background: "#EAE8E1", color: MUTED }}
            >
              🔒 {weekLockedDays.map((d) => Number(d.slice(8))).join(", ")}일은 잠겨 있어 "이번 주
              자동으로 짜기"를 눌러도 그대로 유지됩니다. 빈 자리가 안 없어진다면 이 날짜를 먼저
              풀어보세요.
            </div>
          )}

          {firstDayBoundaryGap && (
            <div
              className="mt-2 rounded-md px-3 py-2 text-xs leading-relaxed"
              style={{ background: "#EAE8E1", color: MUTED }}
            >
              {Number(scopeDates[0].slice(8))}일 새벽(00~08시) 부족은 그 전날 밤 근무자가 아직
              배정 안 되어서 생기는 것으로 보입니다. 이 범위만 다시 돌려서는 안 없어지고, 그 전날(전주)을
              먼저 배정해야 사라집니다.
            </div>
          )}

          {/* 주간 표 */}
          {view === "week" && (
            <>
              <div className="mt-4 overflow-x-auto">
                <div style={{ minWidth: 340 }}>
                  <div
                    className="grid gap-[2px]"
                    style={{ gridTemplateColumns: "40px repeat(7, minmax(0,1fr))" }}
                  >
                    <div />
                    {weekDates.map((d) => {
                      const peak = isPeak(d);
                      const isSel = selected === d;
                      const short = hasSchedule && gapMinOf(d) > 0;
                      const isDayLocked = !!locked[d];
                      return (
                        <button
                          key={d}
                          onClick={() => setSelected(isSel ? null : d)}
                          className="relative rounded-t py-1 active:opacity-60"
                          style={{
                            background: isSel ? INK : short ? "#F7E6E1" : peak ? "#E4E1D8" : "transparent",
                            color: isSel ? PAPER : short ? ALERT : INK,
                          }}
                        >
                          {isDayLocked && (
                            <span
                              className="absolute right-1 top-1 font-mono"
                              style={{ fontSize: 8, color: isSel ? PAPER : MUTED }}
                              title="잠긴 날짜 — 자동 배정에서 제외됨"
                            >
                              🔒
                            </span>
                          )}
                          <div className="font-mono text-[10px] font-semibold">
                            {WD[wdIndex(parse(d))]}
                          </div>
                          <div className="font-mono text-[11px]">{Number(d.slice(8))}</div>
                        </button>
                      );
                    })}
                  </div>

                  {weekRows.map((e) => {
                    const guest = e.storeId !== storeId;
                    return (
                      <div
                        key={e.id}
                        className="mt-[2px] grid gap-[2px]"
                        style={{ gridTemplateColumns: "40px repeat(7, minmax(0,1fr))" }}
                      >
                        <div className="flex items-center">
                          <span
                            className="truncate text-[11px] font-medium"
                            style={{ color: guest ? GUEST : INK }}
                          >
                            {guest ? "지원" : e.name}
                          </span>
                        </div>
                        {weekDates.map((d) => {
                          const key = slotOfEmp(e.id, d);
                          const slot = key ? slotInfo(key) : null;
                          const onVac = e.vacations.includes(d);
                          const gone = e.until && d > e.until;
                          return (
                            <button
                              key={d}
                              onClick={() => setSelected(selected === d ? null : d)}
                              className="flex h-8 items-center justify-center rounded active:opacity-60"
                              style={{
                                background: slot ? slot.color : CARD,
                                border: slot ? "none" : `1px solid ${RULE}`,
                              }}
                            >
                              <span
                                className="font-mono font-semibold"
                                style={{
                                  fontSize: 9,
                                  color: slot ? PAPER : onVac || gone ? ALERT : EMPTY,
                                }}
                              >
                                {slot ? slot.short : onVac ? "휴" : gone ? "-" : "·"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 표기 안내 */}
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
                {ALL_SLOTS.map((s) => (
                  <span key={s.key} className="flex items-center gap-1">
                    <span
                      className="rounded px-1 font-mono text-[9px] font-semibold"
                      style={{ background: s.color, color: PAPER }}
                    >
                      {s.short}
                    </span>
                    <span className="font-mono text-[9px]" style={{ color: MUTED }}>
                      {s.label}
                    </span>
                  </span>
                ))}
              </div>

              {/* 이번 주 요약 */}
              <div
                className="mt-4 rounded-lg p-3"
                style={{ background: CARD, border: `1px solid ${RULE}` }}
              >
                <div className="font-mono text-[11px]" style={{ color: MUTED }}>
                  이번 주 근무일수 (쩜오 0.5)
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {weekRows.map((e) => {
                    const n = weekDaysOf(e.id);
                    const local = storeDaysOf(e.id);
                    const guest = e.storeId !== storeId;
                    const cap = Math.min(e.maxPerWeek, WEEK_CAP);
                    const over = n > WEEK_CAP; // 주 6일을 넘긴 경우
                    const plus = !over && n > cap; // 본인 상한만 넘긴 경우
                    const under = !guest && e.minPerWeek > 0 && n < e.minPerWeek;
                    return (
                      <span key={e.id} className="flex items-center gap-1">
                        <span className="text-xs" style={{ color: guest ? GUEST : INK }}>
                          {guest ? "지원" : e.name}
                        </span>
                        <span
                          className="font-mono text-xs font-semibold"
                          style={{ color: guest ? GUEST : over ? ALERT : plus || under ? TIGHT : INK }}
                        >
                          {guest ? `${local}일` : `${n}/${cap}`}
                        </span>
                        {over && (
                          <span className="font-mono text-[9px]" style={{ color: ALERT }}>
                            6일초과
                          </span>
                        )}
                        {plus && (
                          <span className="font-mono text-[9px]" style={{ color: TIGHT }}>
                            추가
                          </span>
                        )}
                        {under && (
                          <span className="font-mono text-[9px]" style={{ color: TIGHT }}>
                            미달
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* 월 달력 */}
          {view === "month" && (
            <>
              <div className="mt-4 grid grid-cols-7 gap-1">
                {WD.map((w, i) => (
                  <div
                    key={w}
                    className="pb-1 text-center font-mono text-[11px] font-semibold"
                    style={{ color: i >= 4 ? INK : MUTED }}
                  >
                    {w}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-1">
                {cells.map((date, i) => {
                  if (!date) return <div key={`e${i}`} />;
                  const day = dayOf(date);
                  const short = hasSchedule && gapMinOf(date) > 0;
                  const risk = hasSchedule && floorMinOf(date) < FLOOR_MIN;
                  const peak = isPeak(date);
                  const isSel = selected === date;
                  const bars = [];
                  ALL_SLOTS.forEach((s) => {
                    if (s.half) return;
                    const n = needOf(s, date);
                    if (!n) return;
                    const ids = day[s.key] || [];
                    for (let k = 0; k < n; k++) {
                      bars.push({ key: `${s.key}${k}`, color: ids[k] ? s.color : EMPTY });
                    }
                  });
                  const extras =
                    (day.middle || []).length +
                    (day.earlyShort || []).length +
                    Math.max(0, (day.close || []).length - needOf(slotInfo("close"), date)) +
                    (day.halfAm || []).length +
                    (day.halfPm || []).length;

                  return (
                    <button
                      key={date}
                      onClick={() => setSelected(isSel ? null : date)}
                      className="relative flex h-16 flex-col items-center rounded-md pt-1 active:opacity-60"
                      style={{
                        background: peak ? "#EDEBE4" : CARD,
                        border: isSel
                          ? `2px solid ${INK}`
                          : short
                          ? `${peak ? 2 : 1}px ${peak ? "solid" : "dashed"} ${ALERT}`
                          : `1px solid ${RULE}`,
                      }}
                    >
                      {autoDates[date] && (
                        <span
                          className="absolute left-1 right-1 top-1 h-3 rounded-sm"
                          style={{ background: MARK, opacity: 0.5 }}
                        />
                      )}
                      <span className="relative font-mono text-[11px] font-semibold">
                        {Number(date.slice(8))}
                      </span>
                      <span className="mt-1 flex gap-[2px]">
                        {bars.map((b) => (
                          <span
                            key={b.key}
                            className="h-3 w-[3px] rounded-full"
                            style={{ background: b.color }}
                          />
                        ))}
                      </span>
                      <span className="mt-[2px] flex items-center gap-1">
                        {extras > 0 && (
                          <span className="font-mono text-[9px]" style={{ color: MUTED }}>
                            +{extras}
                          </span>
                        )}
                        {risk && (
                          <span className="h-[5px] w-[5px] rounded-full" style={{ background: TIGHT }} />
                        )}
                      </span>
                      {locked[date] && (
                        <span className="absolute bottom-1 h-[2px] w-4" style={{ background: INK }} />
                      )}
                    </button>
                  );
                })}
              </div>

              <p className="mt-3 font-mono text-[11px] leading-relaxed" style={{ color: MUTED }}>
                바탕이 진한 칸이 금토일. 막대는 그날 필수 자리이고 회색은 빈 자리
                <br />
                노란 점 = 바에 {FLOOR_MIN}명이 안 남는 시간이 있음
              </p>
            </>
          )}

          {/* 선택한 날짜 상세 */}
          {selected && (
            <div className="mt-4 rounded-lg p-3" style={{ background: CARD, border: `1px solid ${RULE}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold">
                    {selected.slice(5).replace("-", "/")} ({WD[wdIndex(parse(selected))]})
                  </span>
                  {isPeak(selected) && (
                    <span
                      className="rounded px-1 py-[1px] font-mono text-[10px]"
                      style={{ background: INK, color: PAPER }}
                    >
                      금토일
                    </span>
                  )}
                </div>
                {locked[selected] && (
                  <button
                    onClick={() => unlock(selected)}
                    className="rounded px-2 py-1 font-mono text-[11px] active:opacity-60"
                    style={{ border: `1px solid ${RULE}`, color: MUTED }}
                  >
                    잠금 풀기
                  </button>
                )}
              </div>

              <div className="mt-3 rounded-md p-2" style={{ background: PAPER }}>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px]" style={{ color: MUTED }}>
                    배정 인원
                  </span>
                  <span
                    className="font-mono text-[10px]"
                    style={{ color: gapMinOf(selected) > 0 ? ALERT : MUTED }}
                  >
                    {gapMinOf(selected) > 0 ? `${gapMinOf(selected)}분 부족` : "빈 자리 없음"}
                  </span>
                </div>
                <div className="mt-2">
                  <AxisChart
                    values={covOf(selected)}
                    top={Math.max(3, ...covOf(selected), ...demandFor(selected))}
                    colorAt={(n, i) =>
                      gapOf(covOf(selected), selected)[i] > 0 ? ALERT : FILLED
                    }
                  />
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <span className="font-mono text-[10px]" style={{ color: MUTED }}>
                    바 인원 (휴게·빵 제외)
                  </span>
                  <span
                    className="font-mono text-[10px]"
                    style={{
                      color:
                        floorMinOf(selected) < FLOOR_MIN
                          ? ALERT
                          : floorMinOf(selected) < FLOOR_OK
                          ? TIGHT
                          : MUTED,
                    }}
                  >
                    17시 전 최소 {floorMinOf(selected)}명
                  </span>
                </div>
                <div className="mt-2">
                  <AxisChart
                    values={floorOf(selected)}
                    top={Math.max(4, ...floorOf(selected))}
                    guide={FLOOR_MIN}
                    colorAt={(n, i) =>
                      i < FLOOR_FROM || i >= FLOOR_UNTIL
                        ? EMPTY
                        : n < FLOOR_MIN
                        ? ALERT
                        : FILLED
                    }
                  />
                </div>

                <div className="mt-3 font-mono text-[10px]" style={{ color: MUTED }}>
                  휴게인원 (휴게+빵으로 자리 비운 인원)
                </div>
                <div className="mt-2">
                  <AxisChart
                    values={restOf(selected)}
                    top={Math.max(2, ...restOf(selected))}
                    colorAt={() => GUEST}
                  />
                </div>

                <div className="mt-3 font-mono" style={{ fontSize: 10, color: MUTED }}>
                  휴게와 빵
                </div>
                <div className="mt-1">
                  <BreakTimeline date={selected} />
                  <Ticks />
                </div>
              </div>

              {breaksOf(selected).length > 0 && (
                <div className="mt-3 rounded-md p-2" style={{ background: PAPER }}>
                  <div className="font-mono text-[10px]" style={{ color: MUTED }}>
                    휴게 순번
                  </div>
                  <div className="mt-2 flex flex-col gap-1">
                    {breaksOf(selected).map((b, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: slotInfo(b.slotKey).color }}
                        />
                        <span className="text-xs">{empById(b.empId)?.name}</span>
                        <span className="font-mono text-[10px]" style={{ color: MUTED }}>
                          {slotInfo(b.slotKey).label}
                        </span>
                        <span className="ml-auto font-mono text-[11px]">
                          {bucketLabel(b.from)}~{bucketLabel(b.to)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-3 flex flex-col gap-2">
                {ALL_SLOTS.map((slot) => {
                  const ids = dayOf(selected)[slot.key] || [];
                  const req = slot.half ? 0 : needOf(slot, selected);
                  const lack = !slot.half && ids.length < req;
                  const cap = slot.half ? 99 : req + slot.extra;
                  const blocked = startTaken(dayOf(selected), slot);

                  return (
                    <div
                      key={slot.key}
                      className="rounded-md p-2"
                      style={{
                        border: lack && !blocked ? `1px dashed ${ALERT}` : `1px solid ${RULE}`,
                        background: PAPER,
                        opacity: blocked && ids.length === 0 ? 0.45 : 1,
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="rounded px-1 font-mono text-[9px] font-semibold"
                          style={{ background: slot.color, color: PAPER }}
                        >
                          {slot.short}
                        </span>
                        <span className="text-xs font-semibold">{slot.label}</span>
                        <span className="font-mono text-[10px]" style={{ color: MUTED }}>
                          {timeText(slot)}
                        </span>
                        <span
                          className="ml-auto font-mono text-[10px]"
                          style={{ color: lack && !blocked ? ALERT : MUTED }}
                        >
                          {blocked && ids.length === 0
                            ? "같은 시각 사용중"
                            : `${ids.length}${slot.half ? "" : `/${req}`}`}
                        </span>
                      </div>

                      <div className="mt-2 flex flex-wrap gap-1">
                        {ids.map((id) => {
                          const e = empById(id);
                          const guest = e && e.storeId !== storeId;
                          return (
                            <button
                              key={id}
                              onClick={() => removeFrom(selected, slot.key, id)}
                              className="rounded-full px-3 py-2 text-xs font-medium active:opacity-60"
                              style={{ background: guest ? GUEST : slot.color, color: PAPER }}
                            >
                              {e?.name}
                              {guest && ` (${storeName(e.storeId).split(" ")[0]} 지원)`} ×
                            </button>
                          );
                        })}
                        {!blocked && ids.length < cap && (
                          <button
                            onClick={() => setPicker({ date: selected, slotKey: slot.key })}
                            className="rounded-full px-3 py-2 text-xs active:opacity-60"
                            style={{ border: `1px dashed ${RULE}`, color: MUTED }}
                          >
                            + 넣기
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 월 근무 요약 */}
          {view === "month" && hasSchedule && (
            <div className="mt-4 rounded-lg p-3" style={{ background: CARD, border: `1px solid ${RULE}` }}>
              <div className="font-mono text-[11px]" style={{ color: MUTED }}>
                이번 달 근무일수 (쩜오 0.5, 전 매장 합산)
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {staff.map((e) => {
                  const st = stats[e.id] || { days: 0, half: 0, guest: 0 };
                  const top = Math.max(1, ...staff.map((s) => stats[s.id]?.days || 0));
                  return (
                    <div key={e.id} className="flex items-center gap-2">
                      <span className="w-16 shrink-0 truncate text-xs">
                        {e.name}
                        {e.kind === "night" && (
                          <span className="ml-1 font-mono text-[9px]" style={{ color: MUTED }}>
                            야
                          </span>
                        )}
                      </span>
                      <span className="h-2 flex-1 rounded-full" style={{ background: PAPER }}>
                        <span
                          className="block h-2 rounded-full"
                          style={{
                            width: `${(st.days / top) * 100}%`,
                            background: e.kind === "night" ? INK : FILLED,
                          }}
                        />
                      </span>
                      <span className="w-8 text-right font-mono text-xs">{st.days}</span>
                      {st.guest > 0 ? (
                        <span className="w-12 text-right font-mono text-[10px]" style={{ color: GUEST }}>
                          지원{st.guest}
                        </span>
                      ) : (
                        <span
                          className="w-12 text-right font-mono text-[10px]"
                          style={{ color: st.half > e.maxHalf ? ALERT : MUTED }}
                        >
                          쩜{st.half}/{e.maxHalf}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 직원 */}
      {tab === "people" && (
        <div className="px-4 pb-8">
          <button
            onClick={addEmployee}
            className="mt-3 w-full rounded-md py-3 text-sm font-semibold active:opacity-70"
            style={{ background: INK, color: PAPER }}
          >
            직원 추가
          </button>

          <div className="mt-3 flex flex-col gap-2">
            {staff.map((e) => {
              const st = stats[e.id] || { days: 0, half: 0, guest: 0 };
              return (
                <div key={e.id} className="rounded-lg p-3" style={{ background: CARD, border: `1px solid ${RULE}` }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{e.name}</span>
                    {e.until && (
                      <span
                        className="rounded px-1 py-[1px] font-mono text-[10px]"
                        style={{ background: "#F7E6E1", color: ALERT }}
                      >
                        {e.until.slice(5).replace("-", "/")}까지
                      </span>
                    )}
                    {Object.keys(e.pins || {}).length > 0 && (
                      <span
                        className="rounded px-1 py-[1px] font-mono text-[10px]"
                        style={{ background: "#E4EDE9", color: FILLED }}
                      >
                        {Object.entries(e.pins)
                          .map(([d, k]) => `${Number(d.slice(8))}일 ${slotInfo(k).label}`)
                          .join(", ")}
                      </span>
                    )}
                    <button
                      onClick={() => removeEmployee(e.id)}
                      className="ml-auto font-mono text-[11px] active:opacity-60"
                      style={{ color: ALERT }}
                    >
                      삭제
                    </button>
                  </div>

                  {e.kind === "day" && (
                    <button
                      onClick={() => patchEmp(e.id, { canEightStart: !e.canEightStart })}
                      className="mt-3 flex w-full items-center justify-between rounded-md px-3 py-3 active:opacity-60"
                      style={e.canEightStart ? { background: FILLED, color: PAPER } : { border: `1px solid ${RULE}` }}
                    >
                      <span className="text-sm font-medium">8시 시작 가능</span>
                      <span className="font-mono text-[11px]" style={{ color: e.canEightStart ? PAPER : MUTED }}>
                        쩜오 {st.half}회 누적
                      </span>
                    </button>
                  )}

                  <button
                    onClick={() => patchEmp(e.id, { isRookie: !e.isRookie })}
                    className="mt-2 flex w-full items-center justify-between rounded-md px-3 py-3 active:opacity-60"
                    style={e.isRookie ? { background: GUEST, color: PAPER } : { border: `1px solid ${RULE}` }}
                  >
                    <span className="text-sm font-medium">신입</span>
                    <span className="font-mono text-[11px]" style={{ color: e.isRookie ? PAPER : MUTED }}>
                      신입끼리 오픈조(8시+9시) 동반 금지
                    </span>
                  </button>

                  {e.kind === "night" && st.guest > 0 && (
                    <div
                      className="mt-3 rounded-md px-3 py-2 font-mono text-[11px]"
                      style={{ background: "#F3EEE0", color: GUEST }}
                    >
                      이번 달 타 지점 지원 {st.guest}일
                    </div>
                  )}

                  <div className="mt-2 flex items-center gap-2">
                    <span className="w-16 text-xs" style={{ color: MUTED }}>
                      구분
                    </span>
                    {[
                      ["day", "주간"],
                      ["night", "야간"],
                    ].map(([k, label]) => (
                      <button
                        key={k}
                        onClick={() => patchEmp(e.id, { kind: k })}
                        className="h-8 flex-1 rounded text-xs active:opacity-60"
                        style={
                          e.kind === k
                            ? { background: INK, color: PAPER }
                            : { border: `1px solid ${RULE}`, color: MUTED }
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <span className="w-16 text-xs" style={{ color: MUTED }}>
                      주 최대
                    </span>
                    <div className="flex flex-1 gap-1">
                      {[3, 4, 5, 6].map((n) => (
                        <button
                          key={n}
                          onClick={() => patchEmp(e.id, { maxPerWeek: n })}
                          className="h-8 flex-1 rounded font-mono text-xs active:opacity-60"
                          style={
                            e.maxPerWeek === n
                              ? { background: INK, color: PAPER }
                              : { border: `1px solid ${RULE}`, color: MUTED }
                          }
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <span className="w-16 text-xs" style={{ color: MUTED }}>
                      주 최소
                    </span>
                    <div className="flex flex-1 gap-1">
                      {[0, 2, 3, 4].map((n) => (
                        <button
                          key={n}
                          onClick={() => patchEmp(e.id, { minPerWeek: n })}
                          className="h-8 flex-1 rounded font-mono text-xs active:opacity-60"
                          style={
                            e.minPerWeek === n
                              ? { background: INK, color: PAPER }
                              : { border: `1px solid ${RULE}`, color: MUTED }
                          }
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <span className="w-16 text-xs" style={{ color: MUTED }}>
                      평일 최대
                    </span>
                    <div className="flex flex-1 gap-1">
                      {[null, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n ?? "off"}
                          onClick={() => patchEmp(e.id, { maxWeekday: n })}
                          className="h-8 flex-1 rounded font-mono text-xs active:opacity-60"
                          style={
                            (e.maxWeekday ?? null) === n
                              ? { background: INK, color: PAPER }
                              : { border: `1px solid ${RULE}`, color: MUTED }
                          }
                        >
                          {n ?? "제한없음"}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <span className="w-16 shrink-0 text-xs" style={{ color: MUTED }}>
                      가능 시간
                    </span>
                    {[
                      ["weekday", "평일"],
                      ["peak", "금토일"],
                    ].map(([k, label]) => (
                      <button
                        key={k}
                        onClick={() => editAvail(e, k)}
                        className="h-8 flex-1 rounded font-mono text-[10px] active:opacity-60"
                        style={
                          e.avail[k]
                            ? { background: GUEST, color: PAPER }
                            : { border: `1px solid ${RULE}`, color: MUTED }
                        }
                      >
                        {label}{" "}
                        {e.avail[k]
                          ? `${bucketLabel(e.avail[k][0])}~${bucketLabel(e.avail[k][1])}`
                          : "종일"}
                      </button>
                    ))}
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <span className="w-16 shrink-0 text-xs" style={{ color: MUTED }}>
                      고정 요일
                    </span>
                    <div className="flex flex-1 gap-1">
                      {WD.map((w, i) => {
                        const on = (e.fixedDays || []).includes(i);
                        return (
                          <button
                            key={w}
                            onClick={() =>
                              patchEmp(e.id, {
                                fixedDays: on
                                  ? e.fixedDays.filter((d) => d !== i)
                                  : [...(e.fixedDays || []), i],
                              })
                            }
                            className="h-8 flex-1 rounded text-[11px] active:opacity-60"
                            style={
                              on
                                ? { background: INK, color: PAPER }
                                : { border: `1px solid ${RULE}`, color: MUTED }
                            }
                          >
                            {w}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="mt-3 flex gap-1">
                    <button
                      onClick={() => setVacFor(vacFor === e.id ? null : e.id)}
                      className="flex-1 rounded-md py-2 text-xs active:opacity-60"
                      style={{ border: `1px solid ${RULE}`, color: MUTED }}
                    >
                      휴가 {e.vacations.filter((d) => d.startsWith(`${year}-${pad(month)}`)).length}일
                      {vacFor === e.id ? " 닫기" : " 지정"}
                    </button>
                    <button
                      onClick={() => editUntil(e)}
                      className="rounded-md px-3 py-2 text-xs active:opacity-60"
                      style={{ border: `1px solid ${RULE}`, color: MUTED }}
                    >
                      종료일
                    </button>
                  </div>

                  {vacFor === e.id && (
                    <div className="mt-2 grid grid-cols-7 gap-1">
                      {cells.map((date, i) =>
                        !date ? (
                          <div key={`v${i}`} />
                        ) : (
                          <button
                            key={date}
                            onClick={() => toggleVacation(e.id, date)}
                            className="h-9 rounded font-mono text-[11px] active:opacity-60"
                            style={
                              e.vacations.includes(date)
                                ? { background: ALERT, color: PAPER }
                                : { border: `1px solid ${RULE}`, color: MUTED }
                            }
                          >
                            {Number(date.slice(8))}
                          </button>
                        )
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 규칙 */}
      {tab === "rules" && (
        <div className="px-4 pb-8">
          <div className="mt-3 rounded-lg p-4" style={{ background: CARD, border: `1px solid ${RULE}` }}>
            <div className="text-sm font-semibold">근무타입</div>
            <div className="mt-1 font-mono text-[10px]" style={{ color: MUTED }}>
              평일 / 금토일
            </div>
            <div className="mt-2 flex flex-col gap-1">
              {ALL_SLOTS.map((s) => (
                <div key={s.key} className="flex items-center gap-2 py-1">
                  <span
                    className="w-9 rounded text-center font-mono text-[9px] font-semibold"
                    style={{ background: s.color, color: PAPER }}
                  >
                    {s.short}
                  </span>
                  <span className="w-14 text-xs font-medium">{s.label}</span>
                  <span className="font-mono text-[11px]" style={{ color: MUTED }}>
                    {timeText(s)}
                  </span>
                  <span className="ml-auto font-mono text-[11px]" style={{ color: MUTED }}>
                    {s.half
                      ? "보충"
                      : `${needs[s.key]?.weekday ?? 0} / ${needs[s.key]?.peak ?? 0}명`}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed" style={{ color: MUTED }}>
              마감을 뺀 나머지는 같은 시각에 두 명이 출근할 수 없습니다. 찐오, 이른오전, 오전쩜오는
              모두 8시 출근이라 하루에 하나만 씁니다.
            </p>
          </div>

          {/* 필요 인원 직접 조절 */}
          <div className="mt-3 rounded-lg p-4" style={{ background: CARD, border: `1px solid ${RULE}` }}>
            <div className="text-sm font-semibold">자리별 필수 인원</div>
            <div className="mt-1 text-[11px]" style={{ color: MUTED }}>
              0으로 두면 인원이 남을 때만 채우는 여유 자리가 됩니다. 동시에 몇 명이 서 있게 될지가
              여기서 정해집니다.
            </div>
            {ALL_SLOTS.filter((sl) => !sl.half).map((sl) => (
              <div key={sl.key} className="mt-3">
                <div className="flex items-center gap-2">
                  <span
                    className="w-9 rounded text-center font-mono text-[9px] font-semibold"
                    style={{ background: sl.color, color: PAPER }}
                  >
                    {sl.short}
                  </span>
                  <span className="text-xs font-medium">{sl.label}</span>
                </div>
                {[
                  ["weekday", "평일"],
                  ["peak", "금토일"],
                ].map(([kind, label]) => (
                  <div key={kind} className="mt-1 flex items-center gap-2">
                    <span className="w-12 shrink-0 text-[11px]" style={{ color: MUTED }}>
                      {label}
                    </span>
                    <div className="flex flex-1 gap-1">
                      {[0, 1, 2, 3].map((v) => (
                        <button
                          key={v}
                          onClick={() => patchNeed(sl.key, kind, v)}
                          className="h-7 flex-1 rounded font-mono text-[11px] active:opacity-60"
                          style={
                            (needs[sl.key]?.[kind] ?? 0) === v
                              ? { background: INK, color: PAPER }
                              : { border: `1px solid ${RULE}`, color: MUTED }
                          }
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="mt-3 rounded-lg p-4" style={{ background: CARD, border: `1px solid ${RULE}` }}>
            <div className="text-sm font-semibold">연속 근무 제한</div>
            <p className="mt-2 text-[11px] leading-relaxed" style={{ color: MUTED }}>
              주 근무일은 누구든 최대 {WEEK_CAP}일입니다. 인원이 모자라도 이 선은 넘기지 않습니다.
              <br />
              마감 다음날 오픈은 한 사람당 주 1회까지입니다.
              <br />
              마감 - 오픈 - 마감으로 이어지는 3일 패턴은 아예 만들지 않습니다.
            </p>
          </div>

          <div className="mt-3 rounded-lg p-4" style={{ background: CARD, border: `1px solid ${RULE}` }}>
            <div className="text-sm font-semibold">휴게와 빵 배송</div>
            <p className="mt-2 text-[11px] leading-relaxed" style={{ color: MUTED }}>
              휴게는 1시간이고 동시에 한 명만 쉽니다. 오픈조는 12:30부터, 마감조는 15:30부터 출근이
              이른 순서대로 돕니다. 순번이 퇴근 시각을 넘으면 퇴근 한 시간 전으로 당깁니다. 6시간짜리
              쩜오는 휴게를 돌지 않습니다.
            </p>

            {[
              ["평일", breadWeekday, setBreadWeekday],
              ["금토일", breadPeak, setBreadPeak],
            ].map(([label, val, setter]) => (
              <div key={label} className="mt-3 flex items-center gap-2">
                <span className="w-14 shrink-0 text-xs" style={{ color: MUTED }}>
                  {label} 빵
                </span>
                <div className="flex flex-1 gap-1">
                  {[tb(14), tb(15), tb(16), tb(17), tb(17, 30)].map((t) => (
                    <button
                      key={t}
                      onClick={() => setter(t)}
                      className="h-8 flex-1 rounded font-mono text-[10px] active:opacity-60"
                      style={
                        val === t
                          ? { background: INK, color: PAPER }
                          : { border: `1px solid ${RULE}`, color: MUTED }
                      }
                    >
                      {bucketLabel(t)}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            <div className="mt-4 flex items-center gap-3 font-mono text-[10px]" style={{ color: MUTED }}>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: FILLED }} />
                {FLOOR_OK}명 이상
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: TIGHT }} />
                {FLOOR_MIN}명
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: ALERT }} />
                {FLOOR_MIN}명 미만
              </span>
            </div>
            <p className="mt-2 font-mono text-[10px]" style={{ color: MUTED }}>
              17시 이후는 한가하므로 이 기준을 적용하지 않습니다.
            </p>
          </div>

          <div className="mt-3 rounded-lg p-4" style={{ background: CARD, border: `1px solid ${RULE}` }}>
            <div className="text-sm font-semibold">시간대별 필요 인원</div>
            {[
              ["평일 (월~목)", demandWeekday],
              ["금토일", demandPeak],
            ].map(([label, arr]) => (
              <div key={label} className="mt-3">
                <div className="font-mono text-[10px]" style={{ color: MUTED }}>
                  {label}
                </div>
                <div className="mt-1">
                  <AxisChart
                    values={arr}
                    top={Math.max(...demandPeak, ...demandWeekday)}
                    colorAt={() => INK}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 rounded-lg p-4" style={{ background: CARD, border: `1px solid ${RULE}` }}>
            <div className="text-sm font-semibold">평일에 인원이 모자랄 때</div>
            <div className="mt-1 text-[11px]" style={{ color: MUTED }}>
              금토일은 이 설정과 무관하게 쩜오와 추가근무를 모두 씁니다.
            </div>
            <div className="mt-2 flex flex-col gap-1">
              {[
                ["leave", "비워두기", "빈 시간대를 그대로 남긴다"],
                ["half", "쩜오만", "비는 시간을 가장 많이 덮는 쩜오를 넣는다"],
                ["extra", "하루 더만", "주 상한을 넘겨 정규 자리에 넣는다"],
                ["both", "쩜오 먼저, 그래도 모자라면 하루 더", "둘 다 쓴다"],
              ].map(([k, label, desc]) => (
                <button
                  key={k}
                  onClick={() => setShortage(k)}
                  className="rounded-md px-3 py-3 text-left active:opacity-60"
                  style={shortage === k ? { background: INK, color: PAPER } : { border: `1px solid ${RULE}` }}
                >
                  <div className="text-sm font-medium">{label}</div>
                  <div className="mt-[2px] text-[11px]" style={{ color: shortage === k ? RULE : MUTED }}>
                    {desc}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <p className="mt-4 font-mono text-[11px] leading-relaxed" style={{ color: MUTED }}>
            배정 순서는 못박은 근무 → 고정 요일 → 주 최소 미달자 → 필수 자리 → 여유 자리 → 부족분
            보충입니다. 주 단위로 금토일을 먼저 잡고 평일을 채웁니다. 야간은 자기 매장 인력을 먼저
            쓰고, 안 되면 주 6일까지 늘린 뒤, 그래도 모자라면 다른 지점 야간 직원이 지원을 옵니다.
          </p>
        </div>
      )}

      {/* 이력 */}
      {tab === "history" && (
        <div className="px-4 pb-8">
          {!supabase && (
            <p className="mt-3 text-xs" style={{ color: MUTED }}>
              DB가 연결되지 않아 이력을 볼 수 없습니다.
            </p>
          )}
          {supabase && (
            <>
              <p className="mt-3 font-mono text-[11px]" style={{ color: MUTED }}>
                {storeName(storeId)} · {weekStart.slice(5).replace("-", "/")} 주에 돌린 자동 배정 기록.
                눌러보면 그때 직원 탭·규칙 탭에 있던 값을 그대로 볼 수 있습니다.
              </p>
              {runsLoading && (
                <p className="mt-2 text-xs" style={{ color: MUTED }}>
                  불러오는 중…
                </p>
              )}
              {runsError && (
                <p className="mt-2 text-xs" style={{ color: ALERT }}>
                  {runsError}
                </p>
              )}
              {!runsLoading && !runsError && runs.length === 0 && (
                <p className="mt-2 text-xs" style={{ color: MUTED }}>
                  이 매장·이 주로 자동 배정을 돌린 기록이 아직 없습니다.
                </p>
              )}
              <div className="mt-2 flex flex-col gap-2">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    onClick={() => setSelectedRun(run)}
                    className="flex w-full items-center justify-between rounded-lg p-3 text-left active:opacity-60"
                    style={{ background: CARD, border: `1px solid ${RULE}` }}
                  >
                    <span className="font-mono text-[11px]">
                      {new Date(run.created_at).toLocaleString("ko-KR")}
                    </span>
                    <span className="flex items-center gap-2">
                      <span
                        className="rounded px-1 py-[1px] font-mono text-[10px]"
                        style={
                          run.status === "OPTIMAL"
                            ? { background: "#E4EDE9", color: FILLED }
                            : { background: "#F7E6E1", color: ALERT }
                        }
                      >
                        {run.status}
                      </span>
                      {run.warnings?.length > 0 && (
                        <span className="font-mono text-[10px]" style={{ color: ALERT }}>
                          경고 {run.warnings.length}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* 이력 스냅샷 상세 — 직원 탭/규칙 탭과 같은 내용을, 그 시점 값 그대로 */}
      {selectedRun && (
        <div
          className="fixed inset-0 z-30 flex items-end"
          style={{ background: "rgba(22,32,43,0.4)" }}
          onClick={() => setSelectedRun(null)}
        >
          <div
            className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl p-4"
            style={{ background: PAPER, paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">
                {new Date(selectedRun.created_at).toLocaleString("ko-KR")}
              </span>
              <span
                className="rounded px-1 py-[1px] font-mono text-[10px]"
                style={
                  selectedRun.status === "OPTIMAL"
                    ? { background: "#E4EDE9", color: FILLED }
                    : { background: "#F7E6E1", color: ALERT }
                }
              >
                {selectedRun.status}
              </span>
              <button
                onClick={() => setSelectedRun(null)}
                className="ml-auto font-mono text-xs active:opacity-60"
                style={{ color: MUTED }}
              >
                닫기
              </button>
            </div>

            {(() => {
              const emps = (selectedRun.employees_snapshot || []).filter(
                (e) => e.storeId === selectedRun.store_id
              );
              const guests = (selectedRun.employees_snapshot || []).filter(
                (e) => e.storeId !== selectedRun.store_id
              );
              const rules = selectedRun.rules_snapshot || {};
              return (
                <>
                  <div className="mt-4 text-sm font-semibold">직원 ({emps.length}명)</div>
                  <div className="mt-2 flex flex-col gap-2">
                    {emps.map((e) => (
                      <SnapshotEmployeeCard key={e.id} e={e} />
                    ))}
                  </div>
                  {guests.length > 0 && (
                    <p className="mt-2 font-mono text-[11px]" style={{ color: GUEST }}>
                      타 지점 야간 지원 후보로 같이 고려됨: {guests.map((e) => e.name).join(", ")}
                    </p>
                  )}

                  <div className="mt-5 text-sm font-semibold">규칙</div>
                  <div className="mt-2">
                    <SnapshotRules rules={rules} needs={selectedRun.needs_snapshot} />
                  </div>

                  {selectedRun.warnings?.length > 0 && (
                    <div className="mt-3 rounded-lg p-4" style={{ background: CARD, border: `1px solid ${RULE}` }}>
                      <div className="text-sm font-semibold" style={{ color: ALERT }}>
                        경고
                      </div>
                      <ul className="mt-1 font-mono text-[11px] leading-relaxed" style={{ color: MUTED }}>
                        {selectedRun.warnings.map((w, i) => (
                          <li key={i}>- {w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* 직원 고르기 시트 */}
      {picker && (
        <div
          className="fixed inset-0 z-30 flex items-end"
          style={{ background: "rgba(22,32,43,0.4)" }}
          onClick={() => setPicker(null)}
        >
          <div
            className="max-h-[70vh] w-full overflow-y-auto rounded-t-2xl p-4"
            style={{ background: CARD, paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{slotInfo(picker.slotKey).label} 넣기</span>
              <span className="font-mono text-[11px]" style={{ color: MUTED }}>
                {picker.date.slice(5).replace("-", "/")}
              </span>
              <button
                onClick={() => setPicker(null)}
                className="ml-auto font-mono text-xs active:opacity-60"
                style={{ color: MUTED }}
              >
                닫기
              </button>
            </div>

            <div className="mt-3 flex flex-col gap-1">
              {candidates(picker.date, picker.slotKey).map((e) => {
                const load = weekLoad(e.id, picker.date);
                const overWeek = load >= Math.min(e.maxPerWeek, WEEK_CAP);
                const halfUsed = stats[e.id]?.half || 0;
                const isHalf = !!slotInfo(picker.slotKey).half;
                const overHalf = isHalf && halfUsed >= e.maxHalf;
                const guest = e.storeId !== storeId;
                return (
                  <button
                    key={e.id}
                    onClick={() => addTo(picker.date, picker.slotKey, e.id)}
                    className="flex items-center gap-2 rounded-md px-3 py-3 text-left active:opacity-60"
                    style={{ border: `1px solid ${guest ? GUEST : RULE}` }}
                  >
                    <span className="flex-1 text-sm font-medium">
                      {e.name}
                      {guest && (
                        <span className="ml-1 font-mono text-[10px]" style={{ color: GUEST }}>
                          {storeName(e.storeId).split(" ")[0]}
                        </span>
                      )}
                    </span>
                    <span className="font-mono text-[11px]" style={{ color: overWeek ? ALERT : MUTED }}>
                      주 {load}/{Math.min(e.maxPerWeek, WEEK_CAP)}
                    </span>
                    {isHalf && (
                      <span className="font-mono text-[11px]" style={{ color: overHalf ? ALERT : MUTED }}>
                        쩜 {halfUsed}/{e.maxHalf}
                      </span>
                    )}
                  </button>
                );
              })}
              {candidates(picker.date, picker.slotKey).length === 0 && (
                <div className="py-6 text-center text-xs" style={{ color: MUTED }}>
                  넣을 수 있는 직원이 없습니다. 자격, 가능 시간, 휴가, 종료일을 확인해 보세요.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
