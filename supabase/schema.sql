-- 신중동/송도 근무표 앱 DB 스키마.
-- Supabase 대시보드 > SQL Editor에 붙여넣고 실행한다 (한 번만).
-- 로그인 기능이 없는 내부 도구라, anon key로 브라우저가 직접 읽고 쓴다.
-- RLS를 켜두되 anon 롤에 전체 권한을 열어서 지금 구조와 맞춘다.

create table if not exists employees (
  id bigint primary key,
  store_id text not null,
  name text not null,
  kind text not null default 'day',
  max_per_week integer not null default 5,
  min_per_week integer not null default 0,
  max_weekday integer,
  max_half integer not null default 4,
  can_eight_start boolean not null default false,
  until date,
  avail jsonb,
  fixed_days jsonb not null default '[]'::jsonb,
  pins jsonb not null default '{}'::jsonb,
  vacations jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- 배정표(board)·잠금(lock_map)·필요인원 설정(needs)·빵 시간·인원부족 모드·
-- 서버가 계산한 휴게(server_breaks)를 한 행에 통째로 저장한다. 팀이 하나뿐인
-- 내부 도구라 굳이 여러 행으로 쪼개지 않았다.
create table if not exists app_state (
  id text primary key default 'default',
  board jsonb not null default '{}'::jsonb,
  lock_map jsonb not null default '{}'::jsonb,
  needs jsonb not null default '{}'::jsonb,
  bread_weekday integer,
  bread_peak integer,
  shortage text not null default 'both',
  server_breaks jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into app_state (id) values ('default') on conflict (id) do nothing;

alter table employees enable row level security;
alter table app_state enable row level security;

create policy "anon full access" on employees for all
  using (true) with check (true);
create policy "anon full access" on app_state for all
  using (true) with check (true);

-- updated_at을 매 upsert마다 자동으로 지금 시각으로 갱신
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger employees_set_updated_at
  before update on employees
  for each row execute function set_updated_at();

create trigger app_state_set_updated_at
  before update on app_state
  for each row execute function set_updated_at();
