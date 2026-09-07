"""Password reset endpoints."""

import asyncio
import hashlib
import os
import uuid
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from pymongo import ReturnDocument

from app.core.auth import hash_password, get_current_user, require_admin
from app.core.config import APP_NAME, JWT_SECRET, logger
from app.core.database import db
from app.core.utils import client_ip, enforce_rate_limit, now_utc, validate_new_password
from app.services.password_reset import (
    RESET_MAX_ATTEMPTS,
    RESET_TTL_MINUTES,
    new_reset_secrets,
    password_reset_url,
    secret_matches,
    send_password_reset_email,
    smtp_configured,
)

router = APIRouter()


class PasswordResetRequestIn(BaseModel):
    email: EmailStr


class PasswordResetConfirmIn(BaseModel):
    email: EmailStr
    new_password: str = Field(min_length=8, max_length=128)
    token: Optional[str] = Field(default=None, min_length=20, max_length=200)
    code: Optional[str] = Field(default=None, min_length=6, max_length=6)


async def _deliver_password_reset(
    reset_id: str,
    user_id: str,
    email: str,
    code: str,
    reset_link: str,
) -> None:
    try:
        await send_password_reset_email(email, code, reset_link)
        await db.password_resets.update_one(
            {"id": reset_id, "user_id": user_id},
            {"$set": {"delivery_status": "sent", "delivered_at": now_utc()}},
        )
        logger.info("PASSWORD_RESET_EMAIL_SENT user=%s", user_id[:8])
    except Exception as exc:
        await db.password_resets.delete_one({"id": reset_id, "user_id": user_id})
        logger.error(
            "PASSWORD_RESET_EMAIL_FAILED user=%s error=%s",
            user_id[:8],
            type(exc).__name__,
        )


@router.post("/auth/request-password-reset", status_code=202)
async def request_password_reset(payload: PasswordResetRequestIn, request: Request):
    """Issue a one-time password reset without revealing account existence."""
    if not smtp_configured():
        logger.error("PASSWORD_RESET_UNAVAILABLE smtp_not_configured")
        raise HTTPException(status_code=503, detail="Password recovery is temporarily unavailable")

    email = payload.email.lower().strip()
    await enforce_rate_limit(
        "password-reset-request-ip", client_ip(request), limit=8, window_seconds=60 * 60
    )
    await enforce_rate_limit(
        "password-reset-request-email", email, limit=3, window_seconds=60 * 60
    )
    response = {
        "accepted": True,
        "message": "If the account exists, password recovery instructions have been sent.",
    }
    user = await db.users.find_one({"email": email}, {"_id": 0, "id": 1, "email": 1})
    if not user:
        # Keep the fast path from becoming a trivial account-enumeration oracle.
        await asyncio.sleep(0.2)
        return response

    issued_at = now_utc()
    expires_at = issued_at + timedelta(minutes=RESET_TTL_MINUTES)
    secret = new_reset_secrets(JWT_SECRET)
    reset_id = str(uuid.uuid4())
    await db.password_resets.delete_many(
        {"user_id": user["id"], "consumed_at": None}
    )
    await db.password_resets.insert_one(
        {
            "id": reset_id,
            "user_id": user["id"],
            "email": email,
            "token_hash": secret["token_hash"],
            "code_hash": secret["code_hash"],
            "attempts": 0,
            "created_at": issued_at,
            "expires_at": expires_at,
            "consumed_at": None,
            "delivery_status": "pending",
        }
    )
    reset_base = os.environ.get(
        "PASSWORD_RESET_URL", "https://ghostel.app/forgot-password"
    )
    reset_link = password_reset_url(reset_base, email, secret["token"])
    asyncio.create_task(
        _deliver_password_reset(reset_id, user["id"], email, secret["code"], reset_link)
    )
    logger.info("PASSWORD_RESET_REQUEST_ACCEPTED user=%s", user["id"][:8])
    return response


@router.post("/auth/reset-password")
async def reset_password(payload: PasswordResetConfirmIn, request: Request):
    email = payload.email.lower().strip()
    validate_new_password(payload.new_password, email)
    await enforce_rate_limit(
        "password-reset-confirm-ip", client_ip(request), limit=20, window_seconds=60 * 60
    )
    await enforce_rate_limit(
        "password-reset-confirm-email", email, limit=10, window_seconds=60 * 60
    )
    if not payload.token and not payload.code:
        raise HTTPException(status_code=400, detail="Reset token or code is required")

    now = now_utc()
    reset = await db.password_resets.find_one(
        {
            "email": email,
            "consumed_at": None,
            "expires_at": {"$gt": now},
            "attempts": {"$lt": RESET_MAX_ATTEMPTS},
        },
        {"_id": 0},
        sort=[("created_at", -1)],
    )
    if not reset:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")

    attempted = await db.password_resets.find_one_and_update(
        {
            "id": reset["id"],
            "consumed_at": None,
            "expires_at": {"$gt": now},
            "attempts": {"$lt": RESET_MAX_ATTEMPTS},
        },
        {"$inc": {"attempts": 1}},
        return_document=ReturnDocument.AFTER,
    )
    if not attempted:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")

    valid_token = bool(payload.token) and secret_matches(
        payload.token or "", attempted.get("token_hash", ""), JWT_SECRET, "password-reset-token"
    )
    valid_code = bool(payload.code) and secret_matches(
        payload.code or "", attempted.get("code_hash", ""), JWT_SECRET, "password-reset-code"
    )
    if not (valid_token or valid_code):
        logger.warning("PASSWORD_RESET_INVALID user=%s", str(attempted.get("user_id", ""))[:8])
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")

    consumed = await db.password_resets.find_one_and_update(
        {"id": reset["id"], "consumed_at": None},
        {"$set": {"consumed_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if not consumed:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")

    user_id = consumed["user_id"]
    updated = await db.users.update_one(
        {"id": user_id, "email": email},
        {
            "$set": {
                "password_hash": hash_password(payload.new_password),
                "password_changed_at": now.isoformat(),
                "email_verified": True,
                "email_verified_at": now.isoformat(),
                "push_tokens": [],
            },
            "$inc": {"auth_epoch": 1},
        },
    )
    if updated.matched_count != 1:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")

    await db.user_sessions.update_many(
        {"user_id": user_id, "revoked_at": None},
        {
            "$set": {
                "revoked_at": now.isoformat(),
                "revoked_reason": "password_reset",
                "last_seen_at": now.isoformat(),
            }
        },
    )
    await db.ws_tickets.delete_many({"user_id": user_id})
    await db.password_resets.delete_many({"user_id": user_id, "id": {"$ne": reset["id"]}})
    await db.security_events.insert_one(
        {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "type": "password_reset_completed",
            "ip_hash": hashlib.sha256(client_ip(request).encode("utf-8")).hexdigest(),
            "created_at": now,
            "expires_at": now + timedelta(days=90),
        }
    )
    logger.info("PASSWORD_RESET_COMPLETED user=%s", user_id[:8])
    return {"reset": True, "sessions_revoked": True}


@router.get("/admin/reset-codes")
async def get_reset_codes(admin: dict = Depends(require_admin), email: Optional[str] = None):
    """Get active password reset codes (admin only)."""
    query = {
        "used": False,
        "expires_at": {"$gt": now_utc()},
    }
    if email:
        user = await db.users.find_one({"email": email.lower().strip()}, {"_id": 0, "id": 1})
        if user:
            query["user_id"] = user["id"]

    codes = await db.password_resets.find(query, {"_id": 0}).sort("created_at", -1).limit(50).to_list(50)
    return {"codes": codes, "count": len(codes)}
