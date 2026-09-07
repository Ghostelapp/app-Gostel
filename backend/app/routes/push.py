import json
import os
import uuid
import hashlib
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Body, Request, HTTPException

from app.core.config import logger, EXPO_PUSH_URL
from app.core.database import db
from app.core.utils import now_utc, enforce_rate_limit
from app.core.auth import get_current_user, require_admin
from app.models import PushTokenIn, PushUnregisterIn
from app.services.push import (
    normalize_push_device_id, remove_push_token_from_users, remove_push_device_from_users,
    remove_push_device_from_other_users, remove_push_tokens_for_session, sync_user_push_legacy_fields,
    user_push_targets, expo_push_sound_name,
)

router = APIRouter()

@router.get("/push/status")
async def push_status(admin: dict = Depends(require_admin)):
    """Return push/call transport readiness without exposing credentials."""
    from apns import is_configured as apns_is_configured
    from fcm import get_config_error, get_project_id, is_configured

    fcm_ok = is_configured()
    apns_ok = apns_is_configured()
    configured_turn = bool(os.environ.get("TURN_URLS", "").strip())
    cloudflare_turn = bool(
        os.environ.get("CLOUDFLARE_TURN_APP_ID", "").strip()
        and os.environ.get("CLOUDFLARE_TURN_API_TOKEN", "").strip()
    )
    if configured_turn:
        turn_source = "configured"
    elif cloudflare_turn:
        turn_source = "cloudflare"
    else:
        turn_source = "public-fallback"
    warnings = []
    if not fcm_ok:
        warnings.append("FCM is not configured; Android/APNs fallback pushes may fail.")
    if not apns_ok:
        warnings.append("APNs VoIP is not configured; locked iOS incoming calls may fail.")
    if turn_source == "public-fallback":
        warnings.append("TURN uses public fallback; configure production TURN for reliable mobile calls.")
    return {
        "fcm_configured": fcm_ok,
        "fcm_project_configured": bool(get_project_id()),
        "fcm_config_error": get_config_error() if not fcm_ok else None,
        "apns_voip_configured": apns_ok,
        "apns_voip_topic_configured": bool(os.environ.get("APNS_VOIP_TOPIC", "").strip()),
        "turn_configured": turn_source != "public-fallback",
        "turn_source": turn_source,
        "production_call_ready": bool(fcm_ok and apns_ok and turn_source != "public-fallback"),
        "warnings": warnings,
    }


@router.post("/push/register")
async def register_push_token(payload: PushTokenIn, user: dict = Depends(get_current_user)):
    token = (payload.token or "").strip()
    platform = (payload.platform or "").strip()
    device_id = normalize_push_device_id(payload.device_id)
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
        "device_id": device_id,
        "session_id": user.get("_auth_sid") or "",
        "device_model": (payload.device_model or "").strip()[:120],
        "os_version": (payload.os_version or "").strip()[:80],
        "source": (payload.source or "").strip()[:80],
        "registered_at": now_utc().isoformat(),
    }
    # A push token identifies one physical app install. If a user logs out and
    # signs into another account on the same phone, move that phone to the new
    # account instead of ringing both accounts.
    if device_id:
        await remove_push_device_from_other_users(device_id, user["id"])
    await remove_push_token_from_users(token)
    await db.users.update_one(
        {"id": user["id"]},
        {"$pull": {"push_tokens": {"token": token}}},
    )
    if device_id:
        await db.users.update_one(
            {"id": user["id"]},
            {"$pull": {"push_tokens": {"device_id": device_id, "token_type": token_type}}},
        )
    await db.users.update_one(
        {"id": user["id"]},
        {
            "$addToSet": {"push_tokens": token_entry},
            "$unset": {
                "expo_push_token": "",
                "push_platform": "",
                "push_token": "",
                "push_token_type": "",
            },
        },
    )
    await sync_user_push_legacy_fields(user["id"])
    logger.info(
        f"Push token registered for {user.get('email')} type={token_type} (raw={raw_type}) platform={platform} device_id={device_id or '-'}"
    )
    return {"registered": True, "platform": platform, "token_type": token_type, "device_id": device_id}


@router.get("/push/devices")
async def list_push_devices(user: dict = Depends(get_current_user)):
    """Return masked push-token registrations for the current account."""
    grouped: dict[str, dict] = {}
    current_session_id = user.get("_auth_sid") or ""
    for idx, target in enumerate(user_push_targets(user), start=1):
        token = target.get("token") or ""
        resolved_id = target.get("device_id") or (
            hashlib.sha256(token.encode("utf-8")).hexdigest()[:16] if token else str(idx)
        )
        entry = grouped.get(resolved_id)
        if not entry:
            entry = {
                "id": resolved_id,
                "platform": target.get("platform") or "unknown",
                "token_type": target.get("token_type") or "unknown",
                "token_types": [],
                "token_prefix": token[:18],
                "token_suffix": token[-6:] if len(token) > 6 else "",
                "device_model": target.get("device_model") or "",
                "os_version": target.get("os_version") or "",
                "source": target.get("source") or "",
                "registered_at": target.get("registered_at") or "",
                "current_session": False,
            }
            grouped[resolved_id] = entry
        token_type = target.get("token_type") or "unknown"
        if token_type not in entry["token_types"]:
            entry["token_types"].append(token_type)
        if (target.get("session_id") or "") == current_session_id and current_session_id:
            entry["current_session"] = True
        if (target.get("registered_at") or "") > (entry.get("registered_at") or ""):
            entry["token_type"] = token_type
            entry["platform"] = target.get("platform") or entry["platform"]
            entry["token_prefix"] = token[:18]
            entry["token_suffix"] = token[-6:] if len(token) > 6 else ""
            entry["device_model"] = target.get("device_model") or entry["device_model"]
            entry["os_version"] = target.get("os_version") or entry["os_version"]
            entry["source"] = target.get("source") or entry["source"]
            entry["registered_at"] = target.get("registered_at") or entry["registered_at"]
    devices = list(grouped.values())
    for entry in devices:
        entry["token_types"].sort()
    return {
        "count": len(devices),
        "devices": devices,
        "last_diag": user.get("push_diag") or None,
    }


@router.post("/push/unregister")
async def unregister_push(
    payload: Optional[PushUnregisterIn] = Body(default=None),
    user: dict = Depends(get_current_user),
):
    token = ((payload.token if payload else None) or "").strip()
    device_id = normalize_push_device_id((payload.device_id if payload else None) or "")
    if device_id:
        removed = await remove_push_device_from_users(device_id, user["id"])
        if not removed:
            raise HTTPException(status_code=404, detail="Push device not found")
        return {"unregistered": True, "device_id": device_id, "scope": "device"}

    if token:
        await remove_push_token_from_users(token, user["id"])
        return {"unregistered": True, "token_scoped": True, "scope": "token"}

    removed = await remove_push_tokens_for_session(user["id"], user.get("_auth_sid"))
    return {"unregistered": True, "scope": "session", "removed": removed}


@router.post("/push/diag")
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


@router.post("/push/test")
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
                "sound": expo_push_sound_name(sound),
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
