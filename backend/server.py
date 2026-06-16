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
from pydantic import BaseModel, Field, EmailStr

# ----------------- Setup -----------------
mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

app = FastAPI(title="ghostel.app Enterprise API")
api = APIRouter(prefix="/api")

JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALG = "HS256"
APP_NAME = os.environ.get("APP_NAME", "ghostel.app")
ALLOW_LEGACY_WS_TOKEN = os.environ.get("ALLOW_LEGACY_WS_TOKEN", "false").lower() == "true"
REMOVED_ASSISTANT_USER_ID = "ghost-ai-bot"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ghostel")

# ----------------- Helpers -----------------
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


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


def create_access_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": now_utc() + timedelta(days=7),
        "type": "access",
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def create_ws_ticket(user_id: str) -> tuple[str, str, datetime]:
    jti = str(uuid.uuid4())
    expires_at = now_utc() + timedelta(seconds=60)
    token = jwt.encode(
        {
            "sub": user_id,
            "exp": expires_at,
            "type": "ws",
            "jti": jti,
        },
        JWT_SECRET,
        algorithm=JWT_ALG,
    )
    return token, jti, expires_at


def user_has_push_token(u: dict) -> bool:
    return bool(u.get("push_tokens") or u.get("push_token") or u.get("expo_push_token"))


def user_push_targets(u: dict) -> list[dict]:
    """Return all registered push targets, including legacy single-token fields."""
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
                "device_model": entry.get("device_model") or "",
                "os_version": entry.get("os_version") or "",
                "source": entry.get("source") or "",
                "registered_at": entry.get("registered_at") or "",
            }
        )
    legacy = (u.get("push_token") or u.get("expo_push_token") or "").strip()
    if legacy and legacy not in seen:
        targets.append(
            {
                "token": legacy,
                "token_type": (u.get("push_token_type") or "fcm").strip().lower(),
                "platform": u.get("push_platform") or "unknown",
                "device_model": "",
                "os_version": "",
                "source": "legacy",
                "registered_at": "",
            }
        )
    return targets


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


import re as _re
_USERNAME_RE = _re.compile(r"^[a-z0-9_]{3,20}$")


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
    if jti and await db.revoked_tokens.find_one({"jti": jti}, {"_id": 1}):
        raise HTTPException(status_code=401, detail="Token revoked")
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
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
    size: Optional[int] = Field(default=None, ge=0, le=8 * 1024 * 1024)
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
    size: int = Field(ge=0, le=8 * 1024 * 1024)  # 8MB cap


class PushTokenIn(BaseModel):
    token: str = Field(min_length=4, max_length=500)
    platform: Literal["ios", "android", "web"] = "web"
    # Accepts both raw Expo-style names ('android'/'ios') and explicit names
    # ('fcm'/'apns'). 'expo' kept for legacy ExpoPushToken[...] tokens.
    token_type: Literal["fcm", "apns", "expo", "android", "ios"] = "fcm"
    device_model: Optional[str] = None
    os_version: Optional[str] = None
    source: Optional[str] = None


class CallStartIn(BaseModel):
    conversation_id: str
    mode: Literal["audio", "video"] = "audio"


class DisappearingIn(BaseModel):
    seconds: Optional[int] = Field(default=None, ge=0, le=60 * 60 * 24 * 30)  # max 30 days


class PrivacyUpdateIn(BaseModel):
    save_call_history: Optional[bool] = None


class MuteUpdateIn(BaseModel):
    muted: bool


# ----------------- Auth Routes -----------------
@api.post("/auth/register")
async def register(payload: RegisterIn, request: Request):
    email = payload.email.lower().strip()
    await enforce_rate_limit(
        "auth-register-ip", client_ip(request), limit=10, window_seconds=60 * 60
    )
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    # Username: validate or auto-generate
    if payload.username:
        username = normalize_username(payload.username)
        if not _USERNAME_RE.match(username):
            raise HTTPException(
                status_code=400,
                detail="Username must be 3-20 characters, lowercase letters, numbers or underscore",
            )
        if await is_username_taken(username):
            raise HTTPException(status_code=400, detail="Username already taken")
    else:
        username = await generate_unique_username(email)

    user_id = str(uuid.uuid4())
    colors = ["#00d9ff", "#00ba88", "#ffb340", "#ff5757", "#a78bfa", "#60a5fa", "#f472b6"]
    user_doc = {
        "id": user_id,
        "email": email,
        "username": username,
        "password_hash": hash_password(payload.password),
        "name": payload.name.strip(),
        "title": (payload.title or "").strip(),
        "bio": "",
        "status": "online",
        "role": "user",
        "two_factor_enabled": False,
        "totp_secret": None,
        "avatar_color": colors[hash(email) % len(colors)],
        "contact_ids": [],
        "created_at": now_utc().isoformat(),
        "last_seen": now_utc().isoformat(),
    }
    await db.users.insert_one(user_doc)
    token = create_access_token(user_id, email)
    return {"access_token": token, "token_type": "bearer", "user": public_user(user_doc)}


@api.post("/auth/login")
async def login(payload: LoginIn, request: Request):
    identifier = (payload.identifier or payload.email or "").lower().strip().lstrip("@")
    if not identifier:
        raise HTTPException(status_code=422, detail="Username or email is required")
    await enforce_rate_limit(
        "auth-login-ip", client_ip(request), limit=30, window_seconds=5 * 60
    )
    await enforce_rate_limit(
        "auth-login-identifier", identifier, limit=10, window_seconds=5 * 60
    )
    user = await db.users.find_one(
        {"email": identifier} if "@" in identifier else {"username": normalize_username(identifier)},
        {"_id": 0},
    )
    if not user or not verify_password(payload.password, user["password_hash"]):
        # brute force tracking
        await db.login_attempts.insert_one({
            "identifier": identifier,
            "at": now_utc(),
            "expires_at": now_utc() + timedelta(days=30),
            "success": False,
        })
        raise HTTPException(status_code=401, detail="Invalid username/email or password")

    if user.get("two_factor_enabled"):
        if not payload.totp_code:
            return {"requires_2fa": True, "user_id": user["id"]}
        totp = pyotp.TOTP(user["totp_secret"])
        if not totp.verify(payload.totp_code, valid_window=1):
            await db.login_attempts.insert_one({
                "identifier": identifier,
                "at": now_utc(),
                "expires_at": now_utc() + timedelta(days=30),
                "success": False,
                "reason": "invalid_2fa",
            })
            raise HTTPException(status_code=401, detail="Invalid 2FA code")

    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"last_seen": now_utc().isoformat(), "status": "online"}},
    )
    await db.login_attempts.delete_many({"identifier": identifier})
    token = create_access_token(user["id"], user["email"])
    return {"access_token": token, "token_type": "bearer", "user": public_user(user)}


@api.get("/auth/username-available")
async def username_available(username: str):
    normalized = normalize_username(username)
    valid = bool(_USERNAME_RE.match(normalized))
    return {
        "username": normalized,
        "valid": valid,
        "available": valid and not await is_username_taken(normalized),
    }


@api.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    data = public_user(user)
    # Expose private fields needed by the client (only to the user themselves):
    data["muted_users"] = user.get("muted_users") or {}
    data["muted_conversation_ids"] = user.get("muted_conversation_ids") or []
    data["blocked_user_ids"] = user.get("blocked_user_ids") or []
    data["save_call_history"] = bool(user.get("save_call_history", True))
    return data


@api.post("/auth/logout")
async def logout(request: Request, user: dict = Depends(get_current_user)):
    token = request.headers.get("Authorization", "")[7:]
    payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    jti = payload.get("jti")
    expires = payload.get("exp")
    if jti and expires:
        await db.revoked_tokens.update_one(
            {"jti": jti},
            {
                "$set": {
                    "jti": jti,
                    "user_id": user["id"],
                    "expires_at": datetime.fromtimestamp(expires, tz=timezone.utc),
                }
            },
            upsert=True,
        )
    return {"ok": True}


# ----------------- E2EE key registry -----------------
@api.post("/e2ee/keys")
async def register_e2ee_key(payload: E2EEKeyIn, user: dict = Depends(get_current_user)):
    public_key = payload.public_key.strip()
    updated_at = now_utc().isoformat()
    await db.users.update_one(
        {"id": user["id"]},
        {
            "$set": {
                "e2ee_public_key": public_key,
                "e2ee_algorithm": payload.algorithm,
                "e2ee_key_updated_at": updated_at,
            }
        },
    )
    return {
        "user_id": user["id"],
        "algorithm": payload.algorithm,
        "public_key": public_key,
        "updated_at": updated_at,
    }


@api.get("/e2ee/users/{user_id}/key")
async def get_e2ee_key(user_id: str, user: dict = Depends(get_current_user)):
    if user_id != user["id"] and user_id not in set(user.get("contact_ids") or []):
        shared = await db.conversations.find_one(
            {"member_ids": {"$all": [user["id"], user_id]}},
            {"_id": 0, "id": 1},
        )
        if not shared:
            raise HTTPException(status_code=403, detail="E2EE key is available to contacts only")

    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    public_key = target.get("e2ee_public_key")
    if not public_key:
        raise HTTPException(status_code=404, detail="User has not registered an E2EE key")
    return {
        "user_id": user_id,
        "algorithm": target.get("e2ee_algorithm") or "nacl-box-v1",
        "public_key": public_key,
        "updated_at": target.get("e2ee_key_updated_at"),
    }


@api.post("/auth/2fa/setup")
async def two_factor_setup(
    payload: TwoFASetupIn, user: dict = Depends(get_current_user)
):
    if not verify_password(payload.password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid password")
    secret = pyotp.random_base32()
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"totp_secret": secret, "two_factor_enabled": False}},
    )
    uri = pyotp.TOTP(secret).provisioning_uri(name=user["email"], issuer_name=APP_NAME)
    return {"secret": secret, "otpauth_uri": uri}


@api.post("/auth/2fa/enable")
async def two_factor_enable(payload: TwoFAVerifyIn, user: dict = Depends(get_current_user)):
    secret = user.get("totp_secret")
    if not secret:
        raise HTTPException(status_code=400, detail="Run 2FA setup first")
    totp = pyotp.TOTP(secret)
    if not totp.verify(payload.code, valid_window=1):
        raise HTTPException(status_code=400, detail="Invalid code")
    await db.users.update_one(
        {"id": user["id"]}, {"$set": {"two_factor_enabled": True}}
    )
    return {"two_factor_enabled": True}


@api.post("/auth/2fa/disable")
async def two_factor_disable(payload: TwoFAVerifyIn, user: dict = Depends(get_current_user)):
    if not user.get("two_factor_enabled"):
        return {"two_factor_enabled": False}
    secret = user.get("totp_secret")
    totp = pyotp.TOTP(secret)
    if not totp.verify(payload.code, valid_window=1):
        raise HTTPException(status_code=400, detail="Invalid code")
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"two_factor_enabled": False, "totp_secret": None}},
    )
    return {"two_factor_enabled": False}


# ----------------- Users / Profile -----------------
@api.get("/users")
async def list_users(q: Optional[str] = None, user: dict = Depends(get_current_user)):
    """Returns the user's contacts (legacy endpoint kept for compatibility).
    For finding new people use /users/search."""
    contact_ids = user.get("contact_ids") or []
    if not contact_ids:
        return []
    query: dict = {"id": {"$in": contact_ids}}
    if q:
        query["$or"] = [
            {"name": {"$regex": q, "$options": "i"}},
            {"username": {"$regex": q, "$options": "i"}},
            {"email": {"$regex": q, "$options": "i"}},
            {"title": {"$regex": q, "$options": "i"}},
        ]
    cursor = db.users.find(query, {"_id": 0}).limit(200)
    return [public_user(u) async for u in cursor]


@api.get("/users/search")
async def search_users(
    q: str = "", user: dict = Depends(get_current_user)
):
    """Search potential contacts to invite by username (or name prefix).
    Returns up to 20 results, excluding self, current contacts,
    and users with a pending invitation in either direction."""
    qn = (q or "").strip()
    if len(qn) < 2:
        return []
    contact_ids = set(user.get("contact_ids") or [])
    # Build exclusion list: self + contacts
    exclude_ids = contact_ids | {user["id"]}

    # Find pending invitations involving the current user
    pending_cursor = db.contact_invitations.find(
        {
            "status": "pending",
            "$or": [
                {"from_user_id": user["id"]},
                {"to_user_id": user["id"]},
            ],
        },
        {"_id": 0, "from_user_id": 1, "to_user_id": 1},
    )
    pending_user_ids: set = set()
    async for inv in pending_cursor:
        pending_user_ids.add(inv["from_user_id"])
        pending_user_ids.add(inv["to_user_id"])
    exclude_ids |= pending_user_ids

    qn_lower = qn.lower().lstrip("@")
    # Search by username prefix OR name prefix (case-insensitive)
    query = {
        "id": {"$nin": list(exclude_ids)},
        "$or": [
            {"username": {"$regex": f"^{_re.escape(qn_lower)}", "$options": "i"}},
            {"name": {"$regex": qn, "$options": "i"}},
        ],
    }
    cursor = db.users.find(query, {"_id": 0}).limit(20)
    return [public_user(u) async for u in cursor]


@api.patch("/users/me")
async def update_profile(payload: ProfileUpdateIn, user: dict = Depends(get_current_user)):
    updates: dict = {}
    if payload.name is not None:
        updates["name"] = payload.name.strip()[:80]
    if payload.title is not None:
        updates["title"] = payload.title.strip()[:120]
    if payload.bio is not None:
        updates["bio"] = payload.bio.strip()[:280]
    if payload.username is not None:
        new_un = normalize_username(payload.username)
        if not _USERNAME_RE.match(new_un):
            raise HTTPException(
                status_code=400,
                detail="Username must be 3-20 characters, lowercase letters, numbers or underscore",
            )
        if new_un != (user.get("username") or "") and await is_username_taken(new_un, user["id"]):
            raise HTTPException(status_code=400, detail="Username already taken")
        updates["username"] = new_un
    if updates:
        await db.users.update_one({"id": user["id"]}, {"$set": updates})
    fresh = await db.users.find_one({"id": user["id"]}, {"_id": 0})
    return public_user(fresh)


@api.patch("/users/me/avatar")
async def update_avatar(payload: AvatarUpdateIn, user: dict = Depends(get_current_user)):
    """Set or remove the user's profile photo. Stored as base64 data URI (PNG/JPEG)."""
    av = (payload.avatar or "").strip()
    if av and len(av) > 350_000:
        raise HTTPException(status_code=400, detail="Avatar too large (max ~250KB)")
    if av and not (av.startswith("data:image/") or len(av) > 100):
        # accept raw base64 too — but reject obviously bogus values
        raise HTTPException(status_code=400, detail="Invalid avatar payload")
    await db.users.update_one(
        {"id": user["id"]}, {"$set": {"avatar": av or None}}
    )
    fresh = await db.users.find_one({"id": user["id"]}, {"_id": 0})
    # Broadcast profile update to all conversations this user is part of so members refresh
    try:
        convs = await db.conversations.find(
            {"member_ids": user["id"]}, {"_id": 0, "id": 1, "member_ids": 1}
        ).to_list(500)
        member_ids = list({m for c in convs for m in (c.get("member_ids") or [])})
        if member_ids:
            await broadcast_to_members(
                member_ids,
                {"type": "user:update", "data": public_user(fresh)},
                exclude=None,
            )
    except Exception:
        pass
    return public_user(fresh)


@api.post("/users/me/heartbeat")
async def heartbeat(user: dict = Depends(get_current_user)):
    """Marks the user as actively online. Frontend should ping every ~60s while in
    foreground. Used to compute 'online' vs 'last seen' for other users."""
    now = now_utc().isoformat()
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"last_active": now, "last_seen": now}},
    )
    return {"ok": True, "last_active": now}


@api.get("/users/me/export")
async def export_user_data(user: dict = Depends(get_current_user)):
    """GDPR export. Returns a JSON dump of profile, contacts, blocked users, all
    conversations the user is part of, every message they sent or received, and
    their call history. Avatar binary payloads are excluded to keep file small."""
    # User profile (public + a few extra fields)
    profile = public_user(user)
    profile["custom_status"] = user.get("custom_status", "")
    profile["save_call_history"] = user.get("save_call_history", True)
    profile["muted_conversation_ids"] = user.get("muted_conversation_ids", []) or []

    # Contacts
    contact_ids = user.get("contact_ids") or []
    contacts: List[dict] = []
    if contact_ids:
        async for u in db.users.find({"id": {"$in": contact_ids}}, {"_id": 0}):
            c = public_user(u)
            c.pop("avatar", None)  # strip binary
            contacts.append(c)

    # Blocked users
    blocked_ids = user.get("blocked_user_ids") or []
    blocked: List[dict] = []
    if blocked_ids:
        async for u in db.users.find({"id": {"$in": blocked_ids}}, {"_id": 0}):
            blocked.append({
                "id": u["id"], "username": u.get("username", ""), "name": u.get("name", ""),
            })

    # Conversations (with member names) + messages
    conv_docs = await db.conversations.find(
        {"member_ids": user["id"]}, {"_id": 0}
    ).to_list(2000)
    conv_ids = [c["id"] for c in conv_docs]
    conversations_out: List[dict] = []
    for c in conv_docs:
        c.pop("avatar", None)
        conversations_out.append({
            "id": c["id"],
            "type": c.get("type"),
            "name": c.get("name") or "",
            "member_ids": c.get("member_ids") or [],
            "admin_ids": c.get("admin_ids") or [],
            "created_at": c.get("created_at"),
            "disappear_seconds": c.get("disappear_seconds"),
        })

    # Messages
    messages_out: List[dict] = []
    if conv_ids:
        async for m in db.messages.find(
            {"conversation_id": {"$in": conv_ids}},
            {"_id": 0, "data": 0},  # strip any attachment payload
        ).sort("created_at", 1):
            messages_out.append({
                "id": m.get("id"),
                "conversation_id": m.get("conversation_id"),
                "sender_id": m.get("sender_id"),
                "sender_name": m.get("sender_name"),
                "kind": m.get("kind", "text"),
                "content": m.get("content", ""),
                "created_at": m.get("created_at"),
                "expires_at": m.get("expires_at"),
                "reactions": m.get("reactions", {}),
                "attachment_id": m.get("attachment_id"),
                "duration_ms": m.get("duration_ms"),
                "encrypted": bool(m.get("encrypted")),
                "e2ee_version": m.get("e2ee_version"),
                "e2ee": m.get("e2ee"),
                "e2ee_attachment": m.get("e2ee_attachment"),
            })

    # Calls (sent or received)
    calls_out: List[dict] = []
    async for c in db.calls.find(
        {"$or": [{"caller_id": user["id"]}, {"callee_ids": user["id"]}]},
        {"_id": 0},
    ).sort("started_at", -1):
        calls_out.append({
            "id": c.get("id"),
            "conversation_id": c.get("conv_id") or c.get("conversation_id"),
            "caller_id": c.get("caller_id"),
            "callee_ids": c.get("callee_ids", []),
            "status": c.get("status"),
            "mode": c.get("mode", "audio"),
            "started_at": c.get("started_at"),
            "answered_at": c.get("answered_at"),
            "ended_at": c.get("ended_at"),
            "duration_sec": c.get("duration_sec"),
        })

    return {
        "exported_at": now_utc().isoformat(),
        "app": APP_NAME,
        "format_version": 1,
        "profile": profile,
        "contacts": contacts,
        "blocked_users": blocked,
        "conversations": conversations_out,
        "messages": messages_out,
        "calls": calls_out,
        "counts": {
            "contacts": len(contacts),
            "blocked": len(blocked),
            "conversations": len(conversations_out),
            "messages": len(messages_out),
            "calls": len(calls_out),
        },
    }


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


@api.delete("/users/me")
async def delete_my_account(user: dict = Depends(get_current_user)):
    deleted = await delete_user_account_data(user["id"])
    if not deleted:
        raise HTTPException(status_code=404, detail="User not found")
    return {"deleted": True}


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


@api.get("/contacts")
async def list_contacts(user: dict = Depends(get_current_user)):
    contact_ids = user.get("contact_ids") or []
    if not contact_ids:
        return []
    cursor = db.users.find({"id": {"$in": contact_ids}}, {"_id": 0})
    contacts = [public_user(u) async for u in cursor]
    # Sort contacts alphabetically
    contacts.sort(key=lambda c: (c.get("name") or "").lower())
    return contacts


@api.get("/contacts/invitations")
async def list_invitations(user: dict = Depends(get_current_user)):
    incoming_docs = await db.contact_invitations.find(
        {"to_user_id": user["id"], "status": "pending"}, {"_id": 0}
    ).sort("created_at", -1).to_list(200)
    outgoing_docs = await db.contact_invitations.find(
        {"from_user_id": user["id"], "status": "pending"}, {"_id": 0}
    ).sort("created_at", -1).to_list(200)
    ids = {d["from_user_id"] for d in incoming_docs + outgoing_docs} | {
        d["to_user_id"] for d in incoming_docs + outgoing_docs
    }
    users_cursor = db.users.find({"id": {"$in": list(ids)}}, {"_id": 0})
    users_by_id = {u["id"]: u async for u in users_cursor}
    return {
        "incoming": [_public_invitation(d, users_by_id) for d in incoming_docs],
        "outgoing": [_public_invitation(d, users_by_id) for d in outgoing_docs],
    }


@api.post("/contacts/invite")
async def invite_contact(payload: ContactInviteIn, user: dict = Depends(get_current_user)):
    target_un = normalize_username(payload.username)
    if not target_un:
        raise HTTPException(status_code=400, detail="Invalid username")
    target = await db.users.find_one({"username": target_un}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="No user with that username")
    if target["id"] == user["id"]:
        raise HTTPException(status_code=400, detail="You can't invite yourself")
    if target["id"] in (user.get("contact_ids") or []):
        raise HTTPException(status_code=409, detail="Already in your contacts")

    # Check for existing pending invitations either direction
    existing = await db.contact_invitations.find_one(
        {
            "status": "pending",
            "$or": [
                {"from_user_id": user["id"], "to_user_id": target["id"]},
                {"from_user_id": target["id"], "to_user_id": user["id"]},
            ],
        },
        {"_id": 0},
    )
    if existing:
        if existing["from_user_id"] == target["id"]:
            raise HTTPException(
                status_code=409,
                detail=f"{target.get('name') or target_un} has already sent you an invitation — accept it instead.",
            )
        raise HTTPException(status_code=409, detail="Invitation already pending")

    inv = {
        "id": str(uuid.uuid4()),
        "from_user_id": user["id"],
        "to_user_id": target["id"],
        "status": "pending",
        "created_at": now_utc().isoformat(),
        "responded_at": None,
    }
    await db.contact_invitations.insert_one(inv)
    inv.pop("_id", None)

    # Notify recipient via WS
    users_by_id = {user["id"]: user, target["id"]: target}
    payload_data = _public_invitation(inv, users_by_id)
    await broadcast_to_members(
        [target["id"]], {"type": "contact:invite", "data": payload_data}
    )

    # Push notification
    asyncio.create_task(_send_invite_push(target, user))

    return payload_data


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
                        "sound": sound,
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


@api.post("/contacts/invitations/{inv_id}/accept")
async def accept_invitation(inv_id: str, user: dict = Depends(get_current_user)):
    inv = await db.contact_invitations.find_one(
        {"id": inv_id, "to_user_id": user["id"], "status": "pending"}, {"_id": 0}
    )
    if not inv:
        raise HTTPException(status_code=404, detail="Invitation not found")

    await db.contact_invitations.update_one(
        {"id": inv_id},
        {"$set": {"status": "accepted", "responded_at": now_utc().isoformat()}},
    )

    # Mutually add to each other's contact_ids
    await db.users.update_one(
        {"id": user["id"]}, {"$addToSet": {"contact_ids": inv["from_user_id"]}}
    )
    await db.users.update_one(
        {"id": inv["from_user_id"]}, {"$addToSet": {"contact_ids": user["id"]}}
    )

    # Hydrate response
    other = await db.users.find_one({"id": inv["from_user_id"]}, {"_id": 0})
    fresh_inv = await db.contact_invitations.find_one({"id": inv_id}, {"_id": 0})
    users_by_id = {user["id"]: user, inv["from_user_id"]: other} if other else {}

    # Notify the inviter
    await broadcast_to_members(
        [inv["from_user_id"]],
        {"type": "contact:accepted", "data": _public_invitation(fresh_inv, users_by_id)},
    )
    # Push notify the inviter that their request was accepted
    asyncio.create_task(_send_push_to_user(
        inv["from_user_id"],
        title="✅ Contact accepted",
        body=f"{user.get('name') or '@' + user.get('username', '')} accepted your request",
        channel="notifications",
        sound="notification",
        data={
            "type": "contact_accepted",
            "from_user_id": user["id"],
            "screen": "contacts",
        },
        ttl_seconds=3600,
    ))

    return {"contact": public_user(other) if other else None}


@api.post("/contacts/invitations/{inv_id}/reject")
async def reject_invitation(inv_id: str, user: dict = Depends(get_current_user)):
    inv = await db.contact_invitations.find_one(
        {"id": inv_id, "to_user_id": user["id"], "status": "pending"}, {"_id": 0}
    )
    if not inv:
        raise HTTPException(status_code=404, detail="Invitation not found")
    await db.contact_invitations.update_one(
        {"id": inv_id},
        {"$set": {"status": "rejected", "responded_at": now_utc().isoformat()}},
    )
    await broadcast_to_members(
        [inv["from_user_id"]],
        {"type": "contact:rejected", "data": {"id": inv_id}},
    )
    return {"ok": True}


@api.delete("/contacts/invitations/{inv_id}")
async def cancel_invitation(inv_id: str, user: dict = Depends(get_current_user)):
    inv = await db.contact_invitations.find_one(
        {"id": inv_id, "from_user_id": user["id"], "status": "pending"}, {"_id": 0}
    )
    if not inv:
        raise HTTPException(status_code=404, detail="Invitation not found")
    await db.contact_invitations.delete_one({"id": inv_id})
    await broadcast_to_members(
        [inv["to_user_id"]],
        {"type": "contact:cancelled", "data": {"id": inv_id}},
    )
    return {"ok": True}


@api.delete("/contacts/{user_id}")
async def remove_contact(user_id: str, user: dict = Depends(get_current_user)):
    if user_id not in (user.get("contact_ids") or []):
        raise HTTPException(status_code=404, detail="Not in your contacts")
    await db.users.update_one({"id": user["id"]}, {"$pull": {"contact_ids": user_id}})
    await db.users.update_one({"id": user_id}, {"$pull": {"contact_ids": user["id"]}})
    return {"ok": True}


@api.patch("/users/me/status")
async def update_status(payload: StatusUpdateIn, user: dict = Depends(get_current_user)):
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {
            "status": payload.status,
            "custom_status": payload.custom_status or "",
            "last_seen": now_utc().isoformat(),
        }},
    )
    fresh = await db.users.find_one({"id": user["id"]}, {"_id": 0})
    return public_user(fresh)


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


@api.post("/conversations")
async def create_conversation(payload: ConversationCreateIn, user: dict = Depends(get_current_user)):
    member_ids = list(set(payload.member_ids + [user["id"]]))
    if len(member_ids) < 2:
        raise HTTPException(status_code=400, detail="At least 2 members required")

    # Enforce contact-only chats
    contact_ids = set(user.get("contact_ids") or [])
    target_ids = [m for m in member_ids if m != user["id"]]
    not_contacts = [m for m in target_ids if m not in contact_ids]
    if not_contacts:
        raise HTTPException(
            status_code=403,
            detail="You can only start chats with your contacts. Invite them first.",
        )
    for target_id in target_ids:
        await ensure_not_blocked_between(user, target_id, action="start a chat with")

    if payload.type == "direct":
        if len(member_ids) != 2:
            raise HTTPException(status_code=400, detail="Direct chat needs exactly 2 members")
        existing = await db.conversations.find_one({
            "type": "direct",
            "member_ids": {"$all": member_ids, "$size": 2},
        }, {"_id": 0})
        if existing:
            return await _hydrate_conversation(existing, user["id"])

    avatar = (payload.avatar or "").strip()
    if avatar and len(avatar) > 200_000:
        raise HTTPException(status_code=400, detail="Avatar too large (max ~150KB)")

    conv = {
        "id": str(uuid.uuid4()),
        "type": payload.type,
        "name": (payload.name or "").strip(),
        "member_ids": member_ids,
        "admin_ids": [user["id"]] if payload.type == "group" else [],
        "avatar": avatar or None,
        "created_by": user["id"],
        "created_at": now_utc().isoformat(),
    }
    await db.conversations.insert_one(conv)

    # Broadcast new conversation to all members so they refresh their list
    await broadcast_to_members(
        member_ids, {"type": "conversation:created", "data": {"id": conv["id"]}}
    )

    return await _hydrate_conversation(conv, user["id"])


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


@api.patch("/conversations/{conv_id}")
async def update_conversation(
    conv_id: str,
    payload: ConversationUpdateIn,
    user: dict = Depends(get_current_user),
):
    conv = await _require_group_admin(conv_id, user["id"])
    updates: dict = {}
    if payload.name is not None:
        updates["name"] = payload.name.strip()[:80]
    if payload.avatar is not None:
        av = (payload.avatar or "").strip()
        if av and len(av) > 200_000:
            raise HTTPException(status_code=400, detail="Avatar too large")
        updates["avatar"] = av or None
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    await db.conversations.update_one({"id": conv_id}, {"$set": updates})
    fresh = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    hydrated = await _hydrate_conversation(fresh, user["id"])

    # Insert system message
    sys_msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": conv_id,
        "sender_id": "system",
        "sender_name": "system",
        "kind": "system",
        "content": (
            f"{user.get('name') or 'A member'} updated the group info."
            if "name" in updates or "avatar" in updates else ""
        ),
        "created_at": now_utc().isoformat(),
        "read_by": [],
        "reactions": {},
    }
    if sys_msg["content"]:
        await db.messages.insert_one(sys_msg.copy())
        sys_msg.pop("_id", None)
        await broadcast_to_members(
            fresh["member_ids"], {"type": "message", "data": sys_msg}
        )
    await broadcast_to_members(
        fresh["member_ids"],
        {"type": "conversation:update", "data": hydrated},
    )
    return hydrated


@api.post("/conversations/{conv_id}/members")
async def add_group_members(
    conv_id: str,
    payload: GroupMembersIn,
    user: dict = Depends(get_current_user),
):
    """Any group member can invite new people from their own contacts. Only
    admins can edit name/photo or remove others (see other routes)."""
    conv = await db.conversations.find_one(
        {"id": conv_id, "member_ids": user["id"], "type": "group"}, {"_id": 0}
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Group not found")
    contact_ids = set(user.get("contact_ids") or [])
    current_members = set(conv.get("member_ids") or [])
    additions = []
    for mid in payload.member_ids:
        if mid in current_members:
            continue
        if mid not in contact_ids:
            raise HTTPException(
                status_code=403,
                detail="You can only add members from your contacts",
            )
        additions.append(mid)
    if not additions:
        raise HTTPException(status_code=400, detail="No new members to add")
    await db.conversations.update_one(
        {"id": conv_id},
        {"$addToSet": {"member_ids": {"$each": additions}}},
    )
    # Build names of added users for system message
    added_users = await db.users.find(
        {"id": {"$in": additions}}, {"_id": 0, "id": 1, "name": 1}
    ).to_list(50)
    names = ", ".join(u.get("name") or "?" for u in added_users)
    sys_msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": conv_id,
        "sender_id": "system",
        "sender_name": "system",
        "kind": "system",
        "content": f"{user.get('name') or 'A member'} added {names} to the group.",
        "created_at": now_utc().isoformat(),
        "read_by": [],
        "reactions": {},
    }
    await db.messages.insert_one(sys_msg.copy())
    sys_msg.pop("_id", None)
    fresh = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    hydrated = await _hydrate_conversation(fresh, user["id"])
    await broadcast_to_members(
        fresh["member_ids"], {"type": "message", "data": sys_msg}
    )
    await broadcast_to_members(
        fresh["member_ids"], {"type": "conversation:update", "data": hydrated}
    )
    # Push notify each newly added member
    group_name = fresh.get("name") or "a group"
    inviter_name = user.get("name") or "@" + user.get("username", "Admin")
    for new_member_id in additions:
        asyncio.create_task(_send_push_to_user(
            new_member_id,
            title="👥 Added to group",
            body=f"{inviter_name} added you to '{group_name}'",
            channel="messages",
            sound="message",
            data={
                "type": "group_added",
                "conversation_id": conv_id,
                "screen": "chat",
            },
            ttl_seconds=3600,
        ))
    return hydrated


@api.delete("/conversations/{conv_id}/members/{user_id}")
async def remove_group_member(
    conv_id: str, user_id: str, user: dict = Depends(get_current_user)
):
    conv = await db.conversations.find_one(
        {"id": conv_id, "member_ids": user["id"], "type": "group"}, {"_id": 0}
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Group not found")
    admin_ids = conv.get("admin_ids") or ([conv.get("created_by")] if conv.get("created_by") else [])
    is_admin = user["id"] in admin_ids
    is_self_leave = user_id == user["id"]
    if not is_admin and not is_self_leave:
        raise HTTPException(status_code=403, detail="Only admins can remove members")
    if user_id not in (conv.get("member_ids") or []):
        raise HTTPException(status_code=404, detail="User not in group")
    # Don't leave a group without any admin
    new_admin_ids = [a for a in admin_ids if a != user_id]
    new_member_ids = [m for m in (conv.get("member_ids") or []) if m != user_id]
    if not new_admin_ids and new_member_ids:
        # promote oldest remaining member to admin
        new_admin_ids = [new_member_ids[0]]
    await db.conversations.update_one(
        {"id": conv_id},
        {"$set": {"member_ids": new_member_ids, "admin_ids": new_admin_ids}},
    )
    target_user = await db.users.find_one({"id": user_id}, {"_id": 0, "name": 1})
    action = "left" if is_self_leave else f"was removed by {user.get('name') or 'admin'}"
    sys_msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": conv_id,
        "sender_id": "system",
        "sender_name": "system",
        "kind": "system",
        "content": f"{(target_user or {}).get('name') or 'A member'} {action}.",
        "created_at": now_utc().isoformat(),
        "read_by": [],
        "reactions": {},
    }
    await db.messages.insert_one(sys_msg.copy())
    sys_msg.pop("_id", None)
    fresh = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    hydrated = await _hydrate_conversation(fresh, user["id"]) if user["id"] in new_member_ids else None
    # Notify all (including the removed user so they can drop the chat locally)
    await broadcast_to_members(
        list(set(new_member_ids + [user_id])),
        {"type": "message", "data": sys_msg},
    )
    if hydrated:
        await broadcast_to_members(
            new_member_ids, {"type": "conversation:update", "data": hydrated}
        )
    await broadcast_to_members(
        [user_id], {"type": "conversation:removed", "data": {"id": conv_id}}
    )
    return {"ok": True}


@api.post("/conversations/{conv_id}/admins/{user_id}")
async def promote_admin(
    conv_id: str, user_id: str, user: dict = Depends(get_current_user)
):
    conv = await _require_group_admin(conv_id, user["id"])
    if user_id not in (conv.get("member_ids") or []):
        raise HTTPException(status_code=404, detail="User not in group")
    await db.conversations.update_one(
        {"id": conv_id}, {"$addToSet": {"admin_ids": user_id}}
    )
    fresh = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    hydrated = await _hydrate_conversation(fresh, user["id"])
    target = await db.users.find_one({"id": user_id}, {"_id": 0, "name": 1})
    sys_msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": conv_id,
        "sender_id": "system",
        "sender_name": "system",
        "kind": "system",
        "content": f"{(target or {}).get('name') or 'A member'} is now a group admin.",
        "created_at": now_utc().isoformat(),
        "read_by": [],
        "reactions": {},
    }
    await db.messages.insert_one(sys_msg.copy())
    sys_msg.pop("_id", None)
    await broadcast_to_members(
        fresh["member_ids"], {"type": "message", "data": sys_msg}
    )
    await broadcast_to_members(
        fresh["member_ids"], {"type": "conversation:update", "data": hydrated}
    )
    return hydrated


@api.delete("/conversations/{conv_id}/admins/{user_id}")
async def demote_admin(
    conv_id: str, user_id: str, user: dict = Depends(get_current_user)
):
    conv = await _require_group_admin(conv_id, user["id"])
    admin_ids = conv.get("admin_ids") or []
    if user_id not in admin_ids:
        raise HTTPException(status_code=404, detail="User is not an admin")
    if len(admin_ids) == 1:
        raise HTTPException(
            status_code=400,
            detail="Can't demote the last admin. Promote someone else first.",
        )
    await db.conversations.update_one(
        {"id": conv_id}, {"$pull": {"admin_ids": user_id}}
    )
    fresh = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    hydrated = await _hydrate_conversation(fresh, user["id"])
    await broadcast_to_members(
        fresh["member_ids"], {"type": "conversation:update", "data": hydrated}
    )
    return hydrated


@api.get("/conversations")
async def list_conversations(user: dict = Depends(get_current_user)):
    cursor = db.conversations.find(
        {"member_ids": user["id"]}, {"_id": 0}
    ).sort("created_at", -1)
    convs = [c async for c in cursor]
    hydrated = [await _hydrate_conversation(c, user["id"]) for c in convs]
    # sort by last message timestamp
    hydrated.sort(
        key=lambda c: (c["last_message"] or {}).get("created_at") or c["created_at"],
        reverse=True,
    )
    return hydrated


@api.get("/conversations/{conv_id}")
async def get_conversation(conv_id: str, user: dict = Depends(get_current_user)):
    conv = await db.conversations.find_one(
        {"id": conv_id, "member_ids": user["id"]}, {"_id": 0}
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return await _hydrate_conversation(conv, user["id"])


@api.patch("/conversations/{conv_id}/disappearing")
async def set_disappearing(conv_id: str, payload: DisappearingIn, user: dict = Depends(get_current_user)):
    conv = await db.conversations.find_one(
        {"id": conv_id, "member_ids": user["id"]}, {"_id": 0}
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    seconds = payload.seconds if payload.seconds and payload.seconds > 0 else None
    await db.conversations.update_one(
        {"id": conv_id}, {"$set": {"disappear_seconds": seconds}}
    )

    # Post a system message announcing the change
    if seconds:
        label = _human_duration(seconds)
        sys_text = f"{user.get('name', 'Someone')} set messages to disappear after {label}."
    else:
        sys_text = f"{user.get('name', 'Someone')} turned off disappearing messages."
    sys_msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": conv_id,
        "sender_id": "system",
        "sender_name": "System",
        "content": sys_text,
        "kind": "system",
        "reply_to": None,
        "attachment_id": None,
        "duration_ms": None,
        "reactions": {},
        "read_by": [],
        "created_at": now_utc().isoformat(),
        "encrypted": False,
    }
    await db.messages.insert_one(sys_msg)
    sys_msg.pop("_id", None)
    await broadcast_to_members(conv["member_ids"], {"type": "message", "data": sys_msg})
    await broadcast_to_members(
        conv["member_ids"],
        {"type": "conversation:update", "data": {"id": conv_id, "disappear_seconds": seconds}},
    )

    fresh = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    return await _hydrate_conversation(fresh, user["id"])


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


@api.get("/conversations/{conv_id}/messages")
async def list_messages(conv_id: str, user: dict = Depends(get_current_user)):
    conv = await db.conversations.find_one(
        {"id": conv_id, "member_ids": user["id"]}, {"_id": 0}
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    me = user["id"]
    member_ids = conv.get("member_ids") or []
    now = now_utc()
    now_iso = now.isoformat()

    # ---- PER-USER DISAPPEARING MESSAGES ----
    # Strategy:
    #   * Each disappearing message has a `read_at` map: { user_id: iso }.
    #   * When a non-sender opens the chat for the first time, we stamp
    #     `read_at[user_id] = now`. The message becomes invisible TO THAT USER
    #     after `disappear_seconds` from their own read time.
    #   * Other members get their own independent timer when THEY read.
    #   * Once every member's `read_at + disappear_seconds` has passed, the
    #     server fully deletes the message.
    #
    # We also broadcast `messages:expiring_started` containing this user's
    # per-user expiry so the sender's UI can show a countdown.

    # 1) Stamp `read_at[me]` for messages we haven't read yet AND that have a
    #    disappearing config. (We do this BEFORE the read_by update below.)
    to_stamp = await db.messages.find(
        {
            "conversation_id": conv_id,
            "sender_id": {"$ne": me},
            "disappear_seconds": {"$gt": 0},
            f"read_at.{me}": {"$exists": False},
        },
        {"_id": 0, "id": 1, "disappear_seconds": 1},
    ).to_list(2000)

    expiry_updates: List[dict] = []
    if to_stamp:
        from pymongo import UpdateOne
        ops = []
        for m in to_stamp:
            try:
                secs = int(m.get("disappear_seconds") or 0)
            except Exception:
                secs = 0
            if secs <= 0:
                continue
            my_expires = (now + timedelta(seconds=secs)).isoformat()
            ops.append(
                UpdateOne(
                    {"id": m["id"]},
                    {"$set": {f"read_at.{me}": now_iso}},
                )
            )
            expiry_updates.append({"id": m["id"], "expires_at": my_expires})
        if ops:
            try:
                await db.messages.bulk_write(ops, ordered=False)
            except Exception:
                pass

    # 2) Mark all unread as read (existing semantics).
    unread = await db.messages.find(
        {
            "conversation_id": conv_id,
            "sender_id": {"$ne": me},
            "read_by": {"$ne": me},
        },
        {"_id": 0, "id": 1},
    ).to_list(2000)
    await db.messages.update_many(
        {
            "conversation_id": conv_id,
            "sender_id": {"$ne": me},
            "read_by": {"$ne": me},
        },
        {"$addToSet": {"read_by": me}},
    )
    if unread:
        await broadcast_to_members(
            member_ids,
            {
                "type": "messages:read",
                "data": {
                    "conversation_id": conv_id,
                    "reader_id": me,
                    "message_ids": [message["id"] for message in unread],
                },
            },
            exclude=me,
        )

    # 3) Fetch messages. We pull ALL and then filter per-user expiry locally.
    raw = await db.messages.find(
        {"conversation_id": conv_id}, {"_id": 0}
    ).sort("created_at", 1).to_list(2000)

    # 4) Filter: hide messages that have already expired FOR ME.
    visible: List[dict] = []
    fully_dead_ids: List[str] = []
    for m in raw:
        one_time_seconds = int(m.get("one_time_seconds") or 0)
        one_time_viewed_at = (m.get("one_time_viewed_at") or {}).get(me)
        if one_time_seconds > 0 and one_time_viewed_at and me != m.get("sender_id"):
            try:
                viewed_dt = datetime.fromisoformat(
                    one_time_viewed_at.replace("Z", "+00:00")
                )
                one_time_expires = viewed_dt + timedelta(seconds=one_time_seconds)
                if now >= one_time_expires:
                    continue
                m["one_time_expires_at"] = one_time_expires.isoformat()
            except Exception:
                pass
        secs = m.get("disappear_seconds") or 0
        read_at = m.get("read_at") or {}
        # Compute per-user expiry helper
        def expired_for(uid: str) -> bool:
            r = read_at.get(uid)
            if not r:
                return False
            try:
                return (now - datetime.fromisoformat(r.replace("Z", "+00:00"))).total_seconds() > secs
            except Exception:
                return False

        # Has the message expired for ALL members? Then mark for deletion.
        if secs > 0 and member_ids and all(
            uid == m.get("sender_id") or expired_for(uid) for uid in member_ids
        ):
            # Sender doesn't have a read_at — exclude them from "all expired" check
            # by treating their slot as "ok to drop"; but only if every NON-sender
            # has read_at and is expired. We need at least one expired reader.
            non_sender_readers = [uid for uid in member_ids if uid != m.get("sender_id")]
            if non_sender_readers and all(expired_for(uid) for uid in non_sender_readers):
                fully_dead_ids.append(m["id"])
                continue  # don't return; also delete below
        # Hide from THIS user's response if expired for me.
        if secs > 0 and expired_for(me):
            continue
        # Annotate `expires_at` for this user so the client can show a countdown.
        if secs > 0 and read_at.get(me):
            try:
                r_dt = datetime.fromisoformat(read_at[me].replace("Z", "+00:00"))
                m["expires_at"] = (r_dt + timedelta(seconds=secs)).isoformat()
            except Exception:
                pass
        visible.append(m)

    # 5) Lazy server-side cleanup for fully-expired messages.
    if fully_dead_ids:
        try:
            await db.messages.delete_many({"id": {"$in": fully_dead_ids}})
        except Exception:
            pass

    # 6) Broadcast the new per-user expiry timestamps to the sender (so they
    #    see a countdown badge once we've read the message). Send to EVERYONE
    #    for simplicity; clients ignore items they don't have.
    if expiry_updates:
        try:
            await broadcast_to_members(
                member_ids,
                {
                    "type": "messages:expiring_started",
                    "data": {
                        "conversation_id": conv_id,
                        "reader_id": me,
                        "items": expiry_updates,
                    },
                },
                exclude=None,
            )
        except Exception:
            pass

    return [_normalize_message_dates(m) for m in visible]


@api.post("/messages")
async def send_message(payload: MessageSendIn, user: dict = Depends(get_current_user)):
    conv = await db.conversations.find_one(
        {"id": payload.conversation_id, "member_ids": user["id"]}, {"_id": 0}
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    await ensure_direct_conversation_not_blocked(conv, user, action="send messages to")

    e2ee_doc: Optional[dict] = None
    if not payload.e2ee:
        raise HTTPException(status_code=400, detail="Messages must be end-to-end encrypted")
    if payload.encrypted and not payload.e2ee:
        raise HTTPException(status_code=400, detail="Encrypted messages require an E2EE payload")
    if payload.e2ee:
        if payload.kind != "text":
            if payload.kind not in ("image", "voice", "file"):
                raise HTTPException(status_code=400, detail="E2EE v1 supports text and attachment messages only")
            if not payload.e2ee_attachment or not payload.attachment_id:
                raise HTTPException(status_code=400, detail="Encrypted attachments require E2EE attachment metadata")
        member_ids = set(conv.get("member_ids") or [])
        recipient_ids = set(payload.e2ee.recipients.keys())
        if recipient_ids != member_ids:
            raise HTTPException(status_code=400, detail="E2EE payload must include every conversation member")

        key_docs = await db.users.find(
            {"id": {"$in": list(member_ids)}},
            {"_id": 0, "id": 1, "e2ee_public_key": 1},
        ).to_list(100)
        keys_by_id = {doc["id"]: doc.get("e2ee_public_key") for doc in key_docs}
        if any(not keys_by_id.get(member_id) for member_id in member_ids):
            raise HTTPException(status_code=400, detail="Every member must register an E2EE key first")

        registered_public_key = (user.get("e2ee_public_key") or "").strip()
        sender_public_key = payload.e2ee.sender_public_key.strip()
        if not registered_public_key or registered_public_key != sender_public_key:
            raise HTTPException(
                status_code=400,
                detail="Register your E2EE public key before sending encrypted messages",
            )

        e2ee_doc = payload.e2ee.dict()
        e2ee_doc["sender_user_id"] = user["id"]

    e2ee_attachment_doc: Optional[dict] = None
    if payload.e2ee_attachment:
        if not e2ee_doc:
            raise HTTPException(status_code=400, detail="Encrypted attachment requires an encrypted message payload")
        if not payload.attachment_id:
            raise HTTPException(status_code=400, detail="Encrypted attachment requires an attachment")
        if payload.kind not in ("image", "voice", "file"):
            raise HTTPException(status_code=400, detail="Encrypted attachments support image, voice and file messages only")
        member_ids = set(conv.get("member_ids") or [])
        key_recipient_ids = set(payload.e2ee_attachment.key_recipients.keys())
        if key_recipient_ids != member_ids:
            raise HTTPException(status_code=400, detail="Encrypted attachment key payload must include every conversation member")
        e2ee_attachment_doc = payload.e2ee_attachment.dict()
    if payload.one_time_seconds and payload.kind != "image":
        raise HTTPException(status_code=400, detail="One-time viewing is supported only for images")

    if payload.attachment_id:
        att = await db.attachments.find_one(
            {"id": payload.attachment_id}, {"_id": 0, "id": 1, "owner_id": 1}
        )
        if not att:
            raise HTTPException(status_code=400, detail="Attachment not found")
        if att.get("owner_id") != user["id"]:
            raise HTTPException(
                status_code=403, detail="Cannot send another user's attachment"
            )
        existing_message = await db.messages.find_one(
            {"attachment_id": payload.attachment_id}, {"_id": 0, "id": 1}
        )
        if existing_message:
            raise HTTPException(status_code=409, detail="Attachment was already sent")
    msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": payload.conversation_id,
        "sender_id": user["id"],
        "sender_name": user.get("name", ""),
        "content": "[encrypted message]" if e2ee_doc else payload.content,
        "kind": payload.kind,
        "reply_to": payload.reply_to,
        "attachment_id": payload.attachment_id,
        "duration_ms": payload.duration_ms,
        "reactions": {},
        "read_by": [user["id"]],
        "created_at": now_utc().isoformat(),
        "encrypted": bool(e2ee_doc),
    }
    if payload.one_time_seconds:
        msg["one_time_seconds"] = int(payload.one_time_seconds)
        msg["one_time_viewed_at"] = {}
        msg["screenshot_by"] = []
    if e2ee_doc:
        msg["e2ee"] = e2ee_doc
        msg["e2ee_version"] = e2ee_doc.get("version", 1)
    if e2ee_attachment_doc:
        msg["e2ee_attachment"] = e2ee_attachment_doc
    # Disappearing messages: store the duration on the message, but do NOT set
    # `expires_at` yet. The countdown only starts when the *first* recipient
    # marks the message as read (see GET /conversations/{id}/messages above).
    disappear = conv.get("disappear_seconds")
    if disappear and disappear > 0:
        msg["disappear_seconds"] = int(disappear)
    await db.messages.insert_one(msg)
    msg.pop("_id", None)
    # ISO-serialize expires_at for the response/broadcast (only present if a
    # prior read already set it — not the case for a brand new message, but
    # we keep the guard for forward-compat).
    if "expires_at" in msg and isinstance(msg["expires_at"], datetime):
        msg["expires_at"] = msg["expires_at"].isoformat()

    # Broadcast over WebSocket to other members
    await broadcast_to_members(conv["member_ids"], {"type": "message", "data": msg}, exclude=user["id"])

    # Fire-and-forget Expo push to other members
    asyncio.create_task(_send_push_to_members(
        conv["member_ids"], user["id"], conv, msg
    ))

    return msg


@api.post("/messages/{msg_id}/open-once")
async def open_message_once(msg_id: str, user: dict = Depends(get_current_user)):
    msg = await db.messages.find_one({"id": msg_id}, {"_id": 0})
    if not msg or msg.get("kind") != "image" or not msg.get("one_time_seconds"):
        raise HTTPException(status_code=404, detail="One-time image not found")
    conv = await db.conversations.find_one(
        {"id": msg["conversation_id"], "member_ids": user["id"]}, {"_id": 0}
    )
    if not conv:
        raise HTTPException(status_code=403, detail="Not a member")
    if user["id"] == msg.get("sender_id"):
        raise HTTPException(status_code=400, detail="Sender cannot open their one-time image")

    now = now_utc()
    viewed = (msg.get("one_time_viewed_at") or {}).get(user["id"])
    if viewed:
        viewed_dt = datetime.fromisoformat(viewed.replace("Z", "+00:00"))
        expires_at = viewed_dt + timedelta(seconds=int(msg["one_time_seconds"]))
        if now >= expires_at:
            raise HTTPException(status_code=410, detail="One-time image expired")
    else:
        viewed = now.isoformat()
        expires_at = now + timedelta(seconds=int(msg["one_time_seconds"]))
        await db.messages.update_one(
            {"id": msg_id}, {"$set": {f"one_time_viewed_at.{user['id']}": viewed}}
        )
        await broadcast_to_members(
            conv["member_ids"],
            {
                "type": "message:opened_once",
                "data": {
                    "conversation_id": msg["conversation_id"],
                    "message_id": msg_id,
                    "viewer_id": user["id"],
                    "expires_at": expires_at.isoformat(),
                },
            },
            exclude=None,
        )
    return {"expires_at": expires_at.isoformat()}


@api.post("/messages/{msg_id}/screenshot")
async def report_message_screenshot(msg_id: str, user: dict = Depends(get_current_user)):
    msg = await db.messages.find_one({"id": msg_id}, {"_id": 0})
    if not msg or not msg.get("one_time_seconds"):
        raise HTTPException(status_code=404, detail="One-time image not found")
    conv = await db.conversations.find_one(
        {"id": msg["conversation_id"], "member_ids": user["id"]}, {"_id": 0}
    )
    if not conv:
        raise HTTPException(status_code=403, detail="Not a member")
    if user["id"] == msg.get("sender_id"):
        raise HTTPException(status_code=400, detail="Sender cannot report a screenshot")
    viewed = (msg.get("one_time_viewed_at") or {}).get(user["id"])
    if not viewed:
        raise HTTPException(status_code=400, detail="Open the one-time image first")
    viewed_dt = datetime.fromisoformat(viewed.replace("Z", "+00:00"))
    if now_utc() >= viewed_dt + timedelta(seconds=int(msg["one_time_seconds"])):
        raise HTTPException(status_code=410, detail="One-time image expired")
    if user["id"] in set(msg.get("screenshot_by") or []):
        return {"reported": True}

    await db.messages.update_one({"id": msg_id}, {"$addToSet": {"screenshot_by": user["id"]}})
    system_msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": msg["conversation_id"],
        "sender_id": "system",
        "sender_name": "system",
        "kind": "system",
        "content": f"{user.get('name') or user.get('username') or 'User'} made a screenshot of a one-time photo.",
        "attachment_id": None,
        "reactions": {},
        "read_by": [user["id"]],
        "created_at": now_utc().isoformat(),
        "encrypted": False,
    }
    await db.messages.insert_one(system_msg)
    system_msg.pop("_id", None)
    await broadcast_to_members(
        conv["member_ids"], {"type": "message", "data": system_msg}, exclude=None
    )
    return {"reported": True}


@api.post("/messages/{msg_id}/reactions")
async def react(msg_id: str, payload: ReactionIn, user: dict = Depends(get_current_user)):
    msg = await db.messages.find_one({"id": msg_id}, {"_id": 0})
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    conv = await db.conversations.find_one(
        {"id": msg["conversation_id"], "member_ids": user["id"]}, {"_id": 0}
    )
    if not conv:
        raise HTTPException(status_code=403, detail="Not a member")

    reactions = msg.get("reactions", {}) or {}
    users_for_emoji = set(reactions.get(payload.emoji, []))
    if user["id"] in users_for_emoji:
        users_for_emoji.discard(user["id"])
    else:
        users_for_emoji.add(user["id"])
    if users_for_emoji:
        reactions[payload.emoji] = list(users_for_emoji)
    else:
        reactions.pop(payload.emoji, None)
    await db.messages.update_one({"id": msg_id}, {"$set": {"reactions": reactions}})
    msg["reactions"] = reactions
    return msg


@api.delete("/messages/{msg_id}")
async def delete_message(msg_id: str, user: dict = Depends(get_current_user)):
    msg = await db.messages.find_one({"id": msg_id}, {"_id": 0})
    if not msg:
        raise HTTPException(status_code=404, detail="Not found")
    if msg["sender_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Cannot delete others' messages")
    await db.messages.delete_one({"id": msg_id})
    # Broadcast to other members so their UIs update in real time.
    try:
        conv = await db.conversations.find_one(
            {"id": msg.get("conversation_id")}, {"_id": 0, "member_ids": 1}
        )
        if conv:
            await broadcast_to_members(
                conv.get("member_ids") or [],
                {
                    "type": "message:deleted",
                    "data": {
                        "id": msg_id,
                        "conversation_id": msg.get("conversation_id"),
                    },
                },
                exclude=None,
            )
    except Exception:
        pass
    return {"deleted": True}


@api.delete("/conversations/{conv_id}")
async def delete_conversation_for_me(
    conv_id: str, user: dict = Depends(get_current_user)
):
    """Hide a conversation from this user only.

    - Direct chats: removes the user from `member_ids`. The peer keeps their
      copy. If the user is the last member left, the conversation and its
      messages are fully deleted.
    - Group chats: user "leaves" the group (same `member_ids.pull` semantics
      as `/conversations/{id}/members/{user_id}` DELETE). Other members keep
      the chat. A system message is posted in the group.
    """
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if user["id"] not in (conv.get("member_ids") or []):
        raise HTTPException(status_code=403, detail="Not a participant")

    is_group = conv.get("type") == "group"
    await db.conversations.update_one(
        {"id": conv_id},
        {
            "$pull": {"member_ids": user["id"], "admin_ids": user["id"]},
            "$unset": {f"unread_counts.{user['id']}": ""},
        },
    )
    # Re-fetch to see remaining members
    fresh = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    remaining = (fresh or {}).get("member_ids") or []

    if not remaining:
        # Nobody left — fully delete the conversation and its messages.
        await db.messages.delete_many({"conversation_id": conv_id})
        await db.conversations.delete_one({"id": conv_id})
        return {"deleted": True, "fully_deleted": True}

    # Notify remaining members so their UIs refresh
    try:
        if is_group:
            sys_msg = {
                "id": str(uuid.uuid4()),
                "conversation_id": conv_id,
                "sender_id": "system",
                "sender_name": "System",
                "kind": "system",
                "content": f"{user.get('name', 'Someone')} left the group.",
                "created_at": now_utc().isoformat(),
                "reactions": {},
            }
            await db.messages.insert_one(sys_msg.copy())
            sys_msg.pop("_id", None)
            await broadcast_to_members(
                remaining,
                {"type": "message:new", "data": sys_msg, "conversation_id": conv_id},
                exclude=None,
            )
        await broadcast_to_members(
            remaining,
            {"type": "conversation:update", "data": {"id": conv_id}},
            exclude=None,
        )
    except Exception:
        pass

    return {"deleted": True, "fully_deleted": False}


# ----------------- User mute (per-user notification mute) -----------------
class MuteUserIn(BaseModel):
    # Duration in seconds (max 30 days). `None` or 0 means "forever".
    duration_seconds: Optional[int] = None


@api.get("/users/{user_id}")
async def get_user_profile(user_id: str, user: dict = Depends(get_current_user)):
    """Return public profile of any user (no role restriction). Excludes secrets."""
    other = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not other:
        raise HTTPException(status_code=404, detail="User not found")
    result = public_user(other)
    # Augment with relationship hints so the frontend can show right actions.
    is_blocked = user_id in (user.get("blocked_user_ids") or [])
    is_blocking_me = user["id"] in (other.get("blocked_user_ids") or [])
    is_contact = user_id in (user.get("contact_ids") or [])
    muted_users = user.get("muted_users") or {}
    muted_info = muted_users.get(user_id)
    result["is_blocked"] = is_blocked
    result["is_blocking_me"] = is_blocking_me
    result["is_contact"] = is_contact
    result["muted_until"] = muted_info.get("until") if isinstance(muted_info, dict) else None
    result["muted"] = bool(muted_info)
    return result


@api.post("/users/me/mute_user/{target_id}")
async def mute_user(
    target_id: str,
    payload: MuteUserIn,
    user: dict = Depends(get_current_user),
):
    """Mute notifications from `target_id` for an optional duration."""
    if target_id == user["id"]:
        raise HTTPException(status_code=400, detail="Cannot mute yourself")
    target = await db.users.find_one({"id": target_id}, {"_id": 0, "id": 1})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    until_iso: Optional[str] = None
    if payload.duration_seconds and payload.duration_seconds > 0:
        # Cap at 30 days
        secs = min(int(payload.duration_seconds), 30 * 24 * 3600)
        until_iso = (now_utc() + timedelta(seconds=secs)).isoformat()
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {f"muted_users.{target_id}": {"until": until_iso}}},
    )
    return {"muted": True, "until": until_iso}


@api.delete("/users/me/mute_user/{target_id}")
async def unmute_user(target_id: str, user: dict = Depends(get_current_user)):
    await db.users.update_one(
        {"id": user["id"]},
        {"$unset": {f"muted_users.{target_id}": ""}},
    )
    return {"muted": False}


@api.get("/search")
async def search_messages(q: str, user: dict = Depends(get_current_user)):
    if not q or len(q) < 2:
        return []
    convs = await db.conversations.find(
        {"member_ids": user["id"]}, {"_id": 0, "id": 1}
    ).to_list(1000)
    conv_ids = [c["id"] for c in convs]
    cursor = db.messages.find(
        {
            "conversation_id": {"$in": conv_ids},
            "e2ee": {"$exists": False},
            "content": {"$regex": q, "$options": "i"},
        },
        {"_id": 0},
    ).sort("created_at", -1).limit(50)
    return [m async for m in cursor]


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


@api.get("/admin/users")
async def admin_list_users(
    admin: dict = Depends(require_admin),
    limit: int = 200,
    skip: int = 0,
):
    limit = max(1, min(limit, 500))
    skip = max(0, skip)
    cursor = (
        db.users.find({}, {"_id": 0})
        .sort("created_at", -1)
        .skip(skip)
        .limit(limit)
    )
    return [admin_user(u) async for u in cursor]


@api.get("/admin/stats")
async def admin_stats(admin: dict = Depends(require_admin)):
    users = await db.users.count_documents({})
    convs = await db.conversations.count_documents({})
    msgs = await db.messages.count_documents({})
    online = await db.users.count_documents({"status": "online"})
    twofa = await db.users.count_documents({"two_factor_enabled": True})
    push_ready = await db.users.count_documents(
        {
            "$or": [
                {"push_tokens.0": {"$exists": True}},
                {"push_token": {"$exists": True, "$ne": None}},
                {"expo_push_token": {"$exists": True, "$ne": None}},
            ]
        }
    )
    return {
        "users": users,
        "conversations": convs,
        "messages": msgs,
        "online": online,
        "two_factor_enabled": twofa,
        "push_ready": push_ready,
    }


@api.patch("/admin/users/{user_id}/role")
async def admin_update_role(user_id: str, payload: RoleUpdateIn, admin: dict = Depends(require_admin)):
    if user_id == admin["id"] and payload.role != "admin":
        raise HTTPException(status_code=400, detail="Cannot demote yourself")
    result = await db.users.update_one({"id": user_id}, {"$set": {"role": payload.role}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    fresh = await db.users.find_one({"id": user_id}, {"_id": 0})
    return admin_user(fresh)


@api.delete("/admin/users/{user_id}")
async def admin_delete_user(user_id: str, admin: dict = Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    deleted = await delete_user_account_data(user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="User not found")
    return {"deleted": True}


# ----------------- Uploads (base64 attachments) -----------------
@api.post("/uploads")
async def upload_attachment(payload: UploadIn, user: dict = Depends(get_current_user)):
    try:
        decoded = base64.b64decode(payload.data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="Invalid base64 payload")

    real_size = len(decoded)
    max_size = 8 * 1024 * 1024
    if real_size > max_size:
        raise HTTPException(status_code=413, detail="File too large (max 8MB)")

    filename = Path(payload.filename).name.strip()[:200] or "attachment"
    if payload.mime != "application/octet-stream" or not filename.endswith(".ghostel"):
        raise HTTPException(status_code=400, detail="Attachments must be encrypted before upload")
    att = {
        "id": str(uuid.uuid4()),
        "owner_id": user["id"],
        "filename": filename,
        "mime": payload.mime,
        "data": payload.data,  # base64
        "size": real_size,
        "created_at": now_utc().isoformat(),
    }
    await db.attachments.insert_one(att)
    return {"id": att["id"], "filename": att["filename"], "mime": att["mime"], "size": att["size"]}


@api.get("/uploads/{att_id}")
async def get_attachment(att_id: str, user: dict = Depends(get_current_user)):
    att = await db.attachments.find_one({"id": att_id}, {"_id": 0})
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    if att.get("owner_id") != user["id"]:
        msg = await db.messages.find_one({"attachment_id": att_id}, {"_id": 0})
        if not msg:
            raise HTTPException(status_code=403, detail="Attachment not accessible")
        conv = await db.conversations.find_one(
            {"id": msg.get("conversation_id"), "member_ids": user["id"]},
            {"_id": 0, "id": 1},
        )
        if not conv:
            raise HTTPException(status_code=403, detail="Attachment not accessible")
        one_time_seconds = int(msg.get("one_time_seconds") or 0)
        if one_time_seconds:
            viewed = (msg.get("one_time_viewed_at") or {}).get(user["id"])
            if not viewed:
                raise HTTPException(status_code=403, detail="Open the one-time image first")
            try:
                viewed_at = datetime.fromisoformat(viewed.replace("Z", "+00:00"))
            except (TypeError, ValueError):
                raise HTTPException(status_code=410, detail="One-time image expired")
            if now_utc() >= viewed_at + timedelta(seconds=one_time_seconds):
                raise HTTPException(status_code=410, detail="One-time image expired")
    return att


# ----------------- Push (Direct FCM HTTP v1 — bypasses Expo Push) -----------------
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"  # legacy, retained for /push/test


@api.get("/push/status")
async def push_status(admin: dict = Depends(require_admin)):
    """Returns FCM configuration status — useful to verify Service Account loaded."""
    from fcm import is_configured
    return {
        "fcm_configured": is_configured(),
    }


@api.post("/push/register")
async def register_push_token(payload: PushTokenIn, user: dict = Depends(get_current_user)):
    token = (payload.token or "").strip()
    platform = (payload.platform or "").strip()
    raw_type = (payload.token_type or "fcm").strip().lower()
    # Normalize Expo-style names to canonical FCM/APNS:
    _TYPE_MAP = {"android": "fcm", "ios": "apns"}
    token_type = _TYPE_MAP.get(raw_type, raw_type)
    if not token:
        logger.warning(
            f"Push registration with empty token from user {user.get('email')} platform={platform!r}"
        )
        raise HTTPException(
            status_code=400,
            detail="Empty push token.",
        )
    token_entry = {
        "token": token,
        "token_type": token_type,
        "platform": platform or "unknown",
        "device_model": (payload.device_model or "").strip()[:120],
        "os_version": (payload.os_version or "").strip()[:80],
        "source": (payload.source or "").strip()[:80],
        "registered_at": now_utc().isoformat(),
    }
    await db.users.update_one(
        {"id": user["id"]},
        {"$pull": {"push_tokens": {"token": token}}},
    )
    await db.users.update_one(
        {"id": user["id"]},
        {
            "$set": {
                "expo_push_token": token,  # backwards compat
                "push_token": token,
                "push_token_type": token_type,
                "push_platform": platform or "unknown",
            },
            "$addToSet": {"push_tokens": token_entry},
        },
    )
    logger.info(
        f"Push token registered for {user.get('email')} type={token_type} (raw={raw_type}) platform={platform} token={token[:25]}..."
    )
    return {"registered": True, "platform": platform, "token_type": token_type}


@api.get("/push/devices")
async def list_push_devices(user: dict = Depends(get_current_user)):
    """Return masked push-token registrations for the current account."""
    devices = []
    for idx, target in enumerate(user_push_targets(user), start=1):
        token = target.get("token") or ""
        devices.append(
            {
                "id": idx,
                "platform": target.get("platform") or "unknown",
                "token_type": target.get("token_type") or "unknown",
                "token_prefix": token[:18],
                "token_suffix": token[-6:] if len(token) > 6 else "",
                "device_model": target.get("device_model") or "",
                "os_version": target.get("os_version") or "",
                "source": target.get("source") or "",
                "registered_at": target.get("registered_at") or "",
            }
        )
    return {
        "count": len(devices),
        "devices": devices,
        "last_diag": user.get("push_diag") or None,
    }


@api.post("/push/unregister")
async def unregister_push(user: dict = Depends(get_current_user)):
    await db.users.update_one(
        {"id": user["id"]},
        {
            "$unset": {
                "expo_push_token": "",
                "push_platform": "",
                "push_token": "",
                "push_token_type": "",
            },
            "$set": {"push_tokens": []},
        },
    )
    return {"unregistered": True}


@api.post("/push/diag")
async def push_diag(
    request: Request,
    payload: dict = Body(default_factory=dict),
    user: dict = Depends(get_current_user),
):
    """Receives diagnostic payload from client when push registration fails or succeeds.
    Used to debug 'why isn't push working on user X?' on production."""
    try:
        await enforce_rate_limit(
            "push-diag-user", user["id"], limit=20, window_seconds=60 * 60
        )
        allowed = {
            "platform", "reason", "is_expo_go", "is_device", "device_model",
            "os_version", "channels_configured", "permission_initial",
            "permission_final", "firebase_permission", "token_source",
            "token_type", "token_prefix", "expo_device_token_error",
            "expo_push_token_error", "expo_project_id",
            "firebase_remote_registered", "firebase_token_error",
            "register_error", "error", "token_resp",
        }
        sanitized = {}
        for key, value in payload.items():
            if key not in allowed or not isinstance(value, (str, bool, int, float, type(None))):
                continue
            sanitized[key] = value[:300] if isinstance(value, str) else value
        if len(json.dumps(sanitized)) > 4096:
            raise HTTPException(status_code=413, detail="Diagnostic payload too large")
        # Store last diag on user doc (overwrite previous)
        await db.users.update_one(
            {"id": user["id"]},
            {"$set": {"push_diag": {"at": now_utc().isoformat(), **sanitized}}},
        )
        reason = sanitized.get("reason", "unknown")
        # Log clearly to backend logs
        logger.info(f"PushDiag user_id={user.get('id')} reason={reason}")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"push_diag store error: {e}")
    return {"received": True}


@api.post("/push/test")
async def send_test_push(
    payload: dict = Body(default_factory=dict),
    user: dict = Depends(get_current_user),
):
    """Sends a test push to the current user. Uses direct FCM.
    Optional body: {"kind": "call" | "message" | "notification"}"""
    from fcm import is_configured as fcm_is_configured, send_fcm, get_config_error

    targets = user_push_targets(user)
    if not targets:
        return {
            "sent": False,
            "reason": "no_token",
            "hint": "Open the app on your device and grant notification permissions. The push_token should auto-register on next login.",
        }
    kind = (payload.get("kind") if isinstance(payload, dict) else None) or "notification"
    if kind not in ("call", "message", "notification"):
        kind = "notification"

    if kind == "call":
        title = "📞 Test incoming call"
        body = "This is a test push (call channel)"
        channel = "calls"
        sound = "ringtone"
    elif kind == "message":
        title = "💬 Test message"
        body = "This is a test push (messages channel)"
        channel = "messages"
        sound = "message"
    else:
        title = "🔔 Test notification"
        body = "Push notifications are working correctly!"
        channel = "notifications"
        sound = "notification"

    result: dict = {
        "kind": kind,
        "channel": channel,
        "registered_tokens": len(targets),
        "sent_count": 0,
        "failed_count": 0,
        "targets": [],
    }

    fcm_targets = [t for t in targets if (t.get("token_type") or "fcm") in ("fcm", "apns")]
    expo_targets = [t for t in targets if (t.get("token_type") or "") == "expo"]

    if fcm_targets:
        if not fcm_is_configured():
            result["sent"] = False
            result["error"] = "fcm_not_configured"
            result["detail"] = get_config_error()
            return result
        push_data = {"type": "test", "kind": kind, "push_kind": kind}
        if kind == "call":
            test_call_id = str(uuid.uuid4())
            push_data = {
                "type": "incoming_call",
                "kind": "call",
                "push_kind": "call",
                "screen": "call",
                "call_id": test_call_id,
                "message_id": test_call_id,
                "conversation_id": "",
                "caller_id": "ghostel-test",
                "caller_name": "ghostel.app Test",
                "mode": "audio",
            }
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                for target in fcm_targets:
                    token = target["token"]
                    fcm_res = await send_fcm(
                        client,
                        token=token,
                        title=title,
                        body=body,
                        channel_id=channel,
                        sound=sound,
                        priority="high",
                        ttl_seconds=30,
                        data=push_data,
                        is_call=(kind == "call"),
                    )
                    ok = bool(fcm_res.get("ok"))
                    result["sent_count" if ok else "failed_count"] += 1
                    target_result = {
                        "token_type": target.get("token_type"),
                        "platform": target.get("platform"),
                        "device_model": target.get("device_model") or "",
                        "token_prefix": token[:18],
                        "ok": ok,
                    }
                    if not ok:
                        target_result["error"] = fcm_res.get("fcm_error_code") or fcm_res.get("error")
                    result["targets"].append(target_result)
                    if not ok and fcm_res.get("fcm_error_code") in (
                        "UNREGISTERED",
                        "INVALID_ARGUMENT",
                        "NOT_FOUND",
                    ):
                        await db.users.update_one(
                            {"id": user["id"]},
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
                        target_result["token_cleared"] = True
        except Exception as e:
            result["failed_count"] += len(fcm_targets)
            result["error"] = str(e)

    # Legacy Expo token path
    if expo_targets:
        msg_payload = [
            {
                "to": target["token"],
                "title": title,
                "body": body,
                "sound": sound,
                "priority": "high",
                "channelId": channel,
                "ttl": 30,
                "data": {"type": "test", "kind": kind},
            }
            for target in expo_targets
        ]
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(EXPO_PUSH_URL, json=msg_payload)
                try:
                    data = resp.json()
                except Exception:
                    data = None
                result["expo_status_code"] = resp.status_code
                if resp.status_code in (200, 201):
                    tickets = data.get("data", []) if isinstance(data, dict) else []
                    for target, ticket in zip(expo_targets, tickets):
                        ok = isinstance(ticket, dict) and ticket.get("status") == "ok"
                        result["sent_count" if ok else "failed_count"] += 1
                        result["targets"].append(
                            {
                                "token_type": "expo",
                                "platform": target.get("platform"),
                                "device_model": target.get("device_model") or "",
                                "token_prefix": target["token"][:18],
                                "ok": ok,
                                "error": None if ok else ticket.get("message") if isinstance(ticket, dict) else "expo_failed",
                            }
                        )
                    if len(tickets) < len(expo_targets):
                        result["failed_count"] += len(expo_targets) - len(tickets)
                else:
                    result["failed_count"] += len(expo_targets)
                    result["expo_response"] = data
        except Exception as e:
            result["failed_count"] += len(expo_targets)
            result["error"] = str(e)
    result["sent"] = result["sent_count"] > 0 and result["failed_count"] == 0
    return result


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
        title = conv.get("name") or "New message"
        if conv.get("type") == "direct":
            title = msg.get("sender_name", "New message")
        if is_call:
            title = f"📞 {msg.get('sender_name', 'Someone')} is calling"
        body_preview = msg.get("content", "")
        if msg.get("e2ee"):
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
            "sender_name": msg.get("sender_name", ""),
            # Caller-specific fields used by react-native-callkeep to render
            # the native OS-level incoming-call screen on the lockscreen.
            "caller_id": msg.get("caller_id", sender_id) if is_call else "",
            "caller_name": msg.get("sender_name", "") if is_call else "",
            # caller_avatar intentionally omitted — too big for FCM 4KB limit.
            "mode": msg.get("mode", "audio") if is_call else "",
        }

        # Split all registered devices by token type. A user may be logged in
        # on multiple phones, so never rely on the legacy single push_token.
        push_targets: list[dict] = []
        for r in recipients:
            for target in user_push_targets(r):
                push_targets.append({**target, "user_id": r.get("id")})
        fcm_recipients = [
            r for r in push_targets if (r.get("token_type") or "fcm") in ("fcm", "apns")
        ]
        expo_recipients = [r for r in push_targets if r.get("token_type") == "expo"]

        # ---- Direct FCM path ----
        fcm_ok = fcm_err = 0
        if fcm_recipients and fcm_is_configured():
            async with httpx.AsyncClient(timeout=10) as client:
                for r in fcm_recipients:
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
                    else:
                        fcm_err += 1
                        err_code = result.get("fcm_error_code") or result.get("error", "unknown")
                        logger.warning(
                            f"FCM send failed for token={token[:30]}... err={err_code} msg={result.get('message', '')[:120]}"
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

        # ---- Legacy Expo Push fallback ----
        if expo_recipients:
            messages_payload = [
                {
                    "to": r["token"],
                    "title": title,
                    "body": body_preview,
                    "sound": sound,
                    "priority": "high",
                    "channelId": channel_id,
                    "ttl": ttl_sec,
                    "data": common_data,
                }
                for r in expo_recipients
            ]
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    resp = await client.post(EXPO_PUSH_URL, json=messages_payload)
                    if resp.status_code < 400:
                        logger.info(
                            f"Expo push (legacy): {len(messages_payload)} sent"
                        )
            except Exception as exc:
                logger.warning(f"Expo push (legacy) failed: {exc}")
    except Exception as exc:
        logger.warning(f"_send_push_to_members failed: {exc}")


# ----------------- Calls (signaling + record) -----------------
# ICE servers cache (TTL 50min — Cloudflare creds valid 1h, refresh every 50min)
_ice_cache = {"servers": None, "source": None, "expires_at": 0.0}
import time as _time


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


@api.get("/calls/ice-servers")
async def get_ice_servers(user: dict = Depends(get_current_user)):
    """Return ICE servers for WebRTC with relay diagnostics."""
    now = _time.time()
    if _ice_cache["servers"] and now < _ice_cache["expires_at"]:
        return {
            "iceServers": _ice_cache["servers"],
            "source": _ice_cache["source"],
            "relayAvailable": True,
        }

    configured = _configured_turn_servers()
    if configured:
        servers = list(configured) + list(_GOOGLE_STUN_SERVERS)
        source = "configured"
    elif cf := await _fetch_cloudflare_ice_servers():
        servers = list(cf)
        servers.extend(_GOOGLE_STUN_SERVERS)
        source = "cloudflare"
    else:
        servers = list(_GOOGLE_STUN_SERVERS) + list(_OPEN_RELAY_SERVERS)
        source = "public-fallback"

    _ice_cache["servers"] = servers
    _ice_cache["source"] = source
    _ice_cache["expires_at"] = now + 50 * 60  # 50 minutes
    return {"iceServers": servers, "source": source, "relayAvailable": True}


@api.post("/calls/start")
async def start_call(payload: CallStartIn, user: dict = Depends(get_current_user)):
    conv = await db.conversations.find_one(
        {"id": payload.conversation_id, "member_ids": user["id"]}, {"_id": 0}
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    await ensure_direct_conversation_not_blocked(conv, user, action="call")
    members = await require_conversation_e2ee_ready(conv, action="Calls")
    member_keys = {
        m["id"]: {
            "public_key": m.get("e2ee_public_key"),
            "name": m.get("name") or m.get("username") or m["id"],
        }
        for m in members
    }
    call = {
        "id": str(uuid.uuid4()),
        "conversation_id": conv["id"],
        "caller_id": user["id"],
        "caller_name": user.get("name", ""),
        "member_ids": conv["member_ids"],
        "mode": payload.mode,
        "status": "ringing",
        "started_at": now_utc().isoformat(),
        "answered_at": None,
        "ended_at": None,
        "duration_sec": 0,
        "encrypted": True,
        "e2ee_required": True,
        "e2ee_media": "webrtc-dtls-srtp",
        "e2ee_member_keys": member_keys,
    }

    # Active signaling requires the call to be queryable by both peers. Calls
    # with history disabled are stored only for their active lifetime.
    caller_save = user.get("save_call_history")
    if caller_save is None:
        caller_save = True
    if not caller_save:
        call["ephemeral"] = True
    await db.calls.insert_one(call)
    call.pop("_id", None)

    # notify other members
    await broadcast_to_members(
        conv["member_ids"],
        {"type": "call:incoming", "data": call},
        exclude=user["id"],
    )
    # push notification "Incoming call"
    asyncio.create_task(_send_push_to_members(
        conv["member_ids"], user["id"], conv,
        {"sender_name": user.get("name", "Someone"), "kind": "call",
         "content": f"Incoming {payload.mode} call", "id": call["id"],
         "caller_id": user["id"],
         "caller_avatar": user.get("avatar", ""),
         "mode": payload.mode}
    ))
    return call


@api.post("/calls/{call_id}/accept")
async def accept_call(call_id: str, user: dict = Depends(get_current_user)):
    """Callee marks the call as accepted — sets answered_at so it doesn't
    count as missed."""
    call = await db.calls.find_one({"id": call_id}, {"_id": 0})
    if not call:
        return {"accepted": True, "ephemeral": True}
    if user["id"] not in call.get("member_ids", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    if call.get("answered_at"):
        return {"accepted": True}
    await db.calls.update_one(
        {"id": call_id},
        {"$set": {"status": "answered", "answered_at": now_utc().isoformat()}},
    )
    return {"accepted": True}


@api.post("/calls/{call_id}/signals")
async def persist_call_signal(
    call_id: str,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """Persist encrypted WebRTC signaling briefly as a WebSocket fallback."""
    signal_type = str(payload.get("type") or "")
    allowed = {
        "call:offer", "call:answer", "call:ice", "call:ready",
        "call:accept", "call:reject", "call:end", "call:cancel",
    }
    target = str(payload.get("to") or "")
    if signal_type not in allowed or not target:
        raise HTTPException(status_code=400, detail="Invalid call signal")
    signal = {**payload, "call_id": call_id}
    if signal_type in {"call:offer", "call:answer", "call:ice"}:
        if not signal.get("encrypted") or not isinstance(signal.get("e2ee_signal"), dict):
            raise HTTPException(status_code=400, detail="Call signal must be encrypted")
        signal.pop("sdp", None)
        signal.pop("candidate", None)
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
                "created_at": now_utc().isoformat(),
            }
        },
        upsert=True,
    )
    await ws_manager.send_to(target, forwarded)
    return {"stored": True, "signal_id": signal_id}


@api.get("/calls/{call_id}/signals")
async def list_call_signals(call_id: str, user: dict = Depends(get_current_user)):
    """Return recent signaling addressed to this participant."""
    call = await db.calls.find_one({"id": call_id}, {"_id": 0, "member_ids": 1})
    if not call:
        raise HTTPException(status_code=404, detail="Call not found")
    if user["id"] not in call.get("member_ids", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    return await (
        db.call_signals.find(
            {"call_id": call_id, "to": user["id"]},
            {"_id": 0},
        )
        .sort("created_at", 1)
        .limit(500)
        .to_list(500)
    )


@api.post("/calls/{call_id}/end")
async def end_call(call_id: str, user: dict = Depends(get_current_user)):
    call = await db.calls.find_one({"id": call_id}, {"_id": 0})
    if not call:
        return {"ended": True, "ephemeral": True}
    if user["id"] not in call.get("member_ids", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    ended_iso = now_utc().isoformat()
    update_doc: dict = {"ended_at": ended_iso, "ended_by": user["id"]}
    answered = call.get("answered_at")
    if answered:
        try:
            ans_dt = datetime.fromisoformat(answered)
            end_dt = datetime.fromisoformat(ended_iso)
            duration = max(0, int((end_dt - ans_dt).total_seconds()))
            update_doc["duration_sec"] = duration
            update_doc["status"] = "ended"
        except Exception:
            update_doc["status"] = "ended"
    else:
        # Never answered. If the caller ends it, it is a cancellation; if the
        # callee ends it, it is an explicit rejection rather than a missed call.
        update_doc["status"] = "cancelled" if user["id"] == call.get("caller_id") else "rejected"
    await db.calls.update_one({"id": call_id}, {"$set": update_doc})
    ended_event = {
        "type": "call:ended",
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


@api.get("/calls")
async def list_calls(
    user: dict = Depends(get_current_user),
    limit: int = 50,
    skip: int = 0,
    conversation_id: Optional[str] = None,
):
    """List the user's call history (excluding entries they've removed).

    If `conversation_id` is provided, only calls inside that conversation are
    returned (used by the chat screen to show a compact "recent calls" section).
    """
    limit = max(1, min(int(limit or 50), 200))
    skip = max(0, int(skip or 0))
    hidden = set(user.get("hidden_call_ids", []) or [])
    query: dict = {"member_ids": user["id"], "ephemeral": {"$ne": True}}
    if conversation_id:
        query["$or"] = [
            {"conv_id": conversation_id},
            {"conversation_id": conversation_id},
        ]
    cursor = (
        db.calls.find(query, {"_id": 0})
        .sort("started_at", -1)
        .skip(skip)
        .limit(limit + len(hidden))
    )
    items = []
    async for c in cursor:
        if c.get("id") in hidden:
            continue
        items.append(await enrich_call_for_user(c, user["id"]))
        if len(items) >= limit:
            break
    return items


@api.get("/calls/missed")
async def missed_calls_count(user: dict = Depends(get_current_user)):
    """Returns count of unread missed calls (for badge)."""
    hidden = set(user.get("hidden_call_ids", []) or [])
    seen = set(user.get("seen_call_ids", []) or [])
    cursor = db.calls.find(
        {
            "member_ids": user["id"],
            "caller_id": {"$ne": user["id"]},
            "answered_at": None,
            "status": {"$in": ["missed", "ended", "ringing"]},
        },
        {"id": 1, "_id": 0},
    )
    count = 0
    async for c in cursor:
        cid = c.get("id")
        if not cid or cid in hidden or cid in seen:
            continue
        count += 1
    return {"count": count}


@api.post("/calls/missed/seen")
async def mark_missed_as_seen(user: dict = Depends(get_current_user)):
    """Mark all currently missed calls as seen (clears the badge)."""
    cursor = db.calls.find(
        {
            "member_ids": user["id"],
            "caller_id": {"$ne": user["id"]},
            "answered_at": None,
        },
        {"id": 1, "_id": 0},
    )
    ids = [c["id"] async for c in cursor if c.get("id")]
    if ids:
        await db.users.update_one(
            {"id": user["id"]},
            {"$addToSet": {"seen_call_ids": {"$each": ids}}},
        )
    return {"marked": len(ids)}


@api.get("/calls/{call_id}")
async def get_call(call_id: str, user: dict = Depends(get_current_user)):
    """Return one call history entry for the current user."""
    call = await db.calls.find_one({"id": call_id}, {"_id": 0})
    if not call:
        raise HTTPException(status_code=404, detail="Call not found")
    if user["id"] not in call.get("member_ids", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    return await enrich_call_for_user(call, user["id"])


@api.delete("/calls/{call_id}")
async def delete_call_entry(call_id: str, user: dict = Depends(get_current_user)):
    """Hide one call from this user's history (does not affect peer)."""
    call = await db.calls.find_one({"id": call_id}, {"_id": 0})
    if not call:
        raise HTTPException(status_code=404, detail="Call not found")
    if user["id"] not in call.get("member_ids", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    await db.users.update_one(
        {"id": user["id"]},
        {"$addToSet": {"hidden_call_ids": call_id}},
    )
    return {"deleted": True}


@api.delete("/calls")
async def clear_call_history(user: dict = Depends(get_current_user)):
    """Hide ALL calls from this user's history."""
    cursor = db.calls.find({"member_ids": user["id"]}, {"id": 1, "_id": 0})
    ids = [c["id"] async for c in cursor if c.get("id")]
    if ids:
        await db.users.update_one(
            {"id": user["id"]},
            {"$addToSet": {"hidden_call_ids": {"$each": ids}}},
        )
    return {"cleared": len(ids)}


# ----------------- Privacy & Blocking -----------------
@api.get("/users/me/privacy")
async def get_privacy(user: dict = Depends(get_current_user)):
    return {
        "save_call_history": user.get("save_call_history", True) if user.get("save_call_history") is not None else True,
    }


@api.patch("/users/me/privacy")
async def update_privacy(
    payload: PrivacyUpdateIn, user: dict = Depends(get_current_user)
):
    update_doc: dict = {}
    if payload.save_call_history is not None:
        update_doc["save_call_history"] = bool(payload.save_call_history)
    if not update_doc:
        return {"updated": False}
    await db.users.update_one({"id": user["id"]}, {"$set": update_doc})
    return {"updated": True, **update_doc}


@api.get("/users/me/blocked")
async def list_blocked(user: dict = Depends(get_current_user)):
    """Return list of blocked users with basic profile info."""
    ids = user.get("blocked_user_ids", []) or []
    if not ids:
        return []
    cursor = db.users.find(
        {"id": {"$in": ids}},
        {"_id": 0, "id": 1, "name": 1, "username": 1, "avatar_color": 1, "email": 1},
    )
    return [u async for u in cursor]


@api.post("/users/me/blocked/{target_id}")
async def block_user(target_id: str, user: dict = Depends(get_current_user)):
    if target_id == user["id"]:
        raise HTTPException(status_code=400, detail="Cannot block yourself")
    target = await db.users.find_one({"id": target_id}, {"_id": 0, "id": 1})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    await db.users.update_one(
        {"id": user["id"]}, {"$addToSet": {"blocked_user_ids": target_id}}
    )
    # Also remove them from contacts (optional but expected UX)
    await db.users.update_one(
        {"id": user["id"]}, {"$pull": {"contact_ids": target_id}}
    )
    return {"blocked": True}


@api.delete("/users/me/blocked/{target_id}")
async def unblock_user(target_id: str, user: dict = Depends(get_current_user)):
    await db.users.update_one(
        {"id": user["id"]}, {"$pull": {"blocked_user_ids": target_id}}
    )
    return {"unblocked": True}


@api.patch("/conversations/{conv_id}/mute")
async def toggle_mute_conversation(
    conv_id: str,
    payload: MuteUpdateIn,
    user: dict = Depends(get_current_user),
):
    """Mute or unmute push notifications from a conversation."""
    conv = await db.conversations.find_one(
        {"id": conv_id, "member_ids": user["id"]}, {"_id": 0, "id": 1}
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if payload.muted:
        await db.users.update_one(
            {"id": user["id"]},
            {"$addToSet": {"muted_conversation_ids": conv_id}},
        )
    else:
        await db.users.update_one(
            {"id": user["id"]},
            {"$pull": {"muted_conversation_ids": conv_id}},
        )
    return {"muted": payload.muted}


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


@api.post("/ws-ticket")
async def issue_ws_ticket(user: dict = Depends(get_current_user)):
    ticket, jti, expires_at = create_ws_ticket(user["id"])
    await db.ws_tickets.insert_one(
        {"jti": jti, "user_id": user["id"], "expires_at": expires_at}
    )
    return {"ticket": ticket, "expires_in": 60}


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
@api.get("/")
async def root():
    return {"app": APP_NAME, "version": "1.0.0", "status": "ok"}


@app.get("/app-release.apk")
async def download_android_apk():
    apk_path = ROOT_DIR.parent / "frontend" / "android" / "app" / "build" / "outputs" / "apk" / "release" / "app-release.apk"
    if not apk_path.exists():
        raise HTTPException(status_code=404, detail="APK not built")
    return FileResponse(
        apk_path,
        media_type="application/vnd.android.package-archive",
        filename="ghostel-app-release.apk",
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
            "Content-Disposition": 'attachment; filename="ghostel-app-release.apk"',
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
