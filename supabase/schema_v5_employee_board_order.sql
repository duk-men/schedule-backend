-- 직원 탭 순서·근무표 탭 순서를 저장한다. 매장별 employeeId 배열({storeId: [id, ...]})을
-- 각각 employee_order/board_order 컬럼에 담는다. 두 컬럼을 분리해두는 이유: 근무표 탭에서
-- 드래그로 바꾼 순서가 직원 탭 순서에 영향을 주면 안 되기 때문 (완전히 독립 관리).
-- schema.sql을 이미 실행했다면, 이 파일만 추가로 SQL Editor에서 실행하면 된다.

alter table app_state add column if not exists employee_order jsonb not null default '{}'::jsonb;
alter table app_state add column if not exists board_order jsonb not null default '{}'::jsonb;
