-- 직원에 "신입" 속성 추가. 신입 두 명이 같은 날 오픈조(8시 자리+9시 자리)를
-- 나눠 맡지 못하게 하는 규칙(solver.py 3.5절)에 쓴다.
-- schema.sql을 이미 실행했다면, 이 파일만 추가로 SQL Editor에서 실행하면 된다.

alter table employees add column if not exists is_rookie boolean not null default false;
