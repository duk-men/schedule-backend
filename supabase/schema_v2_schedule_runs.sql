-- 자동 배정(runAuto)을 돌릴 때마다, 그 시점 설정값과 결과를 스냅샷으로 남긴다.
-- employees/app_state는 "지금" 상태만 들고 있어서, 나중에 직원 설정이나 규칙을
-- 바꾸면 "그때 왜 이렇게 나왔는지"를 설명할 근거가 사라진다 — 이 테이블이 그 기록이다.
-- schema.sql을 이미 실행했다면, 이 파일만 추가로 SQL Editor에서 실행하면 된다.

create table if not exists schedule_runs (
  id bigint generated always as identity primary key,
  store_id text not null,
  week_start date not null,
  employees_snapshot jsonb not null,  -- 그 시점 대상 직원 전체 설정 (empForApi 형태)
  rules_snapshot jsonb not null,      -- weekCap, floor, break, bread, overtime, shortage 등
  needs_snapshot jsonb not null,      -- 슬롯별 필요인원 설정
  board_result jsonb not null,        -- 그 주 실제 배정 결과 (이 매장분만)
  status text,                        -- OPTIMAL | FEASIBLE | INFEASIBLE | TIMEOUT
  warnings jsonb,
  diagnostics jsonb,
  created_at timestamptz not null default now()
);

alter table schedule_runs enable row level security;
create policy "anon full access" on schedule_runs for all
  using (true) with check (true);

create index if not exists schedule_runs_store_week_idx
  on schedule_runs (store_id, week_start, created_at desc);
