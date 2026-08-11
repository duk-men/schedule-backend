-- 직원별 초과근무 가능일수 추가 (0.5일 단위). 정규 상한(min(maxPerWeek, weekCap))을
-- 넘어 그 직원이 추가로 일할 수 있는 날 수. 이전에는 모든 직원에게 똑같이 적용되는
-- 전역 규칙(rules.overtime)이었으나 직원별 항목으로 대체됐다 (SPEC.md 9.4절).
-- schema.sql을 이미 실행했다면, 이 파일만 추가로 SQL Editor에서 실행하면 된다.

alter table employees add column if not exists overtime_days numeric not null default 1;
