"""순수 유틸. 버킷/날짜 변환과 요일 판정만 담당한다.
슬롯·직원·규칙 같은 도메인 상수는 요청(SolveRequest)에서 온다 — 여기 박아두지 않는다.
"""
from datetime import date, timedelta

BUCKET = 30   # 분 단위
BPD = 48      # 하루 버킷 수


def tb(h, m=0):
    return (h * 60 + m) // BUCKET


def blabel(i):
    total = (i * BUCKET) % (24 * 60)
    return f"{total // 60:02d}:{total % 60:02d}"


def parse_date(s):
    return date.fromisoformat(s)


def fmt_date(d):
    return d.isoformat()


def shift_date(s, delta_days):
    return fmt_date(parse_date(s) + timedelta(days=delta_days))


def weekday_of(s):
    """월=0 … 일=6. python date.weekday()가 이미 이 규약이라 변환이 필요 없다."""
    return parse_date(s).weekday()


def is_peak(s):
    """금토일(4,5,6)이 피크."""
    return weekday_of(s) >= 4
