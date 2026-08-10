// 계산 서버(FastAPI + OR-Tools) 호출 래퍼. SPEC.md 5절 API 계약을 그대로 따른다.

class SolveError extends Error {
  constructor(message, kind, detail) {
    super(message);
    this.kind = kind; // "network" | "infeasible" | "http"
    this.detail = detail;
  }
}

export async function health() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false };
  }
}

export async function solveWeek(payload, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new SolveError("계산이 시간 내에 끝나지 않았습니다.", "network");
    }
    throw new SolveError("계산 서버에 연결할 수 없습니다. backend 폴더에서 uvicorn을 실행해 주세요.", "network");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.detail || "";
    } catch {
      // ignore
    }
    throw new SolveError(detail || `서버 오류 (HTTP ${res.status})`, "http", detail);
  }

  const data = await res.json();
  if (data.status === "INFEASIBLE") {
    throw new SolveError(
      "이 조건으로는 표를 만들 수 없습니다.",
      "infeasible",
      data.warnings || []
    );
  }
  return data;
}

export { SolveError };
