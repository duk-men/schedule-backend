"""SPEC.md 5절 API 계약의 Pydantic 표현."""
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class Avail(BaseModel):
    weekday: Optional[List[int]] = None   # [시작버킷, 종료버킷]
    peak: Optional[List[int]] = None


class Employee(BaseModel):
    id: int
    storeId: str
    name: str
    kind: Literal["day", "night"]
    maxPerWeek: int
    minPerWeek: int = 0
    maxWeekday: Optional[int] = None  # 평일(비피크)만 따로 거는 상한. None이면 제한 없음
    maxHalf: int = 0
    canJjinO: bool = False
    until: Optional[str] = None
    avail: Optional[Avail] = None
    fixedDays: List[int] = Field(default_factory=list)
    pins: Dict[str, str] = Field(default_factory=dict)
    vacations: List[str] = Field(default_factory=list)


class Slot(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    key: str
    label: str
    from_: int = Field(alias="from")
    to: int
    need: int = 0
    peak: int = 0
    extra: int = 0
    open: bool = False
    late: bool = False
    night: bool = False
    half: bool = False


class FloorRule(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: int = Field(alias="from")
    until: int
    min: int
    ceil: int


class BreakRule(BaseModel):
    len: int
    afterStart: int
    beforeEnd: int
    concurrent: int = 1


class BreadRule(BaseModel):
    weekday: int
    peak: int
    len: int = 1


class OvertimeRule(BaseModel):
    maxExtraShifts: int = 0
    maxExtraUnits: int = 0


class Rules(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    weekCap: int = 6
    startShared: List[str] = Field(default_factory=lambda: ["close"])
    floor: FloorRule
    break_: BreakRule = Field(alias="break")
    bread: BreadRule
    overtime: OvertimeRule = Field(default_factory=OvertimeRule)
    shortage: Literal["leave", "half", "extra", "both"] = "both"
    # 9.1에서 true로 확정. 필드는 남겨 프론트가 실험할 수 있게 하되 기본값·항상 보내는 값은 true.
    requireSlotFill: bool = True


class Weights(BaseModel):
    gapWeekday: float = 1
    gapPeak: float = 4
    gapDay: float = 20
    floor: float = 2
    over: float = 1.5
    fairness: float = 100
    minWeek: float = 500
    overtime: float = 180


class SolveRequest(BaseModel):
    storeId: str
    dates: List[str]
    employees: List[Employee]
    slots: List[Slot]
    rules: Rules
    weights: Weights = Field(default_factory=Weights)
    existing: Dict[str, Dict[str, Dict[str, List[int]]]] = Field(default_factory=dict)
    locked: List[str] = Field(default_factory=list)
    assumePrevNightCovered: bool = True
    timeLimitSec: float = 30


class PerDayDiag(BaseModel):
    date: str
    peak: bool
    gapMinutes: int
    floorMin: int
    overMinutes: int


class PerEmployeeDiag(BaseModel):
    empId: int
    shifts: int
    cap: int
    workDays: float
    overUnits: float
    minShortfall: float


class Penalties(BaseModel):
    gap: float
    gapDays: float
    floor: float
    over: float
    fairness: float
    minWeek: float
    overtime: float


class Diagnostics(BaseModel):
    perDay: List[PerDayDiag]
    perEmployee: List[PerEmployeeDiag]
    penalties: Penalties


class BreakEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    empId: int
    from_: int = Field(alias="from")
    to: int


class SolveResponse(BaseModel):
    status: Literal["OPTIMAL", "FEASIBLE", "INFEASIBLE", "TIMEOUT"]
    objective: Optional[float] = None
    bound: Optional[float] = None
    wallTimeSec: float
    board: Dict[str, Dict[str, Dict[str, List[int]]]] = Field(default_factory=dict)
    breaks: Dict[str, List[BreakEntry]] = Field(default_factory=dict)
    diagnostics: Optional[Diagnostics] = None
    warnings: List[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    ok: bool
    ortools: str
