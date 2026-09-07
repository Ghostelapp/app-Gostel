from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

import os
import uuid
import logging
import base64
import binascii
import hashlib
import subprocess
import psutil
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Literal

import asyncio
import json
import httpx
import bcrypt
import jwt
import pyotp
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, WebSocket, WebSocketDisconnect, status, Body, Response
from fastapi.responses import FileResponse
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from pydantic import BaseModel, Field, EmailStr, ValidationError

# ----------------- Setup -----------------
mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

app = FastAPI(title="ghostel.app Enterprise API")
api = APIRouter(prefix="/api")

from app.routes import auth as auth_routes
from app.routes import users as users_routes
from app.routes import contacts as contacts_routes
from app.routes import conversations as conversations_routes
from app.routes import admin as admin_routes
from app.routes import uploads as uploads_routes
from app.routes import push as push_routes
from app.routes import support as support_routes
from app.routes import root as root_routes
from app.services import calls as calls_routes
from app.services import websocket as websocket_routes

api.include_router(auth_routes.router)
api.include_router(users_routes.router)
api.include_router(contacts_routes.router)
api.include_router(conversations_routes.router)
api.include_router(admin_routes.router)
api.include_router(uploads_routes.router)
api.include_router(push_routes.router)
api.include_router(support_routes.router)
api.include_router(root_routes.router)
api.include_router(calls_routes.router)
api.include_router(websocket_routes.router)

JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALG = "HS256"
APP_NAME = os.environ.get("APP_NAME", "ghostel.app")
ALLOW_LEGACY_WS_TOKEN = os.environ.get("ALLOW_LEGACY_WS_TOKEN", "false").lower() == "true"
REMOVED_ASSISTANT_USER_ID = "ghost-ai-bot"
MAX_ENCRYPTED_ATTACHMENT_SIZE = int(
    os.environ.get("MAX_ENCRYPTED_ATTACHMENT_SIZE", str(10 * 1024 * 1024))
)
VOICE_MESSAGE_MAX_DURATION_MS = int(os.environ.get("VOICE_MESSAGE_MAX_DURATION_MS", "60000"))
SUPPORTED_VOICE_ATTACHMENT_MIME_TYPES = {
    "audio/aac",
    "audio/m4a",
    "audio/mp4",
    "audio/ogg",
    "audio/opus",
    "audio/webm",
    "audio/x-m4a",
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ghostel")

# ----------------- Helpers -----------------
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


def request_client_meta(request: Request) -> dict:
    user_agent = (request.headers.get("user-agent") or "").strip()
    forwarded = request.headers.get("x-device-name") or request.headers.get("x-device-id") or ""
    device_label = (forwarded or user_agent or "Unknown device").strip()[:160]
    return {
        "ip_hash": hashlib.sha256(client_ip(request).encode("utf-8")).hexdigest(),
        "user_agent": user_agent[:500],
        "device_label": device_label,
    }


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


def user_has_push_token(u: dict) -> bool:
    return bool(u.get("push_tokens") or u.get("push_token") or u.get("expo_push_token"))


def normalize_push_device_id(value: Optional[str]) -> str:
    return (value or "").strip()[:80]


def user_push_targets(u: dict) -> list[dict]:
    """Return registered push targets.

    Modern clients store all transports in ``push_tokens``. Legacy single-token
    fields are only a fallback for accounts that have no modern registrations;
    mixing both paths for calls can deliver duplicate incoming-call alerts.
    """
    targets: list[dict] = []
    seen: set[str] = set()
    for entry in u.get("push_tokens") or []:
        if not isinstance(entry, dict):
            continue
        token = (entry.get("token") or "").strip()
        if not token or token in seen:
            continue
        seen.add(token)
        targets.append(
            {
                "token": token,
                "token_type": (entry.get("token_type") or "fcm").strip().lower(),
                "platform": entry.get("platform") or "unknown",
                "device_id": normalize_push_device_id(entry.get("device_id")),
                "session_id": (entry.get("session_id") or "").strip(),
                "device_model": entry.get("device_model") or "",
                "os_version": entry.get("os_version") or "",
                "source": entry.get("source") or "",
                "registered_at": entry.get("registered_at") or "",
            }
        )
    legacy = (u.get("push_token") or u.get("expo_push_token") or "").strip()
    if not targets and legacy and legacy not in seen:
        targets.append(
            {
                "token": legacy,
                "token_type": (u.get("push_token_type") or "fcm").strip().lower(),
                "platform": u.get("push_platform") or "unknown",
                "device_id": "",
                "session_id": "",
                "device_model": "",
                "os_version": "",
                "source": "legacy",
                "registered_at": "",
            }
        )
    return targets


def compact_push_targets(targets: list[dict]) -> list[dict]:
    """Keep one latest token per user/device/type delivery lane.

    A single install can register multiple times over app upgrades. Sending to
    every historical token is what produces duplicate ringing for one incoming
    call, so call pushes use the newest entry for each device/token type.
    """
    compacted: dict[tuple[str, str, str], dict] = {}
    token_seen: set[str] = set()
    for target in targets:
        token = (target.get("token") or "").strip()
        if not token or token in token_seen:
            continue
        token_seen.add(token)
        user_id = (target.get("user_id") or "").strip()
        device_id = normalize_push_device_id(target.get("device_id"))
        token_type = (target.get("token_type") or "fcm").strip().lower()
        key = (user_id, device_id or token, token_type)
        current = compacted.get(key)
        if not current or (target.get("registered_at") or "") >= (current.get("registered_at") or ""):
            compacted[key] = target
    return list(compacted.values())


def push_target_install_key(target: dict) -> str:
    """Stable key for one app install across multiple push transports."""
    user_id = (target.get("user_id") or "").strip()
    device_id = normalize_push_device_id(target.get("device_id"))
    if device_id:
        return f"{user_id}:device:{device_id}"
    token = (target.get("token") or "").strip()
    return f"{user_id}:token:{token}"


async def sync_user_push_legacy_fields(user_id: str) -> None:
    # Legacy mirror fields caused duplicate call delivery when a user also had
    # modern ``push_tokens``. Keep reading legacy fields for old accounts, but
    # never recreate them for clients that register through /push/register.
    await db.users.update_one(
        {"id": user_id},
        {
            "$unset": {
                "expo_push_token": "",
                "push_platform": "",
                "push_token": "",
                "push_token_type": "",
            }
        },
    )


async def remove_push_token_from_users(
    token: str,
    user_id: Optional[str] = None,
    *,
    sync_legacy: bool = True,
) -> int:
    """Remove one physical device token from one account or from every account."""
    token = (token or "").strip()
    if not token:
        return 0
    affected_ids: set[str] = set()
    async for entry in db.users.find(
        {
            **({"id": user_id} if user_id else {}),
            "$or": [
                {"push_tokens.token": token},
                {"push_token": token},
                {"expo_push_token": token},
            ],
        },
        {"_id": 0, "id": 1},
    ):
        if entry.get("id"):
            affected_ids.add(entry["id"])
    user_filter = {"id": user_id} if user_id else {}
    await db.users.update_many(
        {**user_filter, "push_tokens.token": token},
        {"$pull": {"push_tokens": {"token": token}}},
    )
    await db.users.update_many(
        {
            **user_filter,
            "$or": [
                {"push_token": token},
                {"expo_push_token": token},
            ],
        },
        {
            "$unset": {
                "expo_push_token": "",
                "push_platform": "",
                "push_token": "",
                "push_token_type": "",
            }
        },
    )
    if sync_legacy:
        for affected_id in affected_ids:
            await sync_user_push_legacy_fields(affected_id)
    return len(affected_ids)


async def remove_push_device_from_users(device_id: str, user_id: Optional[str] = None) -> int:
    device_id = normalize_push_device_id(device_id)
    if not device_id:
        return 0
    affected_ids: set[str] = set()
    async for entry in db.users.find(
        {
            **({"id": user_id} if user_id else {}),
            "push_tokens.device_id": device_id,
        },
        {"_id": 0, "id": 1},
    ):
        if entry.get("id"):
            affected_ids.add(entry["id"])
    await db.users.update_many(
        {
            **({"id": user_id} if user_id else {}),
            "push_tokens.device_id": device_id,
        },
        {"$pull": {"push_tokens": {"device_id": device_id}}},
    )
    for affected_id in affected_ids:
        await sync_user_push_legacy_fields(affected_id)
    return len(affected_ids)


async def remove_push_device_from_other_users(device_id: str, user_id: str) -> int:
    """Move one physical phone to the current account without deleting its
    other transports from the same account.

    iOS registers multiple transports for the same install (PushKit VoIP, FCM
    and Expo fallback). Removing the whole device on every /push/register call
    made the last transport delete the previous ones, which broke VoIP/CallKit.
    """
    device_id = normalize_push_device_id(device_id)
    if not device_id:
        return 0
    affected_ids: set[str] = set()
    async for entry in db.users.find(
        {
            "id": {"$ne": user_id},
            "push_tokens.device_id": device_id,
        },
        {"_id": 0, "id": 1},
    ):
        if entry.get("id"):
            affected_ids.add(entry["id"])
    await db.users.update_many(
        {
            "id": {"$ne": user_id},
            "push_tokens.device_id": device_id,
        },
        {"$pull": {"push_tokens": {"device_id": device_id}}},
    )
    for affected_id in affected_ids:
        await sync_user_push_legacy_fields(affected_id)
    return len(affected_ids)


async def remove_push_tokens_for_session(user_id: str, session_id: Optional[str]) -> int:
    session_id = (session_id or "").strip()
    if not session_id:
        return 0
    user = await db.users.find_one(
        {"id": user_id},
        {"_id": 0, "push_tokens": 1},
    )
    if not user:
        return 0
    removed = len(
        [
            entry
            for entry in (user.get("push_tokens") or [])
            if isinstance(entry, dict) and (entry.get("session_id") or "").strip() == session_id
        ]
    )
    if removed == 0:
        return 0
    await db.users.update_one(
        {"id": user_id},
        {"$pull": {"push_tokens": {"session_id": session_id}}},
    )
    await sync_user_push_legacy_fields(user_id)
    return removed


def public_user(u: dict) -> dict:
    return {
        "id": u["id"],
        "email": u["email"],
        "username": u.get("username", ""),
        "name": u.get("name", ""),
        "title": u.get("title", ""),
        "bio": u.get("bio", ""),
        "status": u.get("status", "online"),
        "role": u.get("role", "user"),
        "two_factor_enabled": bool(u.get("two_factor_enabled", False)),
        "avatar_color": u.get("avatar_color", "#00d9ff"),
        "avatar": u.get("avatar") or None,  # base64 data URI (optional)
        "created_at": u.get("created_at"),
        "last_seen": u.get("last_seen"),
        "last_active": u.get("last_active") or u.get("last_seen"),
        "push_registered": user_has_push_token(u),
        "e2ee_public_key": u.get("e2ee_public_key") or None,
        "e2ee_key_updated_at": u.get("e2ee_key_updated_at") or None,
    }


from app.core.utils import _USERNAME_RE


def normalize_username(s: str) -> str:
    s = (s or "").strip().lower().lstrip("@")
    s = _re.sub(r"[^a-z0-9_]", "", s)
    return s


async def is_username_taken(username: str, exclude_user_id: Optional[str] = None) -> bool:
    q: dict = {"username": username}
    if exclude_user_id:
        q["id"] = {"$ne": exclude_user_id}
    return (await db.users.find_one(q, {"_id": 0, "id": 1})) is not None


async def generate_unique_username(seed: str) -> str:
    base = normalize_username(seed.split("@")[0] if "@" in seed else seed)
    if len(base) < 3:
        base = (base + "user")[:20]
    cand = base[:20]
    n = 0
    while await is_username_taken(cand):
        n += 1
        suffix = str(n)
        cand = (base[: 20 - len(suffix)] + suffix)
    return cand


async def ensure_not_blocked_between(
    user: dict, target_id: str, *, action: str = "interact with"
) -> None:
    """Reject direct interactions when either side has blocked the other."""
    if target_id == user["id"]:
        return
    if target_id in (user.get("blocked_user_ids") or []):
        raise HTTPException(
            status_code=403,
            detail=f"You blocked this user and cannot {action} them.",
        )
    other = await db.users.find_one(
        {"id": target_id}, {"_id": 0, "id": 1, "blocked_user_ids": 1}
    )
    if other and user["id"] in (other.get("blocked_user_ids") or []):
        raise HTTPException(
            status_code=403,
            detail=f"This user is unavailable; you cannot {action} them.",
        )


async def ensure_direct_conversation_not_blocked(
    conv: dict, user: dict, *, action: str
) -> None:
    if conv.get("type") != "direct":
        return
    other_id = next((m for m in (conv.get("member_ids") or []) if m != user["id"]), None)
    if other_id:
        await ensure_not_blocked_between(user, other_id, action=action)


async def require_conversation_e2ee_ready(conv: dict, *, action: str) -> list[dict]:
    member_ids = list(conv.get("member_ids") or [])
    if len(member_ids) < 2:
        raise HTTPException(status_code=400, detail="At least 2 members required")
    members = await db.users.find(
        {"id": {"$in": member_ids}},
        {"_id": 0, "id": 1, "name": 1, "username": 1, "e2ee_public_key": 1},
    ).to_list(1000)
    by_id = {m.get("id"): m for m in members}
    missing = [
        by_id.get(member_id, {}).get("name")
        or by_id.get(member_id, {}).get("username")
        or member_id
        for member_id in member_ids
        if not by_id.get(member_id, {}).get("e2ee_public_key")
    ]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"{action} require E2EE device keys for all participants. Waiting for: {', '.join(missing)}",
        )
    return members


async def conversation_e2ee_ready(conv_id: str, user_id: str, target_id: str) -> bool:
    conv = await db.conversations.find_one(
        {"id": conv_id, "member_ids": {"$all": [user_id, target_id]}},
        {"_id": 0, "id": 1, "member_ids": 1},
    )
    if not conv:
        return False
    try:
        await require_conversation_e2ee_ready(conv, action="Calls")
        return True
    except HTTPException:
        return False


async def user_can_signal_target(user_id: str, target_id: str, data: dict) -> bool:
    if not target_id or target_id == user_id:
        return False

    call_id = data.get("call_id")
    if call_id:
        call = await db.calls.find_one(
            {"id": call_id, "member_ids": {"$all": [user_id, target_id]}},
            {"_id": 0, "id": 1, "conversation_id": 1, "e2ee_required": 1},
        )
        if call:
            if not call.get("e2ee_required"):
                return False
            if call.get("conversation_id") and not await conversation_e2ee_ready(call["conversation_id"], user_id, target_id):
                return False
            user = await db.users.find_one({"id": user_id}, {"_id": 0})
            if not user:
                return False
            try:
                await ensure_not_blocked_between(user, target_id, action="call")
            except HTTPException:
                return False
            return True

    conv_id = data.get("conversation_id")
    if conv_id:
        conv = await db.conversations.find_one(
            {"id": conv_id, "member_ids": {"$all": [user_id, target_id]}},
            {"_id": 0, "id": 1, "type": 1, "member_ids": 1},
        )
        if conv:
            if not await conversation_e2ee_ready(conv_id, user_id, target_id):
                return False
            user = await db.users.find_one({"id": user_id}, {"_id": 0})
            if not user:
                return False
            try:
                await ensure_not_blocked_between(user, target_id, action="call")
            except HTTPException:
                return False
            return True

    return False


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


# ----------------- Models -----------------
class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(min_length=1, max_length=80)
    title: Optional[str] = ""
    username: Optional[str] = None


class LoginIn(BaseModel):
    email: Optional[str] = None
    identifier: Optional[str] = None
    password: str
    totp_code: Optional[str] = None


class TwoFAVerifyIn(BaseModel):
    code: str


class TwoFASetupIn(BaseModel):
    password: str = Field(min_length=1, max_length=128)


class StatusUpdateIn(BaseModel):
    status: Literal["online", "busy", "away", "offline"]
    custom_status: Optional[str] = ""


class ProfileUpdateIn(BaseModel):
    name: Optional[str] = None
    title: Optional[str] = None
    bio: Optional[str] = None
    username: Optional[str] = None


class AvatarUpdateIn(BaseModel):
    avatar: Optional[str] = None  # base64 data URI, set None/empty to remove. Max ~250KB.


class ContactInviteIn(BaseModel):
    username: str = Field(min_length=1, max_length=30)


class ConversationCreateIn(BaseModel):
    type: Literal["direct", "group"]
    member_ids: List[str]
    name: Optional[str] = None
    avatar: Optional[str] = None  # base64 data URI (small, <128KB)


class ConversationUpdateIn(BaseModel):
    name: Optional[str] = None
    avatar: Optional[str] = None  # base64 data URI; set "" to clear


class GroupMembersIn(BaseModel):
    member_ids: List[str] = Field(min_length=1, max_length=20)


class E2EERecipientPayload(BaseModel):
    nonce: str = Field(min_length=16, max_length=128)
    ciphertext: str = Field(min_length=16, max_length=20000)


class E2EEMessagePayload(BaseModel):
    version: Literal[1] = 1
    algorithm: Literal["nacl-box-v1"] = "nacl-box-v1"
    sender_public_key: str = Field(min_length=32, max_length=128)
    recipients: Dict[str, E2EERecipientPayload] = Field(default_factory=dict)


class E2EEAttachmentPayload(BaseModel):
    version: Literal[1] = 1
    algorithm: Literal["nacl-secretbox-v1"] = "nacl-secretbox-v1"
    nonce: str = Field(min_length=16, max_length=128)
    mime: str = Field(min_length=1, max_length=120)
    size: Optional[int] = Field(default=None, ge=0, le=MAX_ENCRYPTED_ATTACHMENT_SIZE)
    key_recipients: Dict[str, E2EERecipientPayload] = Field(default_factory=dict)


class E2EEKeyIn(BaseModel):
    public_key: str = Field(min_length=32, max_length=128)
    algorithm: Literal["nacl-box-v1"] = "nacl-box-v1"


class MessageSendIn(BaseModel):
    conversation_id: str
    content: str = Field(min_length=0, max_length=10000, default="")
    kind: Literal["text", "voice", "file", "image", "system"] = "text"
    reply_to: Optional[str] = None
    attachment_id: Optional[str] = None
    duration_ms: Optional[int] = None  # for voice
    encrypted: bool = False
    e2ee: Optional[E2EEMessagePayload] = None
    e2ee_attachment: Optional[E2EEAttachmentPayload] = None
    one_time_seconds: Optional[Literal[5]] = None


class ReactionIn(BaseModel):
    emoji: str = Field(min_length=1, max_length=8)


class UploadIn(BaseModel):
    filename: str = Field(min_length=1, max_length=200)
    mime: str = Field(min_length=1, max_length=120)
    data: str = Field(min_length=1)  # base64 string (no data: prefix)
    size: int = Field(ge=0, le=MAX_ENCRYPTED_ATTACHMENT_SIZE)


class PushTokenIn(BaseModel):
    token: str = Field(min_length=4, max_length=500)
    platform: Literal["ios", "android", "web"] = "web"
    # Accepts both raw Expo-style names ('android'/'ios') and explicit names
    # ('fcm'/'apns'). 'expo' kept for legacy ExpoPushToken[...] tokens.
    token_type: Literal["fcm", "apns", "expo", "voip", "android", "ios"] = "fcm"
    device_id: Optional[str] = Field(default=None, min_length=8, max_length=80)
    device_model: Optional[str] = None
    os_version: Optional[str] = None
    source: Optional[str] = None


class PushUnregisterIn(BaseModel):
    token: Optional[str] = Field(default=None, min_length=4, max_length=500)
    device_id: Optional[str] = Field(default=None, min_length=8, max_length=80)


class SupportReportIn(BaseModel):
    category: Literal["call", "push", "device", "account", "bug", "other"] = "bug"
    subject: str = Field(min_length=4, max_length=160)
    message: str = Field(min_length=10, max_length=5000)
    platform: Literal["ios", "android", "web", "desktop", "unknown"] = "unknown"
    app_version: Optional[str] = Field(default="", max_length=40)
    diagnostics: Optional[dict] = None


class CallStartIn(BaseModel):
    conversation_id: str
    mode: Literal["audio", "video"] = "audio"
    call_id: Optional[str] = Field(default=None, min_length=8, max_length=80)


class CallStateUpdateIn(BaseModel):
    status: Optional[Literal["connecting", "active", "reconnecting", "failed"]] = None
    peer_connection_state: Optional[str] = Field(default=None, max_length=40)
    local_audio_enabled: Optional[bool] = None
    remote_audio_connected: Optional[bool] = None


class DisappearingIn(BaseModel):
    seconds: Optional[int] = Field(default=None, ge=0, le=60 * 60 * 24 * 30)  # max 30 days


class PrivacyUpdateIn(BaseModel):
    save_call_history: Optional[bool] = None


class MuteUpdateIn(BaseModel):
    muted: bool


# ----------------- Auth Routes -----------------














# ----------------- E2EE key registry -----------------










# ----------------- Users / Profile -----------------












async def delete_user_account_data(user_id: str) -> bool:
    """Delete a user account and remove or anonymize related personal data."""
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        return False

    now = now_utc().isoformat()
    email = user.get("email")

    conv_docs = await db.conversations.find(
        {"member_ids": user_id}, {"_id": 0, "id": 1, "member_ids": 1}
    ).to_list(5000)
    conv_ids = [c["id"] for c in conv_docs if c.get("id")]

    await db.contact_invitations.delete_many(
        {"$or": [{"from_user_id": user_id}, {"to_user_id": user_id}]}
    )
    await db.users.update_many(
        {},
        {
            "$pull": {
                "contact_ids": user_id,
                "blocked_user_ids": user_id,
            },
            "$unset": {f"muted_users.{user_id}": ""},
        },
    )
    await db.conversations.update_many(
        {"member_ids": user_id},
        {"$pull": {"member_ids": user_id, "admin_ids": user_id}},
    )

    if conv_ids:
        empty_docs = await db.conversations.find(
            {"id": {"$in": conv_ids}, "member_ids": {"$size": 0}},
            {"_id": 0, "id": 1},
        ).to_list(5000)
        empty_conv_ids = [c["id"] for c in empty_docs if c.get("id")]
        if empty_conv_ids:
            await db.messages.delete_many({"conversation_id": {"$in": empty_conv_ids}})
            await db.conversations.delete_many({"id": {"$in": empty_conv_ids}})

    await db.messages.update_many(
        {"sender_id": user_id},
        {
            "$set": {
                "sender_id": "deleted-user",
                "sender_name": "Deleted account",
                "content": "",
                "deleted": True,
                "deleted_at": now,
            },
            "$unset": {
                "attachment_id": "",
                "e2ee": "",
                "e2ee_attachment": "",
                "reply_to": "",
            },
        },
    )

    async for msg in db.messages.find(
        {"reactions": {"$exists": True}}, {"_id": 0, "id": 1, "reactions": 1}
    ):
        reactions = msg.get("reactions") or {}
        if not isinstance(reactions, dict):
            continue
        changed = False
        cleaned: dict = {}
        for emoji, ids in reactions.items():
            if not isinstance(ids, list):
                cleaned[emoji] = ids
                continue
            next_ids = [uid for uid in ids if uid != user_id]
            if len(next_ids) != len(ids):
                changed = True
            if next_ids:
                cleaned[emoji] = next_ids
        if changed and msg.get("id"):
            await db.messages.update_one(
                {"id": msg["id"]}, {"$set": {"reactions": cleaned}}
            )

    await db.attachments.delete_many({"owner_id": user_id})
    await db.calls.delete_many(
        {
            "$or": [
                {"member_ids": user_id},
                {"caller_id": user_id},
                {"callee_ids": user_id},
            ]
        }
    )
    if email:
        await db.login_attempts.delete_many({"identifier": email.lower()})
    await db.users.delete_one({"id": user_id})
    return True




# ----------------- Contacts -----------------
def _public_invitation(inv: dict, users_by_id: dict) -> dict:
    fu = users_by_id.get(inv["from_user_id"])
    tu = users_by_id.get(inv["to_user_id"])
    return {
        "id": inv["id"],
        "from_user": public_user(fu) if fu else None,
        "to_user": public_user(tu) if tu else None,
        "status": inv.get("status", "pending"),
        "created_at": inv.get("created_at"),
        "responded_at": inv.get("responded_at"),
    }








async def _send_invite_push(target: dict, sender: dict):
    """Push notification for incoming contact invitation. Uses Direct FCM."""
    try:
        token = target.get("push_token") or target.get("expo_push_token")
        if not token:
            return
        token_type = target.get("push_token_type") or "fcm"
        sender_name = sender.get("name") or "@" + (sender.get("username") or "Someone")
        await _send_simple_push(
            token=token,
            token_type=token_type,
            title="👥 New contact request",
            body=f"{sender_name} wants to connect",
            channel="notifications",
            sound="notification",
            data={
                "type": "contact_invite",
                "from_user_id": sender.get("id", ""),
                "screen": "contacts",
            },
            ttl_seconds=3600,
        )
    except Exception as e:
        logger.warning(f"Invite push failed: {e}")


async def _send_simple_push(
    *,
    token: str,
    token_type: str = "fcm",
    title: str,
    body: str,
    channel: str = "notifications",
    sound: str = "notification",
    data: dict | None = None,
    ttl_seconds: int = 0,
    priority: str = "high",
    is_call: bool = False,
):
    """Lightweight push helper for non-message notifications (invites, group
    adds, system events). Uses direct FCM if token_type is fcm/apns; legacy
    Expo otherwise."""
    if not token:
        return
    if token_type in ("fcm", "apns"):
        from fcm import is_configured as fcm_is_configured, send_fcm

        if not fcm_is_configured():
            logger.warning("Simple push skipped — FCM not configured")
            return
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                res = await send_fcm(
                    client,
                    token=token,
                    title=title,
                    body=body,
                    channel_id=channel,
                    sound=sound,
                    priority=priority,
                    ttl_seconds=ttl_seconds,
                    data=data or {},
                    is_call=is_call,
                )
                if not res.get("ok"):
                    err = res.get("fcm_error_code") or res.get("error", "unknown")
                    logger.warning(f"Simple push failed: {err}")
                    if err in ("UNREGISTERED", "INVALID_ARGUMENT", "NOT_FOUND"):
                        await db.users.update_many(
                            {"push_token": token},
                            {"$unset": {"push_token": "", "push_token_type": "", "push_platform": "", "expo_push_token": ""}},
                        )
        except Exception as e:
            logger.warning(f"Simple push send error: {e}")
    else:
        # Legacy Expo token fallback
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    "https://exp.host/--/api/v2/push/send",
                    json={
                        "to": token,
                        "title": title,
                        "body": body,
                        "data": data or {},
                        "sound": expo_push_sound_name(sound),
                        "channelId": channel,
                        "priority": priority,
                        "ttl": ttl_seconds,
                    },
                )
        except Exception as e:
            logger.warning(f"Legacy Expo push failed: {e}")


async def _send_push_to_user(
    user_id: str,
    *,
    title: str,
    body: str,
    channel: str = "notifications",
    sound: str = "notification",
    data: dict | None = None,
    ttl_seconds: int = 0,
):
    """Convenience wrapper — load token by user_id and send."""
    try:
        u = await db.users.find_one(
            {"id": user_id},
            {"_id": 0, "id": 1, "push_token": 1, "expo_push_token": 1, "push_token_type": 1},
        )
        if not u:
            return
        token = u.get("push_token") or u.get("expo_push_token")
        if not token:
            return
        await _send_simple_push(
            token=token,
            token_type=u.get("push_token_type") or "fcm",
            title=title,
            body=body,
            channel=channel,
            sound=sound,
            data=data,
            ttl_seconds=ttl_seconds,
        )
    except Exception as e:
        logger.warning(f"_send_push_to_user failed: {e}")












# ----------------- Conversations -----------------
async def _hydrate_conversation(conv: dict, current_user_id: str) -> dict:
    member_docs = await db.users.find(
        {"id": {"$in": conv["member_ids"]}}, {"_id": 0}
    ).to_list(1000)
    members = [public_user(m) for m in member_docs]
    last_msg = await db.messages.find_one(
        {"conversation_id": conv["id"]},
        {"_id": 0},
        sort=[("created_at", -1)],
    )
    unread = await db.messages.count_documents({
        "conversation_id": conv["id"],
        "sender_id": {"$ne": current_user_id},
        "read_by": {"$ne": current_user_id},
    })

    title = conv.get("name") or ""
    if conv["type"] == "direct":
        other = next((m for m in members if m["id"] != current_user_id), None)
        title = other["name"] if other else "Direct"
    e2ee_ready = len(members) >= 2 and all(m.get("e2ee_public_key") for m in members)

    return {
        "id": conv["id"],
        "type": conv["type"],
        "name": title,
        "members": members,
        "created_by": conv.get("created_by"),
        "created_at": conv.get("created_at"),
        "last_message": last_msg,
        "unread_count": unread,
        "encrypted": e2ee_ready,
        "e2ee_ready": e2ee_ready,
        "disappear_seconds": conv.get("disappear_seconds"),
        "admin_ids": conv.get("admin_ids") or (
            [conv["created_by"]] if conv["type"] == "group" and conv.get("created_by") else []
        ),
        "avatar": conv.get("avatar"),
    }




async def _require_group_admin(conv_id: str, user_id: str) -> dict:
    conv = await db.conversations.find_one(
        {"id": conv_id, "member_ids": user_id, "type": "group"}, {"_id": 0}
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Group not found")
    admin_ids = conv.get("admin_ids") or ([conv.get("created_by")] if conv.get("created_by") else [])
    if user_id not in admin_ids:
        raise HTTPException(status_code=403, detail="Group admin permission required")
    return conv


















def _human_duration(s: int) -> str:
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60} min"
    if s < 86400:
        return f"{s // 3600} h"
    return f"{s // 86400} d"


# ----------------- Messages -----------------
def _normalize_message_dates(msg: dict) -> dict:
    """Ensure datetime fields are serialized with explicit UTC offset so JS
    parses them correctly. Mongo returns naive datetimes (UTC), which FastAPI
    would otherwise emit without timezone info."""
    for key in ("expires_at", "created_at"):
        val = msg.get(key)
        if isinstance(val, datetime):
            if val.tzinfo is None:
                val = val.replace(tzinfo=timezone.utc)
            msg[key] = val.isoformat()
    return msg
















# ----------------- User mute (per-user notification mute) -----------------
class MuteUserIn(BaseModel):
    # Duration in seconds (max 30 days). `None` or 0 means "forever".
    duration_seconds: Optional[int] = None










# ----------------- Admin -----------------
def admin_user(u: dict) -> dict:
    return {
        **public_user(u),
        "last_seen": u.get("last_seen"),
        "push_registered": user_has_push_token(u),
    }


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


class RoleUpdateIn(BaseModel):
    role: Literal["admin", "moderator", "user", "guest"]


def _parse_admin_chart_datetime(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return ensure_utc(value)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return ensure_utc(parsed)
        except Exception:
            return None
    return None


def _admin_chart_days(days_count: int = 14):
    now = now_utc()
    days = []
    for offset in range(days_count - 1, -1, -1):
        day = now - timedelta(days=offset)
        start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        days.append((day.strftime("%d.%m"), start.strftime("%Y-%m-%d"), start, end))
    return days


def _admin_bucket_chart(rows: list[dict], field: str, value_key: str = "count", days_count: int = 14) -> list[dict]:
    days = _admin_chart_days(days_count)
    counts_by_day = {key: 0 for _, key, _, _ in days}
    for row in rows:
        dt = _parse_admin_chart_datetime(row.get(field))
        if not dt:
            continue
        for _, key, start, end in days:
            if start <= dt < end:
                counts_by_day[key] += 1
                break
    return [{"day": label, value_key: counts_by_day[key]} for label, key, _, _ in days]


async def _admin_collection_date_chart(collection, field: str, value_key: str = "count", days_count: int = 14) -> list[dict]:
    days = _admin_chart_days(days_count)
    start_dt = days[0][2]
    try:
        rows = await collection.aggregate(
            [
                {
                    "$project": {
                        "_chart_dt": {
                            "$cond": [
                                {"$eq": [{"$type": f"${field}"}, "date"]},
                                f"${field}",
                                {
                                    "$dateFromString": {
                                        "dateString": f"${field}",
                                        "onError": None,
                                        "onNull": None,
                                    }
                                },
                            ]
                        }
                    }
                },
                {"$match": {"_chart_dt": {"$gte": start_dt}}},
                {
                    "$group": {
                        "_id": {
                            "$dateToString": {
                                "format": "%Y-%m-%d",
                                "date": "$_chart_dt",
                                "timezone": "UTC",
                            }
                        },
                        "count": {"$sum": 1},
                    }
                },
            ]
        ).to_list(days_count + 5)
        counts_by_key = {row["_id"]: row["count"] for row in rows if row.get("_id")}
        return [{"day": label, value_key: counts_by_key.get(key, 0)} for label, key, _, _ in days]
    except Exception as exc:
        logger.warning(f"admin stats chart fallback for {collection.name}.{field}: {exc}")
        rows = await collection.find({}, {"_id": 0, field: 1}).to_list(50000)
        return _admin_bucket_chart(rows, field, value_key, days_count)


async def _admin_activity_chart(days_count: int = 14) -> list[dict]:
    rows = await db.users.find(
        {},
        {"_id": 0, "last_seen": 1, "last_active": 1},
    ).to_list(50000)
    activity_rows = [
        {"last_active": row.get("last_seen") or row.get("last_active")}
        for row in rows
    ]
    return _admin_bucket_chart(activity_rows, "last_active", "active", days_count)














# ----------------- Uploads (encrypted attachments) -----------------




# ----------------- Push (Direct FCM HTTP v1 — bypasses Expo Push) -----------------
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"  # legacy, retained for /push/test


def expo_push_sound_name(sound: str) -> str:
    """Expo/iOS custom sounds use the bundled file name, including extension."""
    sound = (sound or "default").strip()
    if sound in ("default", "defaultCritical"):
        return sound
    return sound if "." in sound else f"{sound}.wav"


def sanitize_diag_value(value, depth: int = 0):
    """Keep client diagnostics useful while preventing oversized/noisy payloads."""
    if depth > 3:
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:500]
    if isinstance(value, list):
        return [sanitize_diag_value(item, depth + 1) for item in value[:30]]
    if isinstance(value, dict):
        clean = {}
        for key, nested in list(value.items())[:80]:
            if not isinstance(key, str):
                continue
            clean[key[:80]] = sanitize_diag_value(nested, depth + 1)
        return clean
    return str(value)[:200]
















async def _send_push_to_members(member_ids, sender_id, conv, msg):
    """Direct-FCM push delivery (HTTP v1). Falls back to Expo Push for legacy
    'expo' tokens that may exist in DB from previous deployments."""
    try:
        from fcm import is_configured as fcm_is_configured, send_fcm

        targets = [uid for uid in member_ids if uid != sender_id]
        if not targets:
            return
        # Filter out users who blocked the sender or muted this conversation
        # or muted the sender (per-user mute with optional expiry).
        recipients_full = await db.users.find(
            {
                "id": {"$in": targets},
                "$or": [
                    {"push_tokens.0": {"$exists": True}},
                    {"push_token": {"$exists": True, "$ne": None}},
                    {"expo_push_token": {"$exists": True, "$ne": None}},
                ],
            },
            {
                "_id": 0,
                "id": 1,
                "push_tokens": 1,
                "push_token": 1,
                "push_token_type": 1,
                "push_platform": 1,
                "expo_push_token": 1,
                "blocked_user_ids": 1,
                "muted_conversation_ids": 1,
                "muted_users": 1,
            },
        ).to_list(1000)
        conv_id = conv.get("id", "")
        now_iso = now_utc().isoformat()
        recipients = []
        for r in recipients_full:
            blocked = set(r.get("blocked_user_ids") or [])
            muted_convs = set(r.get("muted_conversation_ids") or [])
            muted_users_map = r.get("muted_users") or {}
            if sender_id in blocked:
                continue
            if conv_id and conv_id in muted_convs:
                continue
            user_mute = muted_users_map.get(sender_id)
            if user_mute:
                until = user_mute.get("until") if isinstance(user_mute, dict) else None
                # `until is None` means muted forever.
                if until is None or until > now_iso:
                    continue
            recipients.append(r)
        if not recipients:
            return

        is_call = msg.get("kind") == "call"
        if is_call:
            call_id = str(msg.get("id") or msg.get("call_id") or "")
            call = await db.calls.find_one({"id": call_id}, {"_id": 0})
            status = str((call or {}).get("status") or "").lower()
            expires_at = str((call or {}).get("expires_at") or (call or {}).get("expiresAt") or "")
            if (
                not call
                or status in CALL_TERMINAL_STATUSES
                or status != "ringing"
                or call.get("ended_at")
                or call.get("answered_at")
                or (expires_at and expires_at <= now_iso)
            ):
                logger.info(
                    "SKIP_PUSH_FOR_TERMINAL_CALL_STATE "
                    f"call={call_id[:8]} status={status or 'missing'}"
                )
                return

        title = conv.get("name") or "New message"
        if conv.get("type") == "direct":
            title = msg.get("sender_name", "New message")
        if is_call:
            title = f"📞 {msg.get('sender_name', 'Someone')} is calling"
        body_preview = msg.get("content", "")
        if is_call:
            title = "ghostel.app call"
            body_preview = "Incoming encrypted call"
        elif msg.get("e2ee"):
            body_preview = "Encrypted message"
        elif msg.get("kind") == "voice":
            body_preview = "🎙 Voice message"
        elif msg.get("kind") == "file":
            body_preview = "📎 Attachment"
        elif msg.get("kind") == "image":
            body_preview = "📷 Photo"
        body_preview = (body_preview or "")[:140]

        sound = "ringtone" if is_call else "message"
        channel_id = "calls" if is_call else "messages"
        ttl_sec = 30 if is_call else 0
        call_display_name = (
            msg.get("sender_name")
            or msg.get("caller_name")
            or "Someone"
        )
        call_display_name = str(call_display_name)[:80]
        # NOTE: FCM has a STRICT 4KB limit on the entire `data` dict for a
        # single message. Avatars are stored as base64 PNGs (often 50-100KB)
        # and MUST NOT be inlined here — that would exceed the limit and
        # FCM would reject the whole push with INVALID_ARGUMENT.
        # The native CallKeep screen will render the caller's initials when
        # no avatar is provided, so this is purely a visual fallback.
        common_data = {
            "conversation_id": conv.get("id", ""),
            "message_id": msg.get("id", ""),
            "call_id": msg.get("id", "") if is_call else "",
            "screen": "call" if is_call else "chat",
            "kind": "call" if is_call else str(msg.get("kind") or "message"),
            "push_kind": "call" if is_call else "message",
            # `incoming_call` is what the Android Headless JS handler matches on
            # (src/fcmBackground.ts). Older clients accepted "call" too — both
            # values are honored on the client.
            "type": "incoming_call" if is_call else "message",
            "sender_name": call_display_name if is_call else msg.get("sender_name", ""),
            # Caller-specific fields used by react-native-callkeep to render
            # the native OS-level incoming-call screen on the lockscreen.
            "caller_id": msg.get("caller_id", sender_id) if is_call else "",
            "caller_name": call_display_name if is_call else "",
            "encryptedDisplayName": msg.get("encryptedDisplayName", "") if is_call else "",
            # caller_avatar intentionally omitted — too big for FCM 4KB limit.
            "mode": msg.get("mode", "audio") if is_call else "",
        }

        # Split all registered devices by token type. A user may be logged in
        # on multiple phones, so never rely on the legacy single push_token.
        push_targets: list[dict] = []
        for r in recipients:
            for target in user_push_targets(r):
                push_targets.append({**target, "user_id": r.get("id")})
        push_targets = compact_push_targets(push_targets)
        fcm_recipients = [
            r for r in push_targets if (r.get("token_type") or "fcm") in ("fcm", "apns")
        ]
        expo_recipients = [r for r in push_targets if r.get("token_type") == "expo"]
        voip_recipients = [
            r for r in push_targets if is_call and r.get("token_type") == "voip"
        ]

        # ---- Native iOS PushKit path ----
        # A VoIP push wakes iOS and is reported to CallKit by AppDelegate before
        # React Native starts. This is the only reliable full-screen call path
        # for a locked or terminated iOS app.
        voip_ok = voip_err = 0
        voip_success_users: set[str] = set()
        voip_success_install_keys: set[str] = set()
        voip_success_users_without_device: set[str] = set()
        if voip_recipients:
            from apns import is_configured as apns_is_configured, send_voip_push

            if apns_is_configured():
                async with httpx.AsyncClient(http2=True, timeout=10) as apns_client:
                    for r in voip_recipients:
                        token = r["token"]
                        result = await send_voip_push(
                            apns_client,
                            token=token,
                            data=common_data,
                        )
                        if result.get("ok"):
                            voip_ok += 1
                            if r.get("user_id"):
                                voip_success_users.add(r["user_id"])
                            voip_success_install_keys.add(push_target_install_key(r))
                            if not normalize_push_device_id(r.get("device_id")) and r.get("user_id"):
                                voip_success_users_without_device.add(r["user_id"])
                        else:
                            voip_err += 1
                            reason = result.get("error", "unknown")
                            logger.warning(
                                f"APNs VoIP send failed reason={reason}"
                            )
                            if reason in (
                                "BadDeviceToken",
                                "DeviceTokenNotForTopic",
                                "Unregistered",
                            ):
                                await remove_push_token_from_users(token)
                logger.info(
                    f"APNs VoIP push: {voip_ok} ok / {voip_err} err, call={common_data.get('call_id', '')[:8]}"
                )
            else:
                logger.warning(
                    f"APNs VoIP not configured - skipped {len(voip_recipients)} recipients"
                )

        # ---- Direct FCM path ----
        fcm_ok = fcm_err = 0
        fcm_success_users: set[str] = set()
        fcm_success_install_keys: set[str] = set()
        fcm_success_users_without_device: set[str] = set()
        if fcm_recipients and fcm_is_configured():
            async with httpx.AsyncClient(timeout=10) as client:
                for r in fcm_recipients:
                    platform = str(r.get("platform") or "").lower()
                    if is_call and (
                        push_target_install_key(r) in voip_success_install_keys
                        or (
                            not normalize_push_device_id(r.get("device_id"))
                            and platform == "ios"
                            and r.get("user_id") in voip_success_users_without_device
                        )
                        or (
                            platform in {"", "ios", "unknown"}
                            and r.get("user_id") in voip_success_users
                        )
                    ):
                        continue
                    token = r["token"]
                    result = await send_fcm(
                        client,
                        token=token,
                        title=title,
                        body=body_preview,
                        channel_id=channel_id,
                        sound=sound,
                        priority="high",
                        ttl_seconds=ttl_sec,
                        data=common_data,
                        is_call=is_call,
                    )
                    if result.get("ok"):
                        fcm_ok += 1
                        if r.get("user_id"):
                            fcm_success_users.add(r["user_id"])
                        fcm_success_install_keys.add(push_target_install_key(r))
                        if not normalize_push_device_id(r.get("device_id")) and r.get("user_id"):
                            fcm_success_users_without_device.add(r["user_id"])
                    else:
                        fcm_err += 1
                        err_code = result.get("fcm_error_code") or result.get("error", "unknown")
                        logger.warning(
                            f"FCM send failed err={err_code} msg={result.get('message', '')[:120]}"
                        )
                        # Clean up unregistered tokens
                        if err_code in ("UNREGISTERED", "INVALID_ARGUMENT", "NOT_FOUND"):
                            await db.users.update_many(
                                {"$or": [{"push_token": token}, {"push_tokens.token": token}]},
                                {
                                    "$pull": {"push_tokens": {"token": token}},
                                    "$unset": {
                                        "push_token": "",
                                        "push_token_type": "",
                                        "push_platform": "",
                                        "expo_push_token": "",
                                    },
                                },
                            )
            logger.info(
                f"FCM push: {fcm_ok} ok / {fcm_err} err, conv={conv.get('id', '?')[:8]}, kind={msg.get('kind', 'msg')}"
            )
        elif fcm_recipients and not fcm_is_configured():
            logger.warning(
                f"FCM not configured — skipped {len(fcm_recipients)} recipients"
            )

        # ---- Expo Push fallback ----
        # Each iOS install registers both transports. Use Expo only for users
        # whose direct FCM delivery did not succeed, avoiding duplicate alerts
        # while retaining EAS-managed APNs as an independent fallback.
        delivered_users = fcm_success_users | voip_success_users
        delivered_install_keys = fcm_success_install_keys | voip_success_install_keys
        delivered_users_without_device = (
            fcm_success_users_without_device | voip_success_users_without_device
        )
        expo_fallback_recipients = [
            r for r in expo_recipients
            if push_target_install_key(r) not in delivered_install_keys
            and not (
                not normalize_push_device_id(r.get("device_id"))
                and r.get("user_id") in delivered_users_without_device
            )
            and not (
                is_call
                and str(r.get("platform") or "").lower() in {"", "ios", "unknown"}
                and r.get("user_id") in voip_success_users
            )
        ]
        if expo_fallback_recipients:
            messages_payload = [
                {
                    "to": r["token"],
                    "title": title,
                    "body": body_preview,
                    "sound": expo_push_sound_name(sound),
                    "priority": "high",
                    "channelId": channel_id,
                    "ttl": ttl_sec,
                    "_contentAvailable": is_call,
                    "data": common_data,
                }
                for r in expo_fallback_recipients
            ]
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    resp = await client.post(EXPO_PUSH_URL, json=messages_payload)
                    if resp.status_code >= 400:
                        logger.warning(
                            f"Expo push (legacy) HTTP {resp.status_code}: {resp.text[:300]}"
                        )
                    else:
                        try:
                            payload = resp.json()
                        except Exception:
                            payload = {}
                        tickets = payload.get("data") if isinstance(payload, dict) else None
                        if not isinstance(tickets, list):
                            tickets = []
                        ok_count = sum(1 for ticket in tickets if ticket.get("status") == "ok")
                        err_tickets = [
                            ticket for ticket in tickets if ticket.get("status") != "ok"
                        ]
                        logger.info(
                            f"Expo push fallback: {ok_count} ok / {len(err_tickets)} err"
                        )
                        for ticket in err_tickets[:5]:
                            details = ticket.get("details") or {}
                            logger.warning(
                                "Expo push ticket error: "
                                f"status={ticket.get('status')} "
                                f"message={str(ticket.get('message', ''))[:180]} "
                                f"details={str(details)[:180]}"
                            )
            except Exception as exc:
                logger.warning(f"Expo push (legacy) failed: {exc}")
    except Exception as exc:
        logger.warning(f"_send_push_to_members failed: {exc}")


async def _send_call_control_push(
    call: dict,
    action: str,
    actor_id: str,
    actor_session_id: Optional[str] = None,
) -> None:
    """Wake background devices so native incoming-call UI stops ringing.

    WebSocket remains the primary real-time path while the app is active, but
    locked/background devices can be showing a native call UI without a live WS.
    This silent control payload only carries enough state to cancel ringing or
    clear active-call UI. iOS receives it directly over APNs VoIP when possible;
    FCM remains the Android path and a fallback for registered FCM/APNs tokens.
    """
    try:
        from fcm import is_configured as fcm_is_configured, send_fcm

        fcm_configured = fcm_is_configured()
        if not fcm_configured:
            logger.warning("FCM not configured - FCM call control fallback unavailable")

        member_ids = [member_id for member_id in call.get("member_ids", []) if member_id]
        if not member_ids:
            return

        users = await db.users.find(
            {
                "id": {"$in": member_ids},
                "$or": [
                    {"push_tokens.0": {"$exists": True}},
                    {"push_token": {"$exists": True, "$ne": None}},
                    {"expo_push_token": {"$exists": True, "$ne": None}},
                ],
            },
            {
                "_id": 0,
                "id": 1,
                "push_tokens": 1,
                "push_token": 1,
                "push_token_type": 1,
                "push_platform": 1,
                "expo_push_token": 1,
            },
        ).to_list(1000)

        targets: list[dict] = []
        voip_targets: list[dict] = []
        for user_doc in users:
            for target in user_push_targets(user_doc):
                token_type = (target.get("token_type") or "fcm").lower()
                platform = (target.get("platform") or "").lower()
                if token_type == "voip":
                    voip_targets.append({**target, "user_id": user_doc.get("id")})
                elif token_type in {"fcm", "apns"} and platform != "ios":
                    targets.append({**target, "user_id": user_doc.get("id")})
        targets = compact_push_targets(targets)
        voip_targets = compact_push_targets(voip_targets)
        if action == "accepted":
            # Signal-style split:
            # - call.accepted for the caller is delivered through signaling
            #   (WebSocket + persisted call_signals);
            # - call-control "accepted" is only a native UI cleanup event for
            #   the callee account's other devices. Sending it to the caller's
            #   iOS device can make CallKit emit a local end action and wrongly
            #   terminate an already accepted call.
            targets = [target for target in targets if target.get("user_id") == actor_id]
            voip_targets = [
                target for target in voip_targets if target.get("user_id") == actor_id
            ]
            if actor_session_id:
                targets = [
                    target
                    for target in targets
                    if not (
                        target.get("user_id") == actor_id
                        and (target.get("session_id") or "") == actor_session_id
                    )
                ]
                voip_targets = [
                    target
                    for target in voip_targets
                    if not (
                        target.get("user_id") == actor_id
                        and (target.get("session_id") or "") == actor_session_id
                    )
                ]
        if not targets and not voip_targets:
            return

        data = {
            "type": "call_control",
            "call_control_action": action,
            "call_id": call.get("id", ""),
            "conversation_id": call.get("conversation_id", ""),
            "actor_id": actor_id,
            "accepted_by": actor_id if action == "accepted" else "",
            "ended_by": actor_id if action != "accepted" else "",
            "status": action,
        }

        voip_ok = voip_err = 0
        if voip_targets:
            from apns import is_configured as apns_is_configured, send_voip_push

            if apns_is_configured():
                async with httpx.AsyncClient(http2=True, timeout=10) as apns_client:
                    for target in voip_targets:
                        token = target["token"]
                        result = await send_voip_push(
                            apns_client,
                            token=token,
                            data=data,
                        )
                        if result.get("ok"):
                            voip_ok += 1
                        else:
                            voip_err += 1
                            reason = result.get("error", "unknown")
                            logger.warning(
                                f"APNs VoIP call control failed action={action} reason={reason}"
                            )
                            if reason in (
                                "BadDeviceToken",
                                "DeviceTokenNotForTopic",
                                "Unregistered",
                            ):
                                await remove_push_token_from_users(token)
                logger.info(
                    "APNs VoIP call control "
                    f"action={action} call={str(call.get('id', ''))[:8]} "
                    f"ok={voip_ok} err={voip_err}"
                )
            else:
                logger.warning(
                    f"APNs VoIP not configured - skipped {len(voip_targets)} call control recipients"
                )

        ok = err = 0
        if targets and fcm_configured:
            async with httpx.AsyncClient(timeout=10) as client:
                for target in targets:
                    token = target["token"]
                    result = await send_fcm(
                        client,
                        token=token,
                        title="ghostel.app call",
                        body="",
                        channel_id="calls",
                        sound="default",
                        priority="high",
                        ttl_seconds=30,
                        data=data,
                        data_only=True,
                    )
                    if result.get("ok"):
                        ok += 1
                    else:
                        err += 1
                        err_code = result.get("fcm_error_code") or result.get("error", "unknown")
                        logger.warning(
                            f"Call control push failed action={action} err={err_code}"
                        )
                        if err_code in ("UNREGISTERED", "INVALID_ARGUMENT", "NOT_FOUND"):
                            await remove_push_token_from_users(token)
        elif targets and not fcm_configured:
            logger.warning(f"FCM not configured - skipped {len(targets)} call control recipients")
        logger.info(
            "Call control push "
            f"action={action} call={str(call.get('id', ''))[:8]} "
            f"fcm_ok={ok} fcm_err={err} voip_ok={voip_ok} voip_err={voip_err}"
        )
    except Exception as exc:
        logger.warning(f"_send_call_control_push failed: {exc}")


# ----------------- Calls (signaling + record) -----------------
# ICE servers cache (TTL 50min — Cloudflare creds valid 1h, refresh every 50min)
_ice_cache = {"servers": None, "source": None, "expires_at": 0.0}
import time as _time

CALL_RING_TIMEOUT_SECONDS = 45
CALL_TERMINAL_STATUSES = {
    "declined",
    "cancelled",
    "ended",
    "missed",
    "timeout",
    "failed",
    "rejected",
}
CALL_ACTIVE_STATUSES = {
    "ringing",
    "accepted",
    "answered",
    "connecting",
    "active",
    "reconnecting",
}

CALL_SIGNAL_EVENT_NAMES = {
    "call:offer": "call.offer",
    "call:answer": "call.answer",
    "call:ice": "call.ice_candidate",
    "call:ready": "call.ready",
    "call:accept": "call.accepted",
    "call:reject": "call.declined",
    "call:end": "call.ended",
    "call:cancel": "call.cancelled",
}


def normalize_call_signal_envelope(
    signal: dict,
    *,
    call_id: str,
    sender_id: str,
    receiver_id: str,
) -> dict:
    signal_type = str(signal.get("type") or "")
    created_at = str(signal.get("createdAt") or signal.get("created_at") or now_utc().isoformat())
    platform = str(signal.get("platform") or "unknown")[:40]
    e2ee_signal = signal.get("e2ee_signal")
    encrypted_payload = isinstance(e2ee_signal, dict)
    payload_meta = {
        "encrypted": bool(signal.get("encrypted")) and encrypted_payload,
        "algorithm": e2ee_signal.get("algorithm") if encrypted_payload else None,
        "hasPayload": encrypted_payload,
    }
    normalized = {
        **signal,
        "type": signal_type,
        "event": signal.get("event") or CALL_SIGNAL_EVENT_NAMES.get(signal_type, signal_type.replace(":", ".")),
        "call_id": call_id,
        "callId": call_id,
        "senderId": sender_id,
        "receiverId": receiver_id,
        "platform": platform,
        "payload": payload_meta,
        "created_at": created_at,
        "createdAt": created_at,
    }
    normalized.pop("sdp", None)
    normalized.pop("candidate", None)
    normalized.pop("iceCandidate", None)
    return normalized


def _configured_turn_servers():
    """Return operator-provided TURN servers from environment variables."""
    urls = [
        item.strip()
        for item in os.environ.get("TURN_URLS", "").split(",")
        if item.strip()
    ]
    if not urls:
        return None
    server = {"urls": urls}
    username = os.environ.get("TURN_USERNAME", "").strip()
    credential = os.environ.get("TURN_CREDENTIAL", "").strip()
    if username:
        server["username"] = username
    if credential:
        server["credential"] = credential
    return [server]


async def _fetch_cloudflare_ice_servers():
    """Fetch short-lived ICE servers from Cloudflare TURN API.
    Returns list of iceServers dicts, or None on failure."""
    app_id = os.environ.get("CLOUDFLARE_TURN_APP_ID", "").strip()
    api_token = os.environ.get("CLOUDFLARE_TURN_API_TOKEN", "").strip()
    if not app_id or not api_token:
        return None
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.post(
                f"https://rtc.live.cloudflare.com/v1/turn/keys/{app_id}/credentials/generate-ice-servers",
                headers={
                    "Authorization": f"Bearer {api_token}",
                    "Content-Type": "application/json",
                },
                json={"ttl": 3600},
            )
            if r.status_code in (200, 201):
                data = r.json()
                return data.get("iceServers")
            # Common 404 "cannot find specified key" = CLOUDFLARE_TURN_APP_ID
            # is wrong/expired; we already fall back to OpenRelay below so
            # this isn't fatal — log at INFO to avoid filling production logs
            # with WARN noise. Other status codes still log as WARN.
            if r.status_code == 404:
                logger.info(
                    "Cloudflare TURN key not found (404) — falling back to "
                    "OpenRelay STUN/TURN. Configure CLOUDFLARE_TURN_APP_ID "
                    "+ CLOUDFLARE_TURN_API_TOKEN to enable Cloudflare TURN."
                )
            else:
                logger.warning(
                    f"Cloudflare TURN generate-ice-servers HTTP {r.status_code}: {r.text[:200]}"
                )
            return None
    except Exception as e:
        logger.warning(f"Cloudflare TURN fetch failed: {e}")
        return None


# Public Open Relay TURN is best-effort only. Production should configure
# TURN_URLS or Cloudflare TURN because public relay capacity is not guaranteed.
_OPEN_RELAY_SERVERS = [
    {"urls": "stun:openrelay.metered.ca:80"},
    {
        "urls": "turn:openrelay.metered.ca:80",
        "username": "openrelayproject",
        "credential": "openrelayproject",
    },
    {
        "urls": "turn:openrelay.metered.ca:443",
        "username": "openrelayproject",
        "credential": "openrelayproject",
    },
    {
        "urls": "turn:openrelay.metered.ca:443?transport=tcp",
        "username": "openrelayproject",
        "credential": "openrelayproject",
    },
]

_GOOGLE_STUN_SERVERS = [
    {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]},
]






def public_call_status(call: dict, user_id: str) -> dict:
    callee_ids = call.get("callee_ids") or [
        member_id for member_id in call.get("member_ids", []) if member_id != call.get("caller_id")
    ]
    participants = call.get("participants") or []
    if not all(isinstance(participant, dict) for participant in participants):
        participants = []
    return {
        "id": call.get("id"),
        "call_id": call.get("id"),
        "callId": call.get("id"),
        "caller_id": call.get("caller_id"),
        "callerId": call.get("caller_id"),
        "caller_name": call.get("caller_name") or "Unknown",
        "callee_ids": callee_ids,
        "calleeId": callee_ids[0] if callee_ids else "",
        "participants": participants,
        "member_ids": call.get("member_ids", []),
        "conversation_id": call.get("conversation_id") or call.get("conv_id"),
        "conversationId": call.get("conversation_id") or call.get("conv_id"),
        "mode": call.get("mode") or "audio",
        "callType": call.get("mode") or "audio",
        "status": call.get("status") or "ringing",
        "direction": "outgoing" if call.get("caller_id") == user_id else "incoming",
        "created_at": call.get("created_at") or call.get("started_at"),
        "createdAt": call.get("created_at") or call.get("started_at"),
        "started_at": call.get("started_at") or call.get("created_at"),
        "expires_at": call.get("expires_at"),
        "expiresAt": call.get("expires_at"),
        "answered_at": call.get("answered_at"),
        "answeredAt": call.get("answered_at"),
        "ended_at": call.get("ended_at"),
        "endedAt": call.get("ended_at"),
        "lastUpdatedAt": call.get("lastUpdatedAt") or call.get("last_updated_at"),
        "lastKnownClientState": call.get("lastKnownClientState") or call.get("last_known_client_state") or {},
        "encrypted": True,
        "e2ee_media": call.get("e2ee_media") or "webrtc-dtls-srtp",
    }


async def expire_stale_ringing_calls_for_user(user_id: str) -> None:
    now_iso = now_utc().isoformat()
    cutoff = (now_utc() - timedelta(seconds=CALL_RING_TIMEOUT_SECONDS)).isoformat()
    stale = await db.calls.find(
        {
            "member_ids": user_id,
            "status": "ringing",
            "answered_at": None,
            "ended_at": None,
            "$or": [
                {"expires_at": {"$lt": now_iso}},
                {"expires_at": {"$exists": False}, "started_at": {"$lt": cutoff}},
            ],
        },
        {"_id": 0},
    ).to_list(20)
    for call in stale:
        ended_iso = now_utc().isoformat()
        await db.calls.update_one(
            {"id": call.get("id"), "ended_at": None},
            {
                "$set": {
                    "status": "missed",
                    "ended_at": ended_iso,
                    "endedAt": ended_iso,
                    "ended_by": "timeout",
                    "last_updated_at": ended_iso,
                    "lastUpdatedAt": ended_iso,
                }
            },
        )
        event = {
            "type": "call:ended",
            "event": "call.timeout",
            "call_id": call.get("id"),
            "from": "timeout",
            "data": {"call_id": call.get("id"), "status": "missed", "ended_by": "timeout"},
        }
        await broadcast_to_members(call.get("member_ids", []), event)
        asyncio.create_task(_send_call_control_push(call, "missed", "timeout"))










async def _persist_call_signal_payload(
    call_id: str,
    payload: dict,
    user: dict,
    *,
    forced_type: Optional[str] = None,
) -> dict:
    """Persist encrypted WebRTC signaling briefly as a WebSocket fallback."""
    await enforce_rate_limit(
        "call-signal-user-minute", user["id"], limit=600, window_seconds=60
    )
    await enforce_rate_limit(
        "call-signal-call-window",
        f"{user['id']}:{call_id}",
        limit=1800,
        window_seconds=10 * 60,
    )
    signal_type = forced_type or str(payload.get("type") or "")
    allowed = {
        "call:offer", "call:answer", "call:ice", "call:ready",
        "call:accept", "call:reject", "call:end", "call:cancel",
    }
    target = str(payload.get("to") or "")
    if signal_type not in allowed or not target:
        raise HTTPException(status_code=400, detail="Invalid call signal")
    signal = normalize_call_signal_envelope(
        {**payload, "type": signal_type, "call_id": call_id},
        call_id=call_id,
        sender_id=user["id"],
        receiver_id=target,
    )
    if signal_type in {"call:offer", "call:answer", "call:ice"}:
        if not signal.get("encrypted") or not isinstance(signal.get("e2ee_signal"), dict):
            raise HTTPException(status_code=400, detail="Call signal must be encrypted")
    if not await user_can_signal_target(user["id"], target, signal):
        raise HTTPException(status_code=403, detail="Unauthorized call signal")

    signal_id = str(signal.get("signal_id") or uuid.uuid4())
    forwarded = {
        **signal,
        "signal_id": signal_id,
        "from": user["id"],
    }
    await db.call_signals.delete_many(
        {"created_at": {"$lt": (now_utc() - timedelta(minutes=10)).isoformat()}}
    )
    await db.call_signals.update_one(
        {"signal_id": signal_id},
        {
            "$setOnInsert": {
                **forwarded,
                "to": target,
                "created_at": forwarded.get("created_at") or now_utc().isoformat(),
            }
        },
        upsert=True,
    )
    logger.info(
        "BACKEND_CALL_SIGNAL_STORED "
        f"call={call_id[:8]} "
        f"type={signal_type} "
        f"from={str(user.get('id', ''))[:8]} "
        f"to={target[:8]} "
        f"encrypted={bool(forwarded.get('encrypted'))}"
    )
    await ws_manager.send_to(target, forwarded)
    return {"stored": True, "signal_id": signal_id}












async def _finish_call(call_id: str, user: dict, action: str):
    await enforce_rate_limit(
        f"call-{action}-user", user["id"], limit=120, window_seconds=60 * 60
    )
    call = await db.calls.find_one({"id": call_id}, {"_id": 0})
    if not call:
        return {"ended": True, "ephemeral": True}
    if user["id"] not in call.get("member_ids", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    current_status = str(call.get("status") or "").lower()
    logger.info(
        f"BACKEND_CALL_STATUS_BEFORE_ACTION action={action} call={call_id[:8]} status={current_status}"
    )
    if call.get("ended_at") or current_status in CALL_TERMINAL_STATUSES:
        return {"ended": True, "status": call.get("status", "ended"), "idempotent": True}
    ended_iso = now_utc().isoformat()
    answered = call.get("answered_at")
    if action == "decline" and answered:
        logger.info(
            "BACKEND_CALL_DECLINE_IGNORED_AFTER_ACCEPT "
            f"call={call_id[:8]} status={current_status} user={str(user.get('id', ''))[:8]}"
        )
        return {
            "ended": False,
            "status": call.get("status") or "answered",
            "ignored": True,
            "reason": "already_accepted",
        }
    update_doc: dict = {
        "ended_at": ended_iso,
        "endedAt": ended_iso,
        "ended_by": user["id"],
        "last_updated_at": ended_iso,
        "lastUpdatedAt": ended_iso,
    }
    if answered:
        try:
            ans_dt = datetime.fromisoformat(answered)
            end_dt = datetime.fromisoformat(ended_iso)
            duration = max(0, int((end_dt - ans_dt).total_seconds()))
            update_doc["duration_sec"] = duration
            update_doc["status"] = "ended"
        except Exception:
            update_doc["status"] = "ended"
    elif action == "decline":
        if user["id"] == call.get("caller_id"):
            raise HTTPException(status_code=403, detail="Caller cannot decline own call")
        update_doc["status"] = "declined"
    elif action == "cancel":
        if user["id"] != call.get("caller_id"):
            raise HTTPException(status_code=403, detail="Only caller can cancel call")
        update_doc["status"] = "cancelled"
    else:
        # Never answered. If the caller ends it, it is a cancellation; if the
        # callee ends it, it is an explicit decline rather than a missed call.
        update_doc["status"] = "cancelled" if user["id"] == call.get("caller_id") else "declined"
    await db.calls.update_one({"id": call_id}, {"$set": update_doc})
    ended_event = {
        "type": "call:ended",
        "event": f"call.{update_doc.get('status', 'ended')}",
        "call_id": call_id,
        "from": user["id"],
        "data": {
            "call_id": call_id,
            "ended_by": user["id"],
            "status": update_doc.get("status", "ended"),
        },
    }
    ended_signals = [
        {
            **ended_event,
            "signal_id": str(uuid.uuid4()),
            "to": member_id,
            "created_at": ended_iso,
        }
        for member_id in call.get("member_ids", [])
        if member_id != user["id"]
    ]
    if ended_signals:
        await db.call_signals.insert_many(ended_signals)
    await broadcast_to_members(
        call["member_ids"],
        ended_event,
    )
    asyncio.create_task(_send_call_control_push(call, update_doc.get("status", "ended"), user["id"]))
    logger.info(
        "BACKEND_CALL_STATUS_AFTER_ACTION "
        f"action={action} call={call_id[:8]} status={update_doc.get('status', 'ended')}"
    )
    if update_doc.get("status") == "declined":
        logger.info(f"BACKEND_CALL_DECLINED call={call_id[:8]}")
    elif update_doc.get("status") == "cancelled":
        logger.info(f"BACKEND_CALL_CANCELLED call={call_id[:8]}")
    elif update_doc.get("status") == "ended":
        logger.info(f"BACKEND_CALL_ENDED call={call_id[:8]}")
    if call.get("ephemeral"):
        await db.calls.delete_one({"id": call_id})
    return {"ended": True, "status": update_doc.get("status", "ended")}




# ----------------- Call history -----------------
async def enrich_call_for_user(call: dict, user_id: str) -> dict:
    """Attach lightweight participant data used by the call UI."""
    call["direction"] = "outgoing" if call.get("caller_id") == user_id else "incoming"
    member_ids = [m for m in call.get("member_ids", []) if m]
    if not member_ids:
        call["participants"] = []
        return call

    cursor = db.users.find(
        {"id": {"$in": member_ids}},
        {
            "_id": 0,
            "id": 1,
            "name": 1,
            "username": 1,
            "avatar_color": 1,
            "status": 1,
        },
    )
    by_id = {u["id"]: u async for u in cursor if u.get("id")}
    call["participants"] = [
        by_id[m]
        for m in member_ids
        if m in by_id
    ]
    return call


























# ----------------- Privacy & Blocking -----------------












# ----------------- WebSocket (signaling + live messages) -----------------
class WSManager:
    def __init__(self):
        self.sockets: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, user_id: str, ws: WebSocket):
        async with self._lock:
            self.sockets.setdefault(user_id, set()).add(ws)

    async def disconnect(self, user_id: str, ws: WebSocket):
        async with self._lock:
            if user_id in self.sockets:
                self.sockets[user_id].discard(ws)
                if not self.sockets[user_id]:
                    self.sockets.pop(user_id, None)

    async def send_to(self, user_id: str, payload: dict):
        async with self._lock:
            sockets = list(self.sockets.get(user_id, []))
        for ws in sockets:
            try:
                await ws.send_text(json.dumps(payload))
            except Exception:
                pass


ws_manager = WSManager()


async def broadcast_to_members(member_ids, payload, exclude: Optional[str] = None):
    for uid in member_ids:
        if uid == exclude:
            continue
        await ws_manager.send_to(uid, payload)




@app.websocket("/api/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    ticket: Optional[str] = None,
    token: Optional[str] = None,
):
    await websocket.accept()
    credential = ticket or (token if ALLOW_LEGACY_WS_TOKEN else None)
    if not credential:
        await websocket.send_text(json.dumps({"type": "error", "data": "missing ticket"}))
        await websocket.close()
        return
    try:
        payload = jwt.decode(credential, JWT_SECRET, algorithms=[JWT_ALG])
        user_id = payload.get("sub")
        credential_type = payload.get("type")
        if not user_id or credential_type not in ("ws", "access"):
            raise ValueError("invalid ticket")
        session_id = payload.get("sid")
        if session_id:
            session = await db.user_sessions.find_one(
                {"id": session_id, "user_id": user_id},
                {"_id": 0, "revoked_at": 1, "expires_at": 1},
            )
            if not session or session.get("revoked_at"):
                raise ValueError("session revoked")
        if credential_type == "ws":
            jti = payload.get("jti")
            if not jti:
                raise ValueError("invalid ticket")
            consumed = await db.ws_tickets.find_one_and_delete(
                {"jti": jti, "user_id": user_id, "expires_at": {"$gt": now_utc()}}
            )
            if not consumed:
                raise ValueError("used or expired ticket")
        elif not token or not ALLOW_LEGACY_WS_TOKEN:
            raise ValueError("legacy token disabled")
        elif payload.get("jti") and await db.revoked_tokens.find_one(
            {"jti": payload["jti"]}, {"_id": 1}
        ):
            raise ValueError("token revoked")
        ws_user = await db.users.find_one({"id": user_id}, {"_id": 0, "id": 1})
        if not ws_user:
            raise ValueError("user not found")
    except Exception:
        await websocket.send_text(json.dumps({"type": "error", "data": "invalid ticket"}))
        await websocket.close()
        return

    await ws_manager.connect(user_id, websocket)
    # Mark user as online (best-effort)
    try:
        await db.users.update_one(
            {"id": user_id},
            {"$set": {"status": "online", "last_active": now_utc().isoformat()}},
        )
    except Exception:
        pass
    await websocket.send_text(json.dumps({"type": "hello", "data": {"user_id": user_id}}))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            mtype = data.get("type")
            # WebRTC signaling: forward to target user
            if mtype in {
                "call:offer",
                "call:answer",
                "call:ice",
                "call:reject",
                "call:end",
                "call:ringing",
                "call:accept",   # callee tapped Accept (UI signal)
                "call:ready",    # callee's PC + media ready, caller can send offer
                "call:cancel",   # caller cancelled before answer
            }:
                target = data.get("to")
                if mtype in {"call:offer", "call:answer", "call:ice"}:
                    signal = data.get("e2ee_signal")
                    if not data.get("encrypted") or not isinstance(signal, dict):
                        await websocket.send_text(
                            json.dumps({"type": "error", "data": "call signal must be end-to-end encrypted"})
                        )
                        continue
                    # Do not forward accidental plaintext SDP/ICE material.
                    data = {
                        k: v
                        for k, v in data.items()
                        if k not in {"sdp", "candidate"}
                    }
                if target:
                    data = normalize_call_signal_envelope(
                        {**data, "type": mtype},
                        call_id=str(data.get("call_id") or data.get("callId") or ""),
                        sender_id=user_id,
                        receiver_id=str(target),
                    )
                if target and await user_can_signal_target(user_id, target, data):
                    await ws_manager.send_to(target, {**data, "from": user_id})
                elif target:
                    await websocket.send_text(
                        json.dumps({"type": "error", "data": "unauthorized signal"})
                    )
            elif mtype == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect(user_id, websocket)
        # If user no longer has any active WS, mark them offline + record last_seen
        try:
            still_online = bool(ws_manager.sockets.get(user_id))
            if not still_online:
                now = now_utc().isoformat()
                await db.users.update_one(
                    {"id": user_id},
                    {"$set": {"status": "offline", "last_seen": now, "last_active": now}},
                )
        except Exception:
            pass


# ----------------- Health -----------------


ANDROID_APK_VERSION = "1.4.43"


@app.get("/app-release.apk")
async def download_android_apk():
    apk_path = ROOT_DIR.parent / "frontend" / "android" / "app" / "build" / "outputs" / "apk" / "release" / "app-release.apk"
    if not apk_path.exists():
        raise HTTPException(status_code=404, detail="APK not built")
    headers = {
        "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "X-Ghostel-Android-Version": ANDROID_APK_VERSION,
    }
    return FileResponse(
        apk_path,
        media_type="application/vnd.android.package-archive",
        filename=f"ghostel-app-release-{ANDROID_APK_VERSION}.apk",
        headers=headers,
    )


@app.head("/app-release.apk")
async def head_android_apk():
    apk_path = ROOT_DIR.parent / "frontend" / "android" / "app" / "build" / "outputs" / "apk" / "release" / "app-release.apk"
    if not apk_path.exists():
        raise HTTPException(status_code=404, detail="APK not built")
    return Response(
        headers={
            "Content-Type": "application/vnd.android.package-archive",
            "Content-Length": str(apk_path.stat().st_size),
            "Content-Disposition": f'attachment; filename="ghostel-app-release-{ANDROID_APK_VERSION}.apk"',
            "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "X-Ghostel-Android-Version": ANDROID_APK_VERSION,
        }
    )


# Register router
app.include_router(api)

_cors_raw = os.environ.get("CORS_ORIGINS", "").strip()
_cors_origins = [o.strip() for o in _cors_raw.split(",") if o.strip()] if _cors_raw else [
    "http://localhost:3000",
    "http://localhost:8081",
]

app.add_middleware(
    CORSMiddleware,
    allow_credentials="*" not in _cors_origins,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


from pymongo.errors import OperationFailure

# ----------------- Startup -----------------
async def _ensure_indexes() -> None:
    """Create required indexes. Each call is independently wrapped so that a
    pre-existing index with slightly different options doesn't crash startup."""
    index_specs = [
        ("users", "email", {"unique": True}),
        ("users", "id", {"unique": True}),
        ("users", "username", {"unique": True, "sparse": True}),
        ("conversations", "id", {"unique": True}),
        ("conversations", "member_ids", {}),
        ("messages", [("conversation_id", 1), ("created_at", 1)], {}),
        ("messages", "id", {"unique": True}),
        # TTL index for disappearing messages — Mongo will auto-delete docs whose
        # expires_at is in the past. expireAfterSeconds=0 → use the field value as the absolute expiry.
        ("messages", "expires_at", {"expireAfterSeconds": 0}),
        ("attachments", "id", {"unique": True}),
        ("calls", "id", {"unique": True}),
        ("calls", "conversation_id", {}),
        ("login_attempts", "at", {}),
        ("login_attempts", "expires_at", {"expireAfterSeconds": 0}),
        ("rate_limits", "key", {"unique": True}),
        ("rate_limits", "expires_at", {"expireAfterSeconds": 0}),
        ("revoked_tokens", "jti", {"unique": True}),
        ("revoked_tokens", "expires_at", {"expireAfterSeconds": 0}),
        ("user_sessions", "id", {"unique": True}),
        ("user_sessions", "user_id", {}),
        ("user_sessions", "expires_at", {"expireAfterSeconds": 0}),
        ("ws_tickets", "jti", {"unique": True}),
        ("ws_tickets", "expires_at", {"expireAfterSeconds": 0}),
        ("contact_invitations", "id", {"unique": True}),
        (
            "contact_invitations",
            [("from_user_id", 1), ("to_user_id", 1)],
            {},
        ),
        ("contact_invitations", "to_user_id", {}),
        ("contact_invitations", "from_user_id", {}),
        ("support_reports", "id", {"unique": True}),
        ("support_reports", "user_id", {}),
        ("support_reports", "created_at", {}),
    ]
    for collection_name, keys, opts in index_specs:
        try:
            await db[collection_name].create_index(keys, **opts)
        except OperationFailure as e:
            logger.warning(f"Index on {collection_name}/{keys} skipped: {e}")
        except Exception as e:
            logger.warning(f"Index on {collection_name}/{keys} failed: {e}")


async def _seed_user_safely(filter_q: dict, doc_on_insert: dict, label: str) -> None:
    """Atomic, idempotent upsert with a triple safety net:

    1. `update_one` with `$setOnInsert` + `upsert=True` is the primary atomic op.
    2. `DuplicateKeyError` swallowed if a concurrent worker beat us to the insert.
    3. Catch-all `Exception` so even unanticipated errors only log, never crash startup.
    """
    try:
        await db.users.update_one(
            filter_q,
            {"$setOnInsert": doc_on_insert},
            upsert=True,
        )
    except DuplicateKeyError:
        logger.info(f"{label} already exists (race ignored)")
    except Exception as e:
        logger.warning(f"{label} seed encountered (ignored): {e!r}")


@app.on_event("startup")
async def on_startup():
    await _ensure_indexes()

    admin_email = os.environ.get("ADMIN_EMAIL", "admin@ghostel.app").lower()
    admin_password = os.environ.get("ADMIN_PASSWORD")
    if not admin_password:
        if os.environ.get("ALLOW_INSECURE_DEFAULT_ADMIN", "").lower() == "true":
            admin_password = "Admin@2026!"
            logger.warning(
                "Using the insecure default admin password because "
                "ALLOW_INSECURE_DEFAULT_ADMIN=true. Do not use this in production."
            )
        else:
            raise RuntimeError(
                "ADMIN_PASSWORD must be set. Refusing to create a default admin "
                "with a public password."
            )
    await _seed_user_safely(
        {"email": admin_email},
        {
            "id": str(uuid.uuid4()),
            "email": admin_email,
            "password_hash": hash_password(admin_password),
            "name": "Admin",
            "title": "System Administrator",
            "bio": "Default administrator account",
            "status": "online",
            "role": "admin",
            "two_factor_enabled": False,
            "totp_secret": None,
            "avatar_color": "#00d9ff",
            "created_at": now_utc().isoformat(),
            "last_seen": now_utc().isoformat(),
        },
        label=f"admin {admin_email}",
    )
    # If the admin already exists but its password no longer matches the env,
    # rotate the hash so the env stays authoritative.
    try:
        existing_admin = await db.users.find_one({"email": admin_email})
        if existing_admin and not verify_password(
            admin_password, existing_admin["password_hash"]
        ):
            await db.users.update_one(
                {"email": admin_email},
                {"$set": {"password_hash": hash_password(admin_password)}},
            )
    except Exception as e:
        logger.warning(f"Admin password rotation skipped: {e!r}")

    # Seed a demo user for testing
    demo_email = os.environ.get("DEMO_EMAIL", "demo@silentel.app").lower()
    demo_password = os.environ.get("DEMO_PASSWORD")
    if not demo_password:
        if os.environ.get("ALLOW_INSECURE_DEFAULT_DEMO", "").lower() == "true":
            demo_password = "Demo@2026!"
            logger.warning(
                "Using the insecure default demo password because "
                "ALLOW_INSECURE_DEFAULT_DEMO=true. Do not use this in production."
            )
        else:
            raise RuntimeError(
                "DEMO_PASSWORD must be set. Refusing to create a default demo "
                "with a public password."
            )
    await _seed_user_safely(
        {"email": demo_email},
        {
            "id": str(uuid.uuid4()),
            "email": demo_email,
            "password_hash": hash_password(demo_password),
            "name": "Demo User",
            "title": "Sales Lead",
            "bio": "Hi, I'm a demo user.",
            "status": "online",
            "role": "user",
            "two_factor_enabled": False,
            "totp_secret": None,
            "avatar_color": "#00ba88",
            "created_at": now_utc().isoformat(),
            "last_seen": now_utc().isoformat(),
        },
        label=f"demo {demo_email}",
    )

    # ---- Migration: backfill username for older users, populate contact_ids ----
    try:
        await _migrate_usernames_and_contacts()
    except Exception as e:
        # Migration is best-effort; never block startup if something unexpected happens.
        logger.warning(f"Startup migration skipped due to error: {e!r}")

    logger.info("ghostel.app backend ready")


async def _migrate_usernames_and_contacts():
    """Idempotent migration that runs every startup:
       1. Generates a username for any user lacking one.
       2. Removes data left by the retired assistant feature.
       3. For every existing direct conversation, ensures both members are
          in each other's contact_ids (preserves pre-existing chat partners
          as contacts so users don't lose access to existing threads)."""
    try:
        # Reserve canonical usernames for known seeded accounts
        await db.users.update_one(
            {"email": os.environ.get("ADMIN_EMAIL", "admin@silentel.app").lower(),
             "$or": [{"username": {"$exists": False}}, {"username": ""}, {"username": None}]},
            {"$set": {"username": "admin"}},
        )
        await db.users.update_one(
            {"email": "demo@silentel.app",
             "$or": [{"username": {"$exists": False}}, {"username": ""}, {"username": None}]},
            {"$set": {"username": "demo"}},
        )
        # Backfill remaining users
        cursor = db.users.find(
            {"$or": [{"username": {"$exists": False}}, {"username": ""}, {"username": None}]},
            {"_id": 0, "id": 1, "email": 1, "name": 1},
        )
        async for u in cursor:
            seed = u.get("email") or u.get("name") or u["id"]
            un = await generate_unique_username(seed)
            await db.users.update_one({"id": u["id"]}, {"$set": {"username": un}})
            logger.info(f"Backfilled username '{un}' for user {u['id']}")

        # Remove the retired assistant without deleting human messages from groups.
        retired_conversations = await db.conversations.find(
            {"member_ids": REMOVED_ASSISTANT_USER_ID},
            {"_id": 0, "id": 1, "type": 1},
        ).to_list(10000)
        direct_ids = [
            conv["id"] for conv in retired_conversations if conv.get("type") == "direct"
        ]
        group_ids = [
            conv["id"] for conv in retired_conversations if conv.get("type") != "direct"
        ]
        if direct_ids:
            await db.messages.delete_many({"conversation_id": {"$in": direct_ids}})
            await db.conversations.delete_many({"id": {"$in": direct_ids}})
        if group_ids:
            await db.messages.delete_many(
                {
                    "conversation_id": {"$in": group_ids},
                    "sender_id": REMOVED_ASSISTANT_USER_ID,
                }
            )
            await db.messages.update_many(
                {"conversation_id": {"$in": group_ids}},
                {"$pull": {"read_by": REMOVED_ASSISTANT_USER_ID}},
            )
            await db.conversations.update_many(
                {"id": {"$in": group_ids}},
                {
                    "$pull": {
                        "member_ids": REMOVED_ASSISTANT_USER_ID,
                        "admin_ids": REMOVED_ASSISTANT_USER_ID,
                    }
                },
            )
        await db.users.update_many(
            {},
            {"$pull": {"contact_ids": REMOVED_ASSISTANT_USER_ID}},
        )
        await db.users.delete_one({"id": REMOVED_ASSISTANT_USER_ID})

        # Preserve existing direct conversation partners as contacts
        direct_cursor = db.conversations.find(
            {"type": "direct"}, {"_id": 0, "member_ids": 1}
        )
        async for conv in direct_cursor:
            members = conv.get("member_ids") or []
            if len(members) != 2:
                continue
            a, b = members[0], members[1]
            await db.users.update_one({"id": a}, {"$addToSet": {"contact_ids": b}})
            await db.users.update_one({"id": b}, {"$addToSet": {"contact_ids": a}})
    except Exception as e:
        logger.warning(f"Contact migration encountered: {e}")




@app.on_event("shutdown")
async def on_shutdown():
    client.close()
