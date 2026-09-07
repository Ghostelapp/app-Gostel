import re
from datetime import timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException

from app.core.config import APP_NAME
from app.core.database import db
from app.core.utils import now_utc, _USERNAME_RE
from app.core.auth import get_current_user
from app.services.users import public_user, normalize_username, is_username_taken
from app.services.ws_manager import broadcast_to_members
from app.models import (
    ProfileUpdateIn, AvatarUpdateIn, StatusUpdateIn, MuteUserIn,
)

router = APIRouter()


@router.get('/users')
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


@router.get('/users/search')
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
            {"username": {"$regex": f"^{re.escape(qn_lower)}", "$options": "i"}},
            {"name": {"$regex": qn, "$options": "i"}},
        ],
    }
    cursor = db.users.find(query, {"_id": 0}).limit(20)
    return [public_user(u) async for u in cursor]


@router.patch('/users/me')
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


@router.patch('/users/me/avatar')
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


@router.post('/users/me/heartbeat')
async def heartbeat(user: dict = Depends(get_current_user)):
    """Marks the user as actively online. Frontend should ping every ~60s while in
    foreground. Used to compute 'online' vs 'last seen' for other users."""
    now = now_utc().isoformat()
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"last_active": now, "last_seen": now}},
    )
    return {"ok": True, "last_active": now}


@router.get('/users/me/export')
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


@router.delete('/users/me')
async def delete_my_account(user: dict = Depends(get_current_user)):
    deleted = await delete_user_account_data(user["id"])
    if not deleted:
        raise HTTPException(status_code=404, detail="User not found")
    return {"deleted": True}


@router.patch('/users/me/status')
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


@router.get('/users/{user_id}')
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


@router.post('/users/me/mute_user/{target_id}')
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


@router.delete('/users/me/mute_user/{target_id}')
async def unmute_user(target_id: str, user: dict = Depends(get_current_user)):
    await db.users.update_one(
        {"id": user["id"]},
        {"$unset": {f"muted_users.{target_id}": ""}},
    )
    return {"muted": False}
