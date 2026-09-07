import hashlib
import re as _re
from datetime import datetime, timezone
from typing import Optional
from fastapi import Request


_USERNAME_RE = _re.compile(r"^[a-z0-9_]{3,20}$")


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


async def enforce_rate_limit(
    scope: str,
    identifier: str,
    *,
    limit: int,
    window_seconds: int,
) -> None:
    now = now_utc()
    bucket = int(now.timestamp()) // window_seconds
    digest = hashlib.sha256(identifier.encode("utf-8")).hexdigest()
    key = f"{scope}:{digest}:{bucket}"
    try:
        row = await db.rate_limits.find_one_and_update(
            {"key": key},
            {
                "$inc": {"count": 1},
                "$setOnInsert": {
                    "key": key,
                    "scope": scope,
                    "expires_at": now + timedelta(seconds=window_seconds * 2),
                },
            },
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        row = await db.rate_limits.find_one_and_update(
            {"key": key},
            {"$inc": {"count": 1}},
            return_document=ReturnDocument.AFTER,
        )
    if row and row.get("count", 0) > limit:
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Try again later.",
            headers={"Retry-After": str(window_seconds)},
        )
