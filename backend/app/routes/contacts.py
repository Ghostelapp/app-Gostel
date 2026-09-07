import asyncio
import uuid
from fastapi import APIRouter, Depends, HTTPException

from app.core.database import db
from app.core.utils import now_utc, enforce_rate_limit
from app.core.auth import get_current_user
from app.services.users import public_user, normalize_username
from app.services.push import _send_push_to_user, _send_invite_push
from app.services.ws_manager import broadcast_to_members
from app.models import ContactInviteIn

router = APIRouter()


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


@router.get('/contacts')
async def list_contacts(user: dict = Depends(get_current_user)):
    contact_ids = user.get("contact_ids") or []
    if not contact_ids:
        return []
    cursor = db.users.find({"id": {"$in": contact_ids}}, {"_id": 0})
    contacts = [public_user(u) async for u in cursor]
    # Sort contacts alphabetically
    contacts.sort(key=lambda c: (c.get("name") or "").lower())
    return contacts


@router.get('/contacts/invitations')
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


@router.post('/contacts/invite')
async def invite_contact(payload: ContactInviteIn, user: dict = Depends(get_current_user)):
    await enforce_rate_limit(
        "contact-invite-user", user["id"], limit=40, window_seconds=60 * 60
    )
    target_un = normalize_username(payload.username)
    if not target_un:
        raise HTTPException(status_code=400, detail="Invalid username")
    await enforce_rate_limit(
        "contact-invite-target",
        f"{user['id']}:{target_un}",
        limit=8,
        window_seconds=60 * 60,
    )
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


@router.post('/contacts/invitations/{inv_id}/accept')
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


@router.post('/contacts/invitations/{inv_id}/reject')
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


@router.delete('/contacts/invitations/{inv_id}')
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


@router.delete('/contacts/{user_id}')
async def remove_contact(user_id: str, user: dict = Depends(get_current_user)):
    if user_id not in (user.get("contact_ids") or []):
        raise HTTPException(status_code=404, detail="Not in your contacts")
    await db.users.update_one({"id": user["id"]}, {"$pull": {"contact_ids": user_id}})
    await db.users.update_one({"id": user_id}, {"$pull": {"contact_ids": user["id"]}})
    return {"ok": True}
