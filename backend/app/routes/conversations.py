import asyncio
import uuid
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Request, Depends, HTTPException
from pymongo import UpdateOne

from app.core.config import (
    logger, SUPPORTED_VOICE_ATTACHMENT_MIME_TYPES, VOICE_MESSAGE_MAX_DURATION_MS,
    MAX_ENCRYPTED_ATTACHMENT_SIZE,
)
from app.core.database import db
from app.core.utils import api_error, now_utc, client_ip, enforce_rate_limit
from app.core.auth import get_current_user
from app.services.users import (
    public_user, ensure_not_blocked_between, ensure_direct_conversation_not_blocked,
    require_conversation_e2ee_ready, conversation_e2ee_ready, user_can_signal_target,
)
from app.services.conversations import (
    _hydrate_conversation, _require_group_admin, _human_duration, _normalize_message_dates,
)
from app.services.push import _send_push_to_members, _send_push_to_user
from app.services.ws_manager import broadcast_to_members
from app.models import (
    ConversationCreateIn, ConversationUpdateIn, GroupMembersIn,
    DisappearingIn, MessageSendIn, ReactionIn,
)

router = APIRouter()


@router.post('/conversations')
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


@router.patch('/conversations/{conv_id}')
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


@router.post('/conversations/{conv_id}/members')
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


@router.delete('/conversations/{conv_id}/members/{user_id}')
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


@router.post('/conversations/{conv_id}/admins/{user_id}')
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


@router.delete('/conversations/{conv_id}/admins/{user_id}')
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


@router.get('/conversations')
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


@router.get('/conversations/{conv_id}')
async def get_conversation(conv_id: str, user: dict = Depends(get_current_user)):
    conv = await db.conversations.find_one(
        {"id": conv_id, "member_ids": user["id"]}, {"_id": 0}
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return await _hydrate_conversation(conv, user["id"])


@router.patch('/conversations/{conv_id}/disappearing')
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


@router.get('/conversations/{conv_id}/messages')
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


@router.post('/messages')
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


@router.post('/messages/{msg_id}/open-once')
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


@router.post('/messages/{msg_id}/screenshot')
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


@router.post('/messages/{msg_id}/reactions')
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


@router.delete('/messages/{msg_id}')
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


@router.delete('/conversations/{conv_id}')
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
