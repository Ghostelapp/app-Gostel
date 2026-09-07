import uuid
import jwt
import bcrypt
from datetime import datetime, timezone, timedelta
from typing import Optional
from fastapi import Depends, HTTPException, Request, status

from app.core.config import JWT_SECRET, JWT_ALG, logger
from app.core.database import db
from app.core.utils import now_utc, ensure_utc, request_client_meta


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_access_token(
    user_id: str,
    email: str,
    *,
    session_id: Optional[str] = None,
) -> tuple[str, str, datetime, str]:
    jti = str(uuid.uuid4())
    expires_at = now_utc() + timedelta(days=7)
    sid = session_id or str(uuid.uuid4())
    payload = {
        "sub": user_id,
        "email": email,
        "exp": expires_at,
        "type": "access",
        "jti": jti,
        "sid": sid,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG), jti, expires_at, sid


def create_ws_ticket(user_id: str, session_id: Optional[str] = None) -> tuple[str, str, datetime]:
    jti = str(uuid.uuid4())
    expires_at = now_utc() + timedelta(seconds=60)
    payload = {
        "sub": user_id,
        "exp": expires_at,
        "type": "ws",
        "jti": jti,
    }
    if session_id:
        payload["sid"] = session_id
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)
    return token, jti, expires_at


async def persist_user_session(
    user: dict,
    request: Request,
    *,
    session_id: str,
    token_jti: str,
    expires_at: datetime,
) -> None:
    meta = request_client_meta(request)
    now_iso = now_utc().isoformat()
    await db.user_sessions.update_one(
        {"id": session_id},
        {
            "$set": {
                "id": session_id,
                "user_id": user["id"],
                "email": user.get("email"),
                "token_jti": token_jti,
                "device_label": meta["device_label"],
                "user_agent": meta["user_agent"],
                "ip_hash": meta["ip_hash"],
                "created_at": now_iso,
                "last_seen_at": now_iso,
                "expires_at": expires_at,
                "revoked_at": None,
                "revoked_reason": None,
            }
        },
        upsert=True,
    )


async def revoke_access_token_jti(jti: Optional[str], user_id: str, expires_at: Optional[datetime]) -> None:
    if not jti or not expires_at:
        return
    await db.revoked_tokens.update_one(
        {"jti": jti},
        {
            "$set": {
                "jti": jti,
                "user_id": user_id,
                "expires_at": expires_at,
            }
        },
        upsert=True,
    )


async def revoke_user_session(session_id: str, user_id: str, *, reason: str) -> bool:
    session = await db.user_sessions.find_one({"id": session_id, "user_id": user_id}, {"_id": 0})
    if not session:
        return False
    now_iso = now_utc().isoformat()
    await db.user_sessions.update_one(
        {"id": session_id, "user_id": user_id},
        {
            "$set": {
                "revoked_at": now_iso,
                "revoked_reason": reason[:80],
                "last_seen_at": now_iso,
            }
        },
    )
    expires_at = session.get("expires_at")
    if isinstance(expires_at, str):
        try:
            expires_at = datetime.fromisoformat(expires_at)
        except ValueError:
            expires_at = None
    expires_at = ensure_utc(expires_at)
    await revoke_access_token_jti(session.get("token_jti"), user_id, expires_at)
    return True


def public_session(doc: dict, current_session_id: Optional[str]) -> dict:
    return {
        "id": doc["id"],
        "current": doc["id"] == current_session_id,
        "device_label": doc.get("device_label") or "Unknown device",
        "created_at": doc.get("created_at"),
        "last_seen_at": doc.get("last_seen_at"),
        "expires_at": doc.get("expires_at").isoformat() if isinstance(doc.get("expires_at"), datetime) else doc.get("expires_at"),
        "revoked_at": doc.get("revoked_at"),
        "revoked_reason": doc.get("revoked_reason"),
    }


async def get_current_user(request: Request) -> dict:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = auth[7:]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    jti = payload.get("jti")
    session_id = payload.get("sid")
    if jti and await db.revoked_tokens.find_one({"jti": jti}, {"_id": 1}):
        raise HTTPException(status_code=401, detail="Token revoked")
    if session_id:
        session = await db.user_sessions.find_one(
            {"id": session_id, "user_id": payload["sub"]},
            {"_id": 0, "revoked_at": 1, "expires_at": 1},
        )
        if not session:
            raise HTTPException(status_code=401, detail="Session not found")
        if session.get("revoked_at"):
            raise HTTPException(status_code=401, detail="Session revoked")
        expires_at = ensure_utc(session.get("expires_at"))
        if isinstance(expires_at, datetime) and expires_at <= now_utc():
            raise HTTPException(status_code=401, detail="Session expired")
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    user["_auth_jti"] = jti
    user["_auth_sid"] = session_id
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user
