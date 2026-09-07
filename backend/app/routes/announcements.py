"""Announcement endpoints."""

import uuid
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from pymongo import ReturnDocument

from app.core.auth import get_current_user, require_admin
from app.core.config import logger
from app.core.database import db
from app.core.utils import now_utc
from app.services.announcements import (
    AnnouncementCreateIn,
    AnnouncementUpdateIn,
    _announcement_public,
    _announcement_audience_count,
    _announcement_version_matches,
    _send_announcement_push,
    _validate_announcement_data,
)

router = APIRouter()


class AnnouncementReadReceipt(BaseModel):
    read_at: Optional[str] = None
    acknowledged_at: Optional[str] = None


@router.get("/announcements")
async def list_user_announcements(
    platform: Literal["android", "ios", "web"],
    app_version: str = "",
    language: str = "en",
    user: dict = Depends(get_current_user),
):
    now = now_utc()
    query: dict[str, Any] = {
        "status": "published",
        "$and": [
            {"$or": [{"starts_at": None}, {"starts_at": {"$lte": now}}]},
            {"$or": [{"ends_at": None}, {"ends_at": {"$gt": now}}]},
            {"$or": [{"target_platform": "all"}, {"target_platform": platform}]},
            {"$or": [{"target_user_ids": []}, {"target_user_ids": user["id"]}]},
        ],
    }
    docs = await db.announcements.find(query, {"_id": 0}).sort("published_at", -1).limit(100).to_list(100)
    docs = [doc for doc in docs if _announcement_version_matches(app_version, doc.get("min_version") or "", doc.get("max_version") or "")]
    ids = [doc["id"] for doc in docs]
    receipts = await db.announcement_receipts.find({"announcement_id": {"$in": ids}, "user_id": user["id"]}, {"_id": 0}).to_list(100)
    by_id = {receipt["announcement_id"]: receipt for receipt in receipts}
    return [_announcement_public(doc, by_id.get(doc["id"]), language) for doc in docs]


@router.get("/announcements/active")
async def active_user_announcements(
    platform: Literal["android", "ios", "web"],
    app_version: str = "",
    language: str = "en",
    user: dict = Depends(get_current_user),
):
    items = await list_user_announcements(platform, app_version, language, user)
    return [
        item for item in items
        if (
            item.get("requires_acknowledgement") and not item.get("acknowledged_at")
        ) or (
            not item.get("requires_acknowledgement") and not item.get("read_at")
        )
    ]


async def _record_announcement_receipt(announcement_id: str, user: dict, acknowledge: bool) -> dict:
    announcement = await db.announcements.find_one(
        {"id": announcement_id, "status": "published"},
        {"_id": 0, "id": 1, "target_user_ids": 1},
    )
    if not announcement:
        raise HTTPException(status_code=404, detail="Announcement not found")
    if announcement.get("target_user_ids") and user["id"] not in announcement["target_user_ids"]:
        raise HTTPException(status_code=404, detail="Announcement not found")
    now = now_utc()
    values = {"read_at": now, "updated_at": now}
    if acknowledge:
        values["acknowledged_at"] = now
    receipt = await db.announcement_receipts.find_one_and_update(
        {"announcement_id": announcement_id, "user_id": user["id"]},
        {"$set": values, "$setOnInsert": {"id": str(uuid.uuid4()), "created_at": now}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return {"ok": True, "read_at": receipt.get("read_at"), "acknowledged_at": receipt.get("acknowledged_at")}


@router.post("/announcements/{announcement_id}/read")
async def read_announcement(announcement_id: str, user: dict = Depends(get_current_user)):
    return await _record_announcement_receipt(announcement_id, user, False)


@router.post("/announcements/{announcement_id}/acknowledge")
async def acknowledge_announcement(announcement_id: str, user: dict = Depends(get_current_user)):
    return await _record_announcement_receipt(announcement_id, user, True)


@router.get("/admin/announcements")
async def admin_list_announcements(admin: dict = Depends(require_admin)):
    docs = await db.announcements.find({}, {"_id": 0}).sort("created_at", -1).limit(500).to_list(500)
    for doc in docs:
        doc["audience_count"] = await _announcement_audience_count(doc)
        doc["read_count"] = await db.announcement_receipts.count_documents({"announcement_id": doc["id"], "read_at": {"$ne": None}})
        doc["acknowledged_count"] = await db.announcement_receipts.count_documents({"announcement_id": doc["id"], "acknowledged_at": {"$ne": None}})
    return docs


@router.post("/admin/announcements")
async def admin_create_announcement(payload: AnnouncementCreateIn, admin: dict = Depends(require_admin)):
    try:
        data = _validate_announcement_data(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    now = now_utc()
    doc = {
        "id": str(uuid.uuid4()),
        **data,
        "status": "draft",
        "created_by": admin["id"],
        "created_at": now,
        "updated_at": now,
        "published_at": None,
        "push_sent_at": None,
        "push_dispatch_started_at": None,
        "push_success_count": 0,
        "push_failure_count": 0,
    }
    await db.announcements.insert_one(doc)
    doc.pop("_id", None)
    logger.info("ANNOUNCEMENT_DRAFT_CREATED id=%s admin=%s", doc["id"][:8], admin["id"][:8])
    return doc


@router.patch("/admin/announcements/{announcement_id}")
async def admin_update_announcement(announcement_id: str, payload: AnnouncementUpdateIn, admin: dict = Depends(require_admin)):
    existing = await db.announcements.find_one({"id": announcement_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Announcement not found")
    if existing.get("status") == "published":
        raise HTTPException(status_code=409, detail="Unpublish the announcement before editing")
    updates = payload.model_dump(exclude_unset=True)
    merged = _validate_announcement_data({**existing, **updates})
    allowed = set(AnnouncementUpdateIn.model_fields)
    values = {key: merged.get(key) for key in allowed if key in updates}
    values.update({"updated_at": now_utc(), "updated_by": admin["id"]})
    await db.announcements.update_one({"id": announcement_id}, {"$set": values})
    return await db.announcements.find_one({"id": announcement_id}, {"_id": 0})


@router.post("/admin/announcements/{announcement_id}/publish")
async def admin_publish_announcement(announcement_id: str, admin: dict = Depends(require_admin)):
    now = now_utc()
    doc = await db.announcements.find_one_and_update(
        {"id": announcement_id, "status": {"$in": ["draft", "unpublished"]}},
        {"$set": {"status": "published", "published_at": now, "updated_at": now, "updated_by": admin["id"], "push_sent_at": None, "push_dispatch_started_at": None}},
        return_document=ReturnDocument.AFTER,
    )
    if not doc:
        raise HTTPException(status_code=409, detail="Announcement is missing or already published")
    if doc.get("send_push") and (not doc.get("starts_at") or ensure_utc(doc["starts_at"]) <= now):
        asyncio.create_task(_send_announcement_push(announcement_id))
    logger.info("ANNOUNCEMENT_PUBLISHED id=%s admin=%s", announcement_id[:8], admin["id"][:8])
    doc.pop("_id", None)
    return doc


@router.post("/admin/announcements/{announcement_id}/unpublish")
async def admin_unpublish_announcement(announcement_id: str, admin: dict = Depends(require_admin)):
    result = await db.announcements.update_one(
        {"id": announcement_id, "status": "published"},
        {"$set": {"status": "unpublished", "updated_at": now_utc(), "updated_by": admin["id"]}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=409, detail="Announcement is not published")
    logger.info("ANNOUNCEMENT_UNPUBLISHED id=%s admin=%s", announcement_id[:8], admin["id"][:8])
    return {"ok": True}


@router.delete("/admin/announcements/{announcement_id}")
async def admin_archive_announcement(announcement_id: str, admin: dict = Depends(require_admin)):
    result = await db.announcements.update_one(
        {"id": announcement_id},
        {"$set": {"status": "archived", "updated_at": now_utc(), "updated_by": admin["id"]}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Announcement not found")
    return {"ok": True}
