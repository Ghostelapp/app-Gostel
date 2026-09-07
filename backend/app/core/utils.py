import hashlib
from datetime import datetime, timezone
from typing import Optional
from fastapi import Request


def api_error(code: str, message: str) -> dict:
    return {"code": code, "message": message, "msg": message}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def ensure_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if not isinstance(dt, datetime):
        return dt
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ""
    if peer in {"127.0.0.1", "::1"}:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
    return peer or "unknown"


def request_client_meta(request: Request) -> dict:
    user_agent = (request.headers.get("user-agent") or "").strip()
    forwarded = request.headers.get("x-device-name") or request.headers.get("x-device-id") or ""
    device_label = (forwarded or user_agent or "Unknown device").strip()[:160]
    return {
        "ip_hash": hashlib.sha256(client_ip(request).encode("utf-8")).hexdigest(),
        "user_agent": user_agent[:500],
        "device_label": device_label,
    }
