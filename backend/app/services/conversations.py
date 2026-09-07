from datetime import datetime, timezone

from fastapi import HTTPException

from app.core.database import db
from app.services.users import public_user


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
