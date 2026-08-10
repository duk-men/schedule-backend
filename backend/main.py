"""FastAPI 앱. SPEC.md 5절 API 계약. 무상태 — 요청 1건이 문제 1개다."""
from importlib.metadata import version

from fastapi import FastAPI, HTTPException

from schemas import HealthResponse, SolveRequest, SolveResponse
from solver import solve as run_solve

app = FastAPI()


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(ok=True, ortools=version("ortools"))


@app.post("/api/solve", response_model=SolveResponse, response_model_by_alias=True)
def solve_endpoint(req: SolveRequest) -> SolveResponse:
    try:
        return run_solve(req)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
