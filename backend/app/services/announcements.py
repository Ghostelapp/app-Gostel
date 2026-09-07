"""Announcement helpers and push dispatch."""

import asyncio
from datetime import datetime, timedelta
from typing import Any, Optional

import httpx
from pydantic import BaseModel, Field
from typing import Literal

from app.core.config import EXPO_PUSH_URL, logger
from app.core.database import db
from app.core.utils import ensure_utc, now_utc
from app.services.push import (
    compact_push_targets,
    push_target_install_key,
    remove_push_token_from_users,
    user_push_targets,
)

ANNOUNCEMENT_LANGUAGES = {"en", "pl", "de", "es", "fr"}


class AnnouncementTranslationIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=2000)
    action_label: Optional[str] = Field(default=None, max_length=40)


class AnnouncementCreateIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=2000)
    translations: dict[str, AnnouncementTranslationIn] = Field(default_factory=dict)
    severity: Literal["info", "warning", "critical"] = "info"
    presentation: Literal["banner", "modal", "inbox"] = "banner"
    target_platform: Literal["all", "android", "ios", "web"] = "all"
    target_user_ids: list[str] = Field(default_factory=list, max_length=1000)
    min_version: Optional[str] = Field(default=None, max_length=32)
    max_version: Optional[str] = Field(default=None, max_length=32)
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    action_label: Optional[str] = Field(default=None, max_length=40)
    action_url: Optional[str] = Field(default=None, max_length=500)
    requires_acknowledgement: bool = False
    send_push: bool = True


class AnnouncementUpdateIn(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    body: Optional[str] = Field(default=None, min_length=1, max_length=2000)
    translations: Optional[dict[str, AnnouncementTranslationIn]] = None
    severity: Optional[Literal["info", "warning", "critical"]] = None
    presentation: Optional[Literal["banner", "modal", "inbox"]] = None
    target_platform: Optional[Literal["all", "android", "ios", "web"]] = None
    target_user_ids: Optional[list[str]] = Field(default=None, max_length=1000)
    min_version: Optional[str] = Field(default=None, max_length=32)
    max_version: Optional[str] = Field(default=None, max_length=32)
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    action_label: Optional[str] = Field(default=None, max_length=40)
    action_url: Optional[str] = Field(default=None, max_length=500)
    requires_acknowledgement: Optional[bool] = None
    send_push: Optional[bool] = None


def _announcement_version(value: Optional[str]) -> tuple[int, ...]:
    if not value:
        return ()
    parts = []
    for chunk in str(value).strip().split("."):
        digits = "".join(char for char in chunk if char.isdigit())
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts[:4])


def _announcement_version_matches(app_version: str, minimum: str, maximum: str) -> bool:
    current = _announcement_version(app_version)
    if not current:
        return not minimum and not maximum
    if minimum and current < _announcement_version(minimum):
        return False
    if maximum and current > _announcement_version(maximum):
        return False
    return True


def _validate_announcement_data(data: dict) -> dict:
    translations = data.get("translations") or {}
    invalid_languages = set(translations) - ANNOUNCEMENT_LANGUAGES
    if invalid_languages:
        raise ValueError("Unsupported announcement language")
    starts_at = ensure_utc(data.get("starts_at"))
    ends_at = ensure_utc(data.get("ends_at"))
    if starts_at and ends_at and ends_at <= starts_at:
        raise ValueError("End date must be later than start date")
    action_url = (data.get("action_url") or "").strip()
    if action_url and not (
        action_url.startswith("/")
        or action_url.startswith("https://ghostel.app/")
        or action_url == "https://ghostel.app"
    ):
        raise ValueError("Action URL must be an internal path or ghostel.app URL")
    data["action_url"] = action_url or None
    data["starts_at"] = starts_at
    data["ends_at"] = ends_at
    data["target_user_ids"] = list(dict.fromkeys(data.get("target_user_ids") or []))
    return data


def _announcement_public(doc: dict, receipt: Optional[dict] = None, language: str = "en") -> dict:
    language = language if language in ANNOUNCEMENT_LANGUAGES else "en"
    translation = (doc.get("translations") or {}).get(language) or {}
    return {
        "id": doc["id"],
        "title": translation.get("title") or doc.get("title", ""),
        "body": translation.get("body") or doc.get("body", ""),
        "severity": doc.get("severity", "info"),
        "presentation": doc.get("presentation", "banner"),
        "action_label": translation.get("action_label") or doc.get("action_label"),
        "action_url": doc.get("action_url"),
        "requires_acknowledgement": bool(doc.get("requires_acknowledgement")),
        "starts_at": doc.get("starts_at"),
        "ends_at": doc.get("ends_at"),
        "published_at": doc.get("published_at"),
        "read_at": (receipt or {}).get("read_at"),
        "acknowledged_at": (receipt or {}).get("acknowledged_at"),
    }


async def _announcement_audience_count(doc: dict) -> int:
    query: dict[str, Any] = {"status": {"$ne": "blocked"}}
    target_ids = doc.get("target_user_ids") or []
    if target_ids:
        query["id"] = {"$in": target_ids}
    if doc.get("target_platform") in {"android", "ios"}:
        query["push_tokens.platform"] = doc["target_platform"]
    return await db.users.count_documents(query)


async def _send_announcement_push(announcement_id: str) -> None:
    stale_before = now_utc() - timedelta(minutes=10)
    doc = await db.announcements.find_one_and_update(
        {
            "id": announcement_id,
            "status": "published",
            "send_push": True,
            "push_sent_at": None,
            "$or": [
                {"push_dispatch_started_at": None},
                {"push_dispatch_started_at": {"$lt": stale_before}},
            ],
        },
        {"$set": {"push_dispatch_started_at": now_utc()}},
        return_document=True,
    )
    if not doc:
        return

    query: dict[str, Any] = {
        "status": {"$ne": "blocked"},
        "$or": [
            {"push_tokens.0": {"$exists": True}},
            {"push_token": {"$exists": True, "$ne": None}},
            {"expo_push_token": {"$exists": True, "$ne": None}},
        ],
    }
    if doc.get("target_user_ids"):
        query["id"] = {"$in": doc["target_user_ids"]}
    users = await db.users.find(query, {"_id": 0, "id": 1, "push_tokens": 1, "push_token": 1, "push_token_type": 1, "push_platform": 1, "expo_push_token": 1}).to_list(50000)
    platform = doc.get("target_platform", "all")
    targets = []
    for user_doc in users:
        for target in user_push_targets(user_doc):
            target_platform = str(target.get("platform") or "").lower()
            if platform in {"android", "ios"} and target_platform != platform:
                continue
            if target.get("token_type") == "voip":
                continue
            targets.append({**target, "user_id": user_doc["id"]})

    targets = compact_push_targets(targets)
    direct = [target for target in targets if target.get("token_type") in {"fcm", "apns"}]
    expo = [target for target in targets if target.get("token_type") == "expo"]
    delivered_installs: set[str] = set()
    success_count = 0
    failure_count = 0
    data = {
        "type": "admin_announcement",
        "screen": "announcements",
        "announcement_id": announcement_id,
    }
    try:
        from fcm import is_configured as fcm_is_configured, send_fcm
        if direct and fcm_is_configured():
            async with httpx.AsyncClient(timeout=10) as push_client:
                for target in direct:
                    result = await send_fcm(
                        push_client,
                        token=target["token"],
                        title="ghostel.app",
                        body="A new service announcement is available.",
                        channel_id="notifications",
                        sound="notification",
                        priority="high",
                        ttl_seconds=86400,
                        data=data,
                    )
                    if result.get("ok"):
                        success_count += 1
                        delivered_installs.add(push_target_install_key(target))
                    else:
                        failure_count += 1
                        error_code = result.get("fcm_error_code") or result.get("error")
                        if error_code in {"UNREGISTERED", "INVALID_ARGUMENT", "NOT_FOUND"}:
                            await remove_push_token_from_users(target["token"])

        expo_fallback = [target for target in expo if push_target_install_key(target) not in delivered_installs]
        if expo_fallback:
            payload = [{
                "to": target["token"],
                "title": "ghostel.app",
                "body": "A new service announcement is available.",
                "sound": "notification.wav",
                "priority": "high",
                "channelId": "notifications",
                "data": data,
            } for target in expo_fallback]
            async with httpx.AsyncClient(timeout=15) as push_client:
                response = await push_client.post(EXPO_PUSH_URL, json=payload)
                response.raise_for_status()
                tickets = response.json().get("data", [])
                success_count += sum(1 for ticket in tickets if ticket.get("status") == "ok")
                failure_count += sum(1 for ticket in tickets if ticket.get("status") != "ok")
    except Exception as exc:
        failure_count += 1
        logger.warning("Announcement push dispatch failed id=%s error=%s", announcement_id[:8], type(exc).__name__)
    finally:
        await db.announcements.update_one(
            {"id": announcement_id},
            {"$set": {
                "push_sent_at": now_utc(),
                "push_success_count": success_count,
                "push_failure_count": failure_count,
            }},
        )
        logger.info("ANNOUNCEMENT_PUSH_COMPLETE id=%s ok=%s failed=%s", announcement_id[:8], success_count, failure_count)


async def announcement_dispatch_loop() -> None:
    while True:
        try:
            now = now_utc()
            due = await db.announcements.find(
                {
                    "status": "published",
                    "send_push": True,
                    "push_sent_at": None,
                    "$or": [{"starts_at": None}, {"starts_at": {"$lte": now}}],
                },
                {"_id": 0, "id": 1},
            ).limit(50).to_list(50)
            for announcement in due:
                await _send_announcement_push(announcement["id"])
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.warning("Announcement scheduler failed: %s", type(exc).__name__)
        await asyncio.sleep(60)
