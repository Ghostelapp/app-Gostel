import re as _re
from typing import Optional
from fastapi import HTTPException

from app.core.config import REMOVED_ASSISTANT_USER_ID, logger
from app.core.database import db
from app.core.utils import now_utc


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
