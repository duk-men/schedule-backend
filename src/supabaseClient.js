// Supabase 클라이언트. 직원 정보·배정표를 브라우저에서 직접 읽고 쓴다
// (로그인 기능이 없는 내부 도구라 anon key로 직접 접근 — RLS로 anon 롤에
// 전체 권한을 열어둔 상태. SPEC.md "DB 스키마" 절 참고).
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn(
    "[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY가 없습니다. " +
      ".env(로컬) 또는 Vercel 환경변수를 확인하세요. DB 저장 없이 동작합니다."
  );
}

export const supabase = url && anonKey ? createClient(url, anonKey) : null;

// 전체 앱 상태(배정표·설정)를 한 행으로 저장하는 테이블의 고정 행 id
export const APP_STATE_ID = "default";
