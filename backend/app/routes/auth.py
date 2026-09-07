import uuid
from datetime import timedelta

import pyotp
from fastapi import APIRouter, Request, Depends, HTTPException

from app.core.config import APP_NAME, logger
from app.core.database import db
from app.core.utils import api_error, client_ip, now_utc, enforce_rate_limit, _USERNAME_RE, validate_new_password
from app.core.auth import (
    hash_password, verify_password, create_access_token, create_ws_ticket,
    persist_user_session, revoke_access_token_jti, revoke_user_session,
    public_session, get_current_user, require_admin,
)
from app.services.users import (
    public_user, normalize_username, is_username_taken, generate_unique_username,
)
from app.services.push import remove_push_tokens_for_session
from app.models import (
    RegisterIn, LoginIn, TwoFASetupIn, TwoFAVerifyIn, E2EEKeyIn,
)

router = APIRouter()


@router.post('/auth/register')
async def register(payload: RegisterIn, request: Request):
    email = payload.email.lower().strip()
    validate_new_password(payload.password, email)
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
        "auth_epoch": 0,
        "email_verified": False,
        "avatar_color": colors[hash(email) % len(colors)],
        "contact_ids": [],
        "created_at": now_utc().isoformat(),
        "last_seen": now_utc().isoformat(),
    }
    await db.users.insert_one(user_doc)
    token, jti, expires_at, session_id = create_access_token(
        user_id, email, auth_epoch=user_doc.get("auth_epoch", 0)
    )
    await persist_user_session(
        user_doc,
        request,
        session_id=session_id,
        token_jti=jti,
        expires_at=expires_at,
    )
    return {
        "access_token": token,
        "token_type": "bearer",
        "session_id": session_id,
        "user": public_user(user_doc),
    }


@router.post('/auth/login')
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
    token, jti, expires_at, session_id = create_access_token(
        user["id"], user["email"], auth_epoch=user.get("auth_epoch", 0)
    )
    await persist_user_session(
        user,
        request,
        session_id=session_id,
        token_jti=jti,
        expires_at=expires_at,
    )
    return {
        "access_token": token,
        "token_type": "bearer",
        "session_id": session_id,
        "user": public_user(user),
    }


@router.get('/auth/username-available')
async def username_available(username: str):
    normalized = normalize_username(username)
    valid = bool(_USERNAME_RE.match(normalized))
    return {
        "username": normalized,
        "valid": valid,
        "available": valid and not await is_username_taken(normalized),
    }


@router.get('/auth/me')
async def me(user: dict = Depends(get_current_user)):
    data = public_user(user)
    # Expose private fields needed by the client (only to the user themselves):
    data["muted_users"] = user.get("muted_users") or {}
    data["muted_conversation_ids"] = user.get("muted_conversation_ids") or []
    data["blocked_user_ids"] = user.get("blocked_user_ids") or []
    data["save_call_history"] = bool(user.get("save_call_history", True))
    data["session_id"] = user.get("_auth_sid")
    return data


@router.post('/auth/logout')
async def logout(request: Request, user: dict = Depends(get_current_user)):
    jti = user.get("_auth_jti")
    session_id = user.get("_auth_sid")
    expires = None
    if session_id:
        session = await db.user_sessions.find_one(
            {"id": session_id, "user_id": user["id"]},
            {"_id": 0, "expires_at": 1},
        )
        expires = session.get("expires_at") if session else None
        await revoke_user_session(session_id, user["id"], reason="logout")
        await remove_push_tokens_for_session(user["id"], session_id)
    await revoke_access_token_jti(jti, user["id"], expires)
    return {"ok": True}


@router.get('/auth/sessions')
async def list_sessions(user: dict = Depends(get_current_user)):
    sessions = await db.user_sessions.find(
        {"user_id": user["id"]},
        {"_id": 0},
    ).sort("created_at", -1).to_list(50)
    current_session_id = user.get("_auth_sid")
    return {
        "current_session_id": current_session_id,
        "sessions": [public_session(session, current_session_id) for session in sessions],
    }


@router.delete('/auth/sessions/{session_id}')
async def revoke_session(session_id: str, user: dict = Depends(get_current_user)):
    revoked = await revoke_user_session(session_id, user["id"], reason="user_revoke")
    if not revoked:
        raise HTTPException(status_code=404, detail="Session not found")
    await remove_push_tokens_for_session(user["id"], session_id)
    return {
        "revoked": True,
        "session_id": session_id,
        "current_session_revoked": session_id == user.get("_auth_sid"),
    }


@router.post('/e2ee/keys')
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


@router.get('/e2ee/users/{user_id}/key')
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


@router.post('/auth/2fa/setup')
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


@router.post('/auth/2fa/enable')
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


@router.post('/auth/2fa/disable')
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
