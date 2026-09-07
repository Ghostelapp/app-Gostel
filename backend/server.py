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
from pydantic import ValidationError

# ----------------- Modular imports -----------------
from app.core.config import JWT_SECRET, JWT_ALG, APP_NAME, ALLOW_LEGACY_WS_TOKEN, REMOVED_ASSISTANT_USER_ID, MAX_ENCRYPTED_ATTACHMENT_SIZE, VOICE_MESSAGE_MAX_DURATION_MS, SUPPORTED_VOICE_ATTACHMENT_MIME_TYPES, logger
from app.core.utils import api_error, now_utc, ensure_utc, client_ip, request_client_meta, enforce_rate_limit
from app.core.auth import hash_password, verify_password, create_access_token, create_ws_ticket, persist_user_session, revoke_access_token_jti, revoke_user_session, public_session, get_current_user, require_admin
from app.services.push import (
    normalize_call_signal_envelope, _configured_turn_servers,
    _fetch_cloudflare_ice_servers, get_ice_servers, start_call,
    public_call_status, expire_stale_ringing_calls_for_user, get_active_call,
    ring_call, accept_call, call_diag, _persist_call_signal_payload,
    persist_call_signal, persist_call_offer, persist_call_answer,
    persist_call_ice_candidate, list_call_signals, _finish_call, end_call,
    enrich_call_for_user, get_active_incoming_call, get_call_status,
    decline_call, cancel_call, timeout_call, update_call_client_state,
    list_calls, missed_calls_count, mark_missed_as_seen, get_call,
    delete_call_entry, clear_call_history,
)
from app.services.calls import (
    user_has_push_token, normalize_push_device_id, user_push_targets,
    compact_push_targets, push_target_install_key, sync_user_push_legacy_fields,
    remove_push_token_from_users, remove_push_device_from_users,
    remove_push_device_from_other_users, remove_push_tokens_for_session,
    _send_invite_push, _send_simple_push, _send_push_to_user,
    _send_push_to_members, _send_call_control_push,
    expo_push_sound_name, sanitize_diag_value,
)
from app.services.websocket import WSManager, broadcast_to_members, issue_ws_ticket, websocket_endpoint
from app.services.users import public_user, normalize_username, is_username_taken, generate_unique_username, ensure_not_blocked_between, ensure_direct_conversation_not_blocked, require_conversation_e2ee_ready, conversation_e2ee_ready, user_can_signal_target
from app.services.conversations import _hydrate_conversation, _require_group_admin, _human_duration, _normalize_message_dates
from app.routes import auth as auth_routes
from app.routes import users as users_routes
from app.routes import contacts as contacts_routes
from app.core.database import db
from app.models import *


app = FastAPI(title="ghostel.app Enterprise API")
api = APIRouter(prefix="/api")



# ----------------- Helpers -----------------


















































import re as _re
_USERNAME_RE = _re.compile(r"^[a-z0-9_]{3,20}$")




















# ----------------- Auth Routes -----------------
@api.post("/auth/register")


@api.post("/auth/login")


@api.get("/auth/username-available")


@api.get("/auth/me")


@api.post("/auth/logout")


@api.get("/auth/sessions")


@api.delete("/auth/sessions/{session_id}")


# ----------------- E2EE key registry -----------------
@api.post("/e2ee/keys")


@api.get("/e2ee/users/{user_id}/key")


@api.post("/auth/2fa/setup")


@api.post("/auth/2fa/enable")


@api.post("/auth/2fa/disable")


# ----------------- Users / Profile -----------------
@api.get("/users")


@api.get("/users/search")


@api.patch("/users/me")


@api.patch("/users/me/avatar")


@api.post("/users/me/heartbeat")


@api.get("/users/me/export")




@api.delete("/users/me")


# ----------------- Contacts -----------------


@api.get("/contacts")


@api.get("/contacts/invitations")


@api.post("/contacts/invite")








@api.post("/contacts/invitations/{inv_id}/accept")


@api.post("/contacts/invitations/{inv_id}/reject")


@api.delete("/contacts/invitations/{inv_id}")


@api.delete("/contacts/{user_id}")


@api.patch("/users/me/status")


# ----------------- Conversations -----------------


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




# ----------------- Messages -----------------


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
    await enforce_rate_limit(
        "message-send-user", user["id"], limit=180, window_seconds=60
    )
    await enforce_rate_limit(
        "message-send-conversation",
        f"{user['id']}:{payload.conversation_id}",
        limit=90,
        window_seconds=60,
    )
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
    if payload.kind == "voice":
        if not payload.attachment_id or not payload.e2ee_attachment:
            raise HTTPException(
                status_code=400,
                detail=api_error("INVALID_AUDIO_UPLOAD", "Voice messages require encrypted audio metadata"),
            )
        if not payload.duration_ms or payload.duration_ms <= 0:
            raise HTTPException(
                status_code=400,
                detail=api_error("INVALID_AUDIO_UPLOAD", "Voice message duration is required"),
            )
        if payload.duration_ms > VOICE_MESSAGE_MAX_DURATION_MS:
            logger.info(
                f"VOICE_UPLOAD_FAILED_413 reason=duration duration_ms={payload.duration_ms}"
            )
            raise HTTPException(
                status_code=413,
                detail=api_error("VOICE_MESSAGE_TOO_LARGE", "Voice message is too long"),
            )
        original_mime = (payload.e2ee_attachment.mime or "").split(";", 1)[0].strip().lower()
        logger.info(
            f"VOICE_UPLOAD_FORMAT_CHECK mime={original_mime} duration_ms={payload.duration_ms}"
        )
        if original_mime not in SUPPORTED_VOICE_ATTACHMENT_MIME_TYPES:
            logger.info(f"VOICE_UPLOAD_FAILED_UNSUPPORTED_FORMAT mime={original_mime}")
            raise HTTPException(
                status_code=415,
                detail=api_error("UNSUPPORTED_AUDIO_FORMAT", "Unsupported voice message audio format"),
            )
        if payload.e2ee_attachment.size and payload.e2ee_attachment.size > MAX_ENCRYPTED_ATTACHMENT_SIZE:
            logger.info(
                f"VOICE_UPLOAD_FAILED_413 reason=size size={payload.e2ee_attachment.size}"
            )
            raise HTTPException(
                status_code=413,
                detail=api_error("VOICE_MESSAGE_TOO_LARGE", "Voice message is too large"),
            )
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


@api.get("/users/{user_id}")


@api.post("/users/me/mute_user/{target_id}")


@api.delete("/users/me/mute_user/{target_id}")


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
    activity_chart = await _admin_activity_chart()
    registrations_chart = await _admin_collection_date_chart(db.users, "created_at", "count")
    messages_chart = await _admin_collection_date_chart(db.messages, "created_at", "count")
    return {
        "users": users,
        "conversations": convs,
        "messages": msgs,
        "online": online,
        "two_factor_enabled": twofa,
        "push_ready": push_ready,
        "activity_chart": activity_chart,
        "registrations_chart": registrations_chart,
        "messages_chart": messages_chart,
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


@api.get("/admin/health")
async def admin_health_check(admin: dict = Depends(require_admin)):
    """Admin endpoint to check backend health and system status"""
    import subprocess
    import psutil
    from datetime import datetime
    
    try:
        # Database check
        db_ok = False
        try:
            await db.users.count_documents({}, limit=1)
            db_ok = True
        except Exception as e:
            logger.error(f"DB health check failed: {e}")
        
        # System info
        cpu_percent = psutil.cpu_percent(interval=0.1)
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage('/')
        
        # Process info
        process = psutil.Process()
        process_memory = process.memory_info().rss / 1024 / 1024  # MB
        
        return {
            "status": "healthy" if db_ok else "unhealthy",
            "timestamp": datetime.utcnow().isoformat(),
            "database": {
                "connected": db_ok,
            },
            "system": {
                "cpu_percent": cpu_percent,
                "memory_percent": memory.percent,
                "memory_available_mb": memory.available / 1024 / 1024,
                "disk_percent": disk.percent,
                "disk_free_gb": disk.free / 1024 / 1024 / 1024,
            },
            "process": {
                "memory_mb": process_memory,
                "uptime_seconds": (datetime.now() - datetime.fromtimestamp(process.create_time())).total_seconds(),
            },
        }
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return {
            "status": "error",
            "error": str(e),
            "timestamp": datetime.utcnow().isoformat(),
        }


@api.post("/admin/restart")
async def admin_restart_backend(admin: dict = Depends(require_admin)):
    """Admin endpoint to restart the backend service via systemctl"""
    import subprocess
    
    try:
        # Log the restart request
        logger.warning(f"Backend restart requested by admin: {admin['email']}")
        
        # Restart the systemd service in background
        subprocess.Popen(
            ["sudo", "systemctl", "restart", "ghostel-backend"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        
        return {
            "status": "restarting",
            "message": "Backend restart initiated. Service will be back online in ~10 seconds.",
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception as e:
        logger.error(f"Backend restart failed: {e}")
        raise HTTPException(status_code=500, detail=f"Restart failed: {str(e)}")


# ----------------- Uploads (encrypted attachments) -----------------
@api.post("/uploads")
async def upload_attachment(request: Request, user: dict = Depends(get_current_user)):
    await enforce_rate_limit(
        "upload-user-minute", user["id"], limit=12, window_seconds=60
    )
    await enforce_rate_limit(
        "upload-user-hour", user["id"], limit=80, window_seconds=60 * 60
    )
    content_type = (request.headers.get("content-type") or "").lower()
    upload_kind = ""
    if content_type.startswith("multipart/form-data"):
        try:
            form = await request.form()
        except Exception:
            raise HTTPException(
                status_code=400,
                detail=api_error("INVALID_AUDIO_UPLOAD", "Invalid multipart upload"),
            )
        upload_file = (
            form.get("encryptedAudioFile")
            or form.get("file")
            or form.get("encrypted_file")
        )
        if upload_file is None or not hasattr(upload_file, "read"):
            raise HTTPException(
                status_code=400,
                detail=api_error("INVALID_AUDIO_UPLOAD", "Encrypted upload file is required"),
        )
        upload_kind = str(form.get("kind") or form.get("uploadKind") or "").strip().lower()
        if upload_kind == "voice":
            logger.info("VOICE_UPLOAD_STARTED transport=multipart")
        filename = Path(
            str(form.get("filename") or getattr(upload_file, "filename", "") or "attachment.ghostel")
        ).name.strip()[:200] or "attachment.ghostel"
        mime = str(
            form.get("mime")
            or getattr(upload_file, "content_type", "")
            or "application/octet-stream"
        ).strip()
        decoded = await upload_file.read(MAX_ENCRYPTED_ATTACHMENT_SIZE + 1)
        real_size = len(decoded)
        if upload_kind == "voice":
            logger.info(
                f"VOICE_UPLOAD_SIZE_CHECK size={real_size} limit={MAX_ENCRYPTED_ATTACHMENT_SIZE}"
            )
        if real_size > MAX_ENCRYPTED_ATTACHMENT_SIZE:
            if upload_kind == "voice":
                logger.info(f"VOICE_UPLOAD_FAILED_413 reason=encrypted_blob_size size={real_size}")
            raise HTTPException(
                status_code=413,
                detail=api_error(
                    "VOICE_MESSAGE_TOO_LARGE" if upload_kind == "voice" else "ATTACHMENT_TOO_LARGE",
                    "Voice message is too large" if upload_kind == "voice" else "Attachment is too large",
                ),
            )
        payload_data = base64.b64encode(decoded).decode()
    else:
        try:
            body = await request.json()
            payload = UploadIn.model_validate(body)
            decoded = base64.b64decode(payload.data, validate=True)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=exc.errors())
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=400, detail="Invalid base64 payload")

        real_size = len(decoded)
        filename = Path(payload.filename).name.strip()[:200] or "attachment.ghostel"
        mime = payload.mime
        payload_data = payload.data

    if real_size > MAX_ENCRYPTED_ATTACHMENT_SIZE:
        raise HTTPException(
            status_code=413,
            detail=api_error("ATTACHMENT_TOO_LARGE", "Attachment is too large"),
        )

    if mime != "application/octet-stream" or not filename.endswith(".ghostel"):
        raise HTTPException(
            status_code=400,
            detail=api_error("INVALID_AUDIO_UPLOAD", "Attachments must be encrypted before upload"),
        )
    att = {
        "id": str(uuid.uuid4()),
        "owner_id": user["id"],
        "filename": filename,
        "mime": mime,
        "data": payload_data,  # encrypted blob stored as base64
        "size": real_size,
        "created_at": now_utc().isoformat(),
    }
    await db.attachments.insert_one(att)
    if upload_kind == "voice":
        logger.info(f"VOICE_UPLOAD_SUCCESS size={real_size}")
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


@api.post("/push/register")
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


@api.get("/push/devices")
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


@api.post("/push/unregister")
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


@api.post("/support/report")
async def create_support_report(
    request: Request,
    payload: SupportReportIn,
    user: dict = Depends(get_current_user),
):
    await enforce_rate_limit(
        "support-report-user", user["id"], limit=10, window_seconds=60 * 60
    )
    now_iso = now_utc().isoformat()
    diagnostics = sanitize_diag_value(payload.diagnostics or {}) or {}
    local_doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "email": user.get("email"),
        "name": user.get("name") or user.get("email"),
        "category": payload.category,
        "subject": payload.subject.strip(),
        "message": payload.message.strip(),
        "platform": payload.platform,
        "app_version": (payload.app_version or "").strip(),
        "diagnostics": diagnostics,
        "created_at": now_iso,
        "status": "created",
        "ip_hash": hashlib.sha256(client_ip(request).encode("utf-8")).hexdigest(),
    }
    await db.support_reports.insert_one(local_doc)

    support_api = os.environ.get(
        "SUPPORT_CONTACT_API_URL",
        "https://panel-api.ghostel.app/api/contact",
    )
    support_payload = {
        "name": user.get("name") or user.get("email") or "Ghostel user",
        "email": user.get("email"),
        "category": "technical" if payload.category in {"call", "push", "device", "bug"} else "account",
        "app_platform": payload.platform,
        "app_version": payload.app_version or "",
        "subject": f"[App] {payload.subject.strip()}",
        "message": "\n\n".join(
            [
                payload.message.strip(),
                f"User: {user.get('email')} ({user.get('id')})",
                f"Category: {payload.category}",
                f"Platform: {payload.platform}",
                f"App version: {payload.app_version or '-'}",
                "Diagnostics:",
                json.dumps(diagnostics, ensure_ascii=False, indent=2)[:3500],
            ]
        ),
    }
    panel_result: dict = {"forwarded": False}
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            resp = await client.post(support_api, json=support_payload)
            panel_result["status_code"] = resp.status_code
            if resp.status_code < 400:
                data = resp.json()
                panel_result.update(data if isinstance(data, dict) else {})
                panel_result["forwarded"] = True
                await db.support_reports.update_one(
                    {"id": local_doc["id"]},
                    {"$set": {"status": "forwarded", "panel_response": panel_result}},
                )
            else:
                panel_result["error"] = resp.text[:500]
                await db.support_reports.update_one(
                    {"id": local_doc["id"]},
                    {"$set": {"status": "forward_failed", "panel_response": panel_result}},
                )
    except Exception as e:
        panel_result["error"] = str(e)[:500]
        await db.support_reports.update_one(
            {"id": local_doc["id"]},
            {"$set": {"status": "forward_failed", "panel_response": panel_result}},
        )

    return {
        "ok": True,
        "local_id": local_doc["id"],
        "forwarded": panel_result.get("forwarded", False),
        "ticket_id": panel_result.get("ticket_id"),
    }






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


@api.post("/calls/start")






@api.get("/calls/active")


@api.post("/calls/{call_id}/ring")


@api.post("/calls/{call_id}/accept")


@api.post("/calls/{call_id}/diag")




@api.post("/calls/{call_id}/signals")


@api.post("/calls/{call_id}/offer")


@api.post("/calls/{call_id}/answer")


@api.post("/calls/{call_id}/ice-candidate")


@api.get("/calls/{call_id}/signals")




@api.post("/calls/{call_id}/end")


# ----------------- Call history -----------------


@api.get("/calls/active-incoming")


@api.get("/calls/{call_id}/status")


@api.post("/calls/{call_id}/decline")


@api.post("/calls/{call_id}/cancel")


@api.post("/calls/{call_id}/timeout")


@api.post("/calls/{call_id}/state")


@api.get("/calls")


@api.get("/calls/missed")


@api.post("/calls/missed/seen")


@api.get("/calls/{call_id}")


@api.delete("/calls/{call_id}")


@api.delete("/calls")


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


ws_manager = WSManager()




@api.post("/ws-ticket")


@app.websocket("/api/ws")


# ----------------- Health -----------------
@api.get("/")
async def root():
    return {"app": APP_NAME, "version": "1.0.0", "status": "ok"}


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
api.include_router(auth_routes.router)
api.include_router(users_routes.router)
api.include_router(contacts_routes.router)

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