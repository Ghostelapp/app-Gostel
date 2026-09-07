import os
import time as _time
import asyncio
import uuid
import json
import httpx
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from app.core.config import (
    logger,
    CALL_RING_TIMEOUT_SECONDS, CALL_TERMINAL_STATUSES,
    CALL_ACTIVE_STATUSES, CALL_SIGNAL_EVENT_NAMES,
)
from app.core.database import db
from app.core.utils import now_utc, enforce_rate_limit
from app.core.auth import get_current_user
from app.models import CallStartIn, CallStateUpdateIn
from app.services.users import (
    ensure_direct_conversation_not_blocked,
    require_conversation_e2ee_ready,
    user_can_signal_target,
)
from app.services.ws_manager import broadcast_to_members, ws_manager
from app.services.push import _send_push_to_members, _send_call_control_push, sanitize_diag_value

router = APIRouter()

# ICE servers cache (TTL 50min — Cloudflare creds valid 1h, refresh every 50min)
_ice_cache = {"servers": None, "source": None, "expires_at": 0.0}

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


@router.get('/calls/ice-servers')
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


@router.post('/calls/start')
async def start_call(payload: CallStartIn, user: dict = Depends(get_current_user)):
    await enforce_rate_limit(
        "call-start-user", user["id"], limit=30, window_seconds=10 * 60
    )
    await enforce_rate_limit(
        "call-start-conversation",
        f"{user['id']}:{payload.conversation_id}",
        limit=12,
        window_seconds=10 * 60,
    )
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
    started_at = now_utc()
    expires_at = started_at + timedelta(seconds=CALL_RING_TIMEOUT_SECONDS)
    callee_ids = [member_id for member_id in conv["member_ids"] if member_id != user["id"]]
    requested_call_id = (payload.call_id or "").strip()
    if requested_call_id:
        existing = await db.calls.find_one(
            {"id": requested_call_id, "member_ids": user["id"]},
            {"_id": 0},
        )
        if existing:
            logger.info(
                f"DUPLICATE_CALL_IGNORED call={requested_call_id[:8]} reason=idempotency_key"
            )
            return existing

    existing_active = await db.calls.find_one(
        {
            "conversation_id": conv["id"],
            "caller_id": user["id"],
            "member_ids": {"$all": conv["member_ids"]},
            "ended_at": None,
            "$or": [
                {"status": "ringing", "expires_at": {"$gt": started_at.isoformat()}},
                {"status": {"$in": ["accepted", "answered", "connecting", "active", "reconnecting"]}},
            ],
        },
        {"_id": 0},
        sort=[("started_at", -1)],
    )
    if existing_active:
        logger.info(
            f"DUPLICATE_CALL_IGNORED call={str(existing_active.get('id', ''))[:8]} reason=active_call_exists"
        )
        return existing_active

    call_id = requested_call_id or str(uuid.uuid4())
    call = {
        "id": call_id,
        "callId": call_id,
        "conversation_id": conv["id"],
        "conversationId": conv["id"],
        "caller_id": user["id"],
        "callerId": user["id"],
        "caller_name": user.get("name", ""),
        "callee_ids": callee_ids,
        "calleeId": callee_ids[0] if callee_ids else "",
        "member_ids": conv["member_ids"],
        "participants": conv["member_ids"],
        "mode": payload.mode,
        "callType": payload.mode,
        "status": "ringing",
        "created_at": started_at.isoformat(),
        "createdAt": started_at.isoformat(),
        "started_at": started_at.isoformat(),
        "expires_at": expires_at.isoformat(),
        "expiresAt": expires_at.isoformat(),
        "answered_at": None,
        "answeredAt": None,
        "ended_at": None,
        "endedAt": None,
        "last_updated_at": started_at.isoformat(),
        "lastUpdatedAt": started_at.isoformat(),
        "callerDeviceId": user.get("_auth_sid") or "",
        "calleeDeviceId": "",
        "platform": "unknown",
        "pushSentAt": None,
        "lastKnownClientState": {},
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
    push_sent_at = now_utc().isoformat()
    await db.calls.update_one(
        {"id": call["id"]},
        {"$set": {"pushSentAt": push_sent_at, "push_sent_at": push_sent_at}},
    )
    call["pushSentAt"] = push_sent_at
    call["push_sent_at"] = push_sent_at

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


@router.get('/calls/active')
async def get_active_call(user: dict = Depends(get_current_user)):
    """Return the authoritative active call for resume/unlock state sync."""
    await expire_stale_ringing_calls_for_user(user["id"])
    ringing_cutoff = (now_utc() - timedelta(seconds=CALL_RING_TIMEOUT_SECONDS + 15)).isoformat()
    call = await db.calls.find_one(
        {
            "member_ids": user["id"],
            "ended_at": None,
            "$or": [
                {"status": "ringing", "started_at": {"$gte": ringing_cutoff}},
                {"status": {"$in": ["accepted", "answered", "active", "connecting", "reconnecting"]}},
            ],
        },
        {"_id": 0},
        sort=[("started_at", -1)],
    )
    if not call:
        logger.info(
            f"BACKEND_CALL_ACTIVE_QUERY_RESULT user={str(user.get('id', ''))[:8]} active=false"
        )
        return None
    logger.info(
        "BACKEND_CALL_ACTIVE_QUERY_RESULT "
        f"user={str(user.get('id', ''))[:8]} active=true "
        f"call={str(call.get('id', ''))[:8]} status={call.get('status')}"
    )
    if str(call.get("status") or "").lower() in {"accepted", "answered", "connecting"}:
        logger.info(
            "BACKEND_CALL_ACTIVE_QUERY_INCLUDES_ACCEPTED_CONNECTING "
            f"call={str(call.get('id', ''))[:8]} status={call.get('status')}"
        )
    call = await enrich_call_for_user(call, user["id"])
    return public_call_status(call, user["id"])


@router.post('/calls/{call_id}/ring')
async def ring_call(call_id: str, user: dict = Depends(get_current_user)):
    await enforce_rate_limit(
        "call-ring-user", user["id"], limit=120, window_seconds=60 * 60
    )
    call = await db.calls.find_one({"id": call_id}, {"_id": 0})
    if not call:
        raise HTTPException(status_code=404, detail="Call not found")
    if user["id"] not in call.get("member_ids", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    if call.get("ended_at") or call.get("answered_at"):
        return {"ringing": False, "status": call.get("status")}
    now_iso = now_utc().isoformat()
    await db.calls.update_one(
        {"id": call_id, "ended_at": None, "answered_at": None},
        {
            "$set": {
                "status": "ringing",
                "last_ring_at": now_iso,
                "last_updated_at": now_iso,
                "lastUpdatedAt": now_iso,
            }
        },
    )
    event = {
        "type": "call:ringing",
        "event": "call.ringing",
        "call_id": call_id,
        "from": user["id"],
    }
    await broadcast_to_members(call.get("member_ids", []), event)
    return {"ringing": True, "status": "ringing"}


@router.post('/calls/{call_id}/accept')
async def accept_call(call_id: str, user: dict = Depends(get_current_user)):
    """Callee marks the call as accepted — sets answered_at so it doesn't
    count as missed."""
    await enforce_rate_limit(
        "call-accept-user", user["id"], limit=120, window_seconds=60 * 60
    )
    call = await db.calls.find_one({"id": call_id}, {"_id": 0})
    if not call:
        return {"accepted": True, "ephemeral": True}
    if user["id"] not in call.get("member_ids", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    if user["id"] == call.get("caller_id"):
        raise HTTPException(status_code=403, detail="Caller cannot accept own call")
    current_status = str(call.get("status") or "").lower()
    logger.info(
        f"BACKEND_CALL_ACCEPT_REQUEST call={call_id[:8]} user={str(user.get('id', ''))[:8]}"
    )
    logger.info(
        f"BACKEND_CALL_STATUS_BEFORE_ACTION action=accept call={call_id[:8]} status={current_status}"
    )
    if call.get("ended_at") or current_status in CALL_TERMINAL_STATUSES:
        return {
            "accepted": False,
            "status": call.get("status", "ended"),
            "idempotent": True,
        }

    answered_at = call.get("answered_at") or now_utc().isoformat()
    if not call.get("answered_at"):
        await db.calls.update_one(
            {"id": call_id, "answered_at": None, "ended_at": None},
            {
                "$set": {
                    "status": "answered",
                    "answered_at": answered_at,
                    "answeredAt": answered_at,
                    "last_updated_at": answered_at,
                    "lastUpdatedAt": answered_at,
                    "lastKnownClientState.accepted_by": user["id"],
                }
            },
        )
        logger.info(f"BACKEND_RING_TIMEOUT_CANCELLED_AFTER_ACCEPT call={call_id[:8]}")

    accepted_event = {
        "type": "call:accepted",
        "event": "call.accepted",
        "call_id": call_id,
        "from": user["id"],
        "data": {
            "call_id": call_id,
            "accepted_by": user["id"],
            "status": "answered",
            "answered_at": answered_at,
        },
    }
    for member_id in call.get("member_ids", []):
        signal = {
            **accepted_event,
            "signal_id": f"{call_id}:accepted:{member_id}",
            "to": member_id,
            "created_at": answered_at,
        }
        await db.call_signals.update_one(
            {"signal_id": signal["signal_id"]},
            {"$setOnInsert": signal},
            upsert=True,
        )
    await broadcast_to_members(call.get("member_ids", []), accepted_event)
    logger.info(f"BACKEND_CALL_ACCEPTED_EVENT_SENT call={call_id[:8]}")
    asyncio.create_task(
        _send_call_control_push(call, "accepted", user["id"], user.get("_auth_sid"))
    )
    logger.info(
        f"BACKEND_CALL_STATUS_AFTER_ACTION action=accept call={call_id[:8]} status=answered"
    )
    return {"accepted": True, "status": "answered", "answered_at": answered_at}


@router.post('/calls/{call_id}/diag')
async def call_diag(
    call_id: str,
    payload: dict = Body(default_factory=dict),
    user: dict = Depends(get_current_user),
):
    """Store short-lived client-side WebRTC diagnostics for failed mobile calls."""
    try:
        await enforce_rate_limit(
            "call-diag-user", user["id"], limit=900, window_seconds=60 * 60
        )
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Invalid diagnostic payload")
        sanitized = sanitize_diag_value(payload)
        if not isinstance(sanitized, dict):
            sanitized = {}
        if len(json.dumps(sanitized, default=str)) > 20_000:
            raise HTTPException(status_code=413, detail="Diagnostic payload too large")

        call = await db.calls.find_one({"id": call_id}, {"_id": 0, "member_ids": 1})
        if call and user["id"] not in call.get("member_ids", []):
            raise HTTPException(status_code=403, detail="Not a participant")

        diag = {
            "id": str(uuid.uuid4()),
            "call_id": call_id,
            "user_id": user["id"],
            "created_at": now_utc().isoformat(),
            **sanitized,
        }
        await db.call_diagnostics.insert_one(diag)
        await db.users.update_one(
            {"id": user["id"]},
            {
                "$set": {
                    "last_call_diag": {
                        "at": diag["created_at"],
                        "call_id": call_id,
                        "reason": sanitized.get("reason", "unknown"),
                        "status": sanitized.get("status", ""),
                        "ice_state": sanitized.get("ice_state", ""),
                        "connection_state": sanitized.get("connection_state", ""),
                        "relay_seen": sanitized.get("relay_seen", False),
                        "remote_tracks": len(sanitized.get("remote_tracks") or []),
                    }
                }
            },
        )
        logger.info(
            "CallDiag "
            f"call={call_id[:8]} user={user.get('id')} "
            f"reason={sanitized.get('reason', 'unknown')} "
            f"status={sanitized.get('status', '')} "
            f"ice={sanitized.get('ice_state', '')} "
            f"pc={sanitized.get('connection_state', '')} "
            f"relay={sanitized.get('relay_seen', False)} "
            f"remote_tracks={len(sanitized.get('remote_tracks') or [])}"
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(f"call_diag store error: {exc}")
    return {"received": True}


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


@router.post('/calls/{call_id}/signals')
async def persist_call_signal(
    call_id: str,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    return await _persist_call_signal_payload(call_id, payload, user)


@router.post('/calls/{call_id}/offer')
async def persist_call_offer(
    call_id: str,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    return await _persist_call_signal_payload(call_id, payload, user, forced_type="call:offer")


@router.post('/calls/{call_id}/answer')
async def persist_call_answer(
    call_id: str,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    return await _persist_call_signal_payload(call_id, payload, user, forced_type="call:answer")


@router.post('/calls/{call_id}/ice-candidate')
async def persist_call_ice_candidate(
    call_id: str,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    return await _persist_call_signal_payload(call_id, payload, user, forced_type="call:ice")


@router.get('/calls/{call_id}/signals')
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


@router.post('/calls/{call_id}/end')
async def end_call(call_id: str, user: dict = Depends(get_current_user)):
    return await _finish_call(call_id, user, "end")


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


@router.get('/calls/active-incoming')
async def get_active_incoming_call(user: dict = Depends(get_current_user)):
    """Return a recent unanswered call so mobile clients can restore UI after unlock."""
    cutoff = (now_utc() - timedelta(seconds=75)).isoformat()
    call = await db.calls.find_one(
        {
            "member_ids": user["id"],
            "caller_id": {"$ne": user["id"]},
            "status": "ringing",
            "answered_at": None,
            "ended_at": None,
            "started_at": {"$gte": cutoff},
        },
        {"_id": 0},
        sort=[("started_at", -1)],
    )
    if not call:
        return None
    return {
        "id": call.get("id"),
        "caller_id": call.get("caller_id"),
        "caller_name": call.get("caller_name") or "Unknown",
        "conversation_id": call.get("conversation_id") or call.get("conv_id"),
        "mode": call.get("mode") or "audio",
        "received_at": int(_time.time() * 1000),
    }


@router.get('/calls/{call_id}/status')
async def get_call_status(call_id: str, user: dict = Depends(get_current_user)):
    call = await db.calls.find_one({"id": call_id}, {"_id": 0})
    if not call:
        raise HTTPException(status_code=404, detail="Call not found")
    if user["id"] not in call.get("member_ids", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    call = await enrich_call_for_user(call, user["id"])
    return public_call_status(call, user["id"])


@router.post('/calls/{call_id}/decline')
async def decline_call(call_id: str, user: dict = Depends(get_current_user)):
    return await _finish_call(call_id, user, "decline")


@router.post('/calls/{call_id}/cancel')
async def cancel_call(call_id: str, user: dict = Depends(get_current_user)):
    return await _finish_call(call_id, user, "cancel")


@router.post('/calls/{call_id}/timeout')
async def timeout_call(call_id: str, user: dict = Depends(get_current_user)):
    call = await db.calls.find_one({"id": call_id}, {"_id": 0})
    if not call:
        return {"timed_out": True, "ephemeral": True}
    if user["id"] not in call.get("member_ids", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    current_status = str(call.get("status") or "").lower()
    if (
        call.get("answered_at")
        or call.get("ended_at")
        or current_status in CALL_TERMINAL_STATUSES
        or (current_status in CALL_ACTIVE_STATUSES and current_status != "ringing")
    ):
        return {"timed_out": False, "status": call.get("status"), "idempotent": True}
    ended_iso = now_utc().isoformat()
    await db.calls.update_one(
        {"id": call_id, "answered_at": None, "ended_at": None},
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
        "call_id": call_id,
        "from": "timeout",
        "data": {"call_id": call_id, "status": "missed", "ended_by": "timeout"},
    }
    await broadcast_to_members(call.get("member_ids", []), event)
    asyncio.create_task(_send_call_control_push(call, "missed", "timeout"))
    return {"timed_out": True, "status": "missed"}


@router.post('/calls/{call_id}/state')
async def update_call_client_state(
    call_id: str,
    payload: CallStateUpdateIn,
    user: dict = Depends(get_current_user),
):
    await enforce_rate_limit(
        "call-state-user-minute", user["id"], limit=120, window_seconds=60
    )
    call = await db.calls.find_one({"id": call_id}, {"_id": 0})
    if not call:
        return {"updated": False, "ephemeral": True}
    if user["id"] not in call.get("member_ids", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    if call.get("ended_at") or str(call.get("status") or "").lower() in CALL_TERMINAL_STATUSES:
        return {"updated": False, "status": call.get("status"), "idempotent": True}

    now_iso = now_utc().isoformat()
    client_state = {
        "user_id": user["id"],
        "peer_connection_state": payload.peer_connection_state or "",
        "local_audio_enabled": payload.local_audio_enabled,
        "remote_audio_connected": payload.remote_audio_connected,
        "updated_at": now_iso,
    }
    update_doc: dict = {
        "last_updated_at": now_iso,
        "lastUpdatedAt": now_iso,
        f"lastKnownClientState.{user['id']}": client_state,
    }
    if payload.status:
        update_doc["status"] = payload.status
    await db.calls.update_one({"id": call_id}, {"$set": update_doc})

    event = {
        "type": "call:state_sync",
        "event": "call.state_sync",
        "call_id": call_id,
        "from": user["id"],
        "data": {
            "call_id": call_id,
            "status": payload.status or call.get("status"),
            "updated_at": now_iso,
        },
    }
    await broadcast_to_members(call.get("member_ids", []), event)
    return {"updated": True, "status": payload.status or call.get("status")}


@router.get('/calls')
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


@router.get('/calls/missed')
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


@router.post('/calls/missed/seen')
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


@router.get('/calls/{call_id}')
async def get_call(call_id: str, user: dict = Depends(get_current_user)):
    """Return one call history entry for the current user."""
    call = await db.calls.find_one({"id": call_id}, {"_id": 0})
    if not call:
        raise HTTPException(status_code=404, detail="Call not found")
    if user["id"] not in call.get("member_ids", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    return await enrich_call_for_user(call, user["id"])


@router.delete('/calls/{call_id}')
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


@router.delete('/calls')
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
