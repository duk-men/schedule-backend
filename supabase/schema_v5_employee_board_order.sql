-- 직원 탭 순서·근무표 탭 순서를 저장한다.
-- employee_order: {storeId: [empId, ...]} — 직원 탭 순서, 매장별 하나.
-- board_order: {storeId: {weekStart: [empId, ...]}} — 근무표 탭 순서, 매장+주(週)별로
--   완전히 독립된 스냅샷. 한 주에서 순서를 바꿔도 다른 주에는 영향이 없다.
-- 두 컬럼을 분리해두는 이유: 근무표 탭에서 드래그로 바꾼 순서가 직원 탭 순서에
-- 영향을 주면 안 되기 때문 (완전히 독립 관리).
-- schema.sql을 이미 실행했다면, 이 파일만 추가로 SQL Editor에서 실행하면 된다.

alter table app_state add column if not exists employee_order jsonb not null default '{}'::jsonb;
alter table app_state add column if not exists board_order jsonb not null default '{}'::jsonb;
