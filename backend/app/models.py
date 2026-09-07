from datetime import datetime
from typing import Optional, Literal, List, Dict
from pydantic import BaseModel, Field, EmailStr

from app.core.config import MAX_ENCRYPTED_ATTACHMENT_SIZE, VOICE_MESSAGE_MAX_DURATION_MS


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(min_length=1, max_length=80)
    title: Optional[str] = ""
    username: Optional[str] = None


class LoginIn(BaseModel):
    email: Optional[str] = None
    identifier: Optional[str] = None
    password: str
    totp_code: Optional[str] = None


class TwoFAVerifyIn(BaseModel):
    code: str


class TwoFASetupIn(BaseModel):
    password: str = Field(min_length=1, max_length=128)


class StatusUpdateIn(BaseModel):
    status: Literal["online", "busy", "away", "offline"]
    custom_status: Optional[str] = ""


class ProfileUpdateIn(BaseModel):
    name: Optional[str] = None
    title: Optional[str] = None
    bio: Optional[str] = None
    username: Optional[str] = None


class AvatarUpdateIn(BaseModel):
    avatar: Optional[str] = None  # base64 data URI, set None/empty to remove. Max ~250KB.


class ContactInviteIn(BaseModel):
    username: str = Field(min_length=1, max_length=30)


class ConversationCreateIn(BaseModel):
    type: Literal["direct", "group"]
    member_ids: List[str]
    name: Optional[str] = None
    avatar: Optional[str] = None  # base64 data URI (small, <128KB)


class ConversationUpdateIn(BaseModel):
    name: Optional[str] = None
    avatar: Optional[str] = None  # base64 data URI; set "" to clear


class GroupMembersIn(BaseModel):
    member_ids: List[str] = Field(min_length=1, max_length=20)


class E2EERecipientPayload(BaseModel):
    nonce: str = Field(min_length=16, max_length=128)
    ciphertext: str = Field(min_length=16, max_length=20000)


class E2EEMessagePayload(BaseModel):
    version: Literal[1] = 1
    algorithm: Literal["nacl-box-v1"] = "nacl-box-v1"
    sender_public_key: str = Field(min_length=32, max_length=128)
    recipients: Dict[str, E2EERecipientPayload] = Field(default_factory=dict)


class E2EEAttachmentPayload(BaseModel):
    version: Literal[1] = 1
    algorithm: Literal["nacl-secretbox-v1"] = "nacl-secretbox-v1"
    nonce: str = Field(min_length=16, max_length=128)
    mime: str = Field(min_length=1, max_length=120)
    size: Optional[int] = Field(default=None, ge=0, le=MAX_ENCRYPTED_ATTACHMENT_SIZE)
    key_recipients: Dict[str, E2EERecipientPayload] = Field(default_factory=dict)


class E2EEKeyIn(BaseModel):
    public_key: str = Field(min_length=32, max_length=128)
    algorithm: Literal["nacl-box-v1"] = "nacl-box-v1"


class MessageSendIn(BaseModel):
    conversation_id: str
    content: str = Field(min_length=0, max_length=10000, default="")
    kind: Literal["text", "voice", "file", "image", "system"] = "text"
    reply_to: Optional[str] = None
    attachment_id: Optional[str] = None
    duration_ms: Optional[int] = None  # for voice
    encrypted: bool = False
    e2ee: Optional[E2EEMessagePayload] = None
    e2ee_attachment: Optional[E2EEAttachmentPayload] = None
    one_time_seconds: Optional[Literal[5]] = None


class ReactionIn(BaseModel):
    emoji: str = Field(min_length=1, max_length=8)


class UploadIn(BaseModel):
    filename: str = Field(min_length=1, max_length=200)
    mime: str = Field(min_length=1, max_length=120)
    data: str = Field(min_length=1)  # base64 string (no data: prefix)
    size: int = Field(ge=0, le=MAX_ENCRYPTED_ATTACHMENT_SIZE)


class PushTokenIn(BaseModel):
    token: str = Field(min_length=4, max_length=500)
    platform: Literal["ios", "android", "web"] = "web"
    # Accepts both raw Expo-style names ('android'/'ios') and explicit names
    # ('fcm'/'apns'). 'expo' kept for legacy ExpoPushToken[...] tokens.
    token_type: Literal["fcm", "apns", "expo", "voip", "android", "ios"] = "fcm"
    device_id: Optional[str] = Field(default=None, min_length=8, max_length=80)
    device_model: Optional[str] = None
    os_version: Optional[str] = None
    source: Optional[str] = None


class PushUnregisterIn(BaseModel):
    token: Optional[str] = Field(default=None, min_length=4, max_length=500)
    device_id: Optional[str] = Field(default=None, min_length=8, max_length=80)


class SupportReportIn(BaseModel):
    category: Literal["call", "push", "device", "account", "bug", "other"] = "bug"
    subject: str = Field(min_length=4, max_length=160)
    message: str = Field(min_length=10, max_length=5000)
    platform: Literal["ios", "android", "web", "desktop", "unknown"] = "unknown"
    app_version: Optional[str] = Field(default="", max_length=40)
    diagnostics: Optional[dict] = None


class CallStartIn(BaseModel):
    conversation_id: str
    mode: Literal["audio", "video"] = "audio"
    call_id: Optional[str] = Field(default=None, min_length=8, max_length=80)


class CallStateUpdateIn(BaseModel):
    status: Optional[Literal["connecting", "active", "reconnecting", "failed"]] = None
    peer_connection_state: Optional[str] = Field(default=None, max_length=40)
    local_audio_enabled: Optional[bool] = None
    remote_audio_connected: Optional[bool] = None


class DisappearingIn(BaseModel):
    seconds: Optional[int] = Field(default=None, ge=0, le=60 * 60 * 24 * 30)  # max 30 days


class PrivacyUpdateIn(BaseModel):
    save_call_history: Optional[bool] = None


class MuteUpdateIn(BaseModel):
    muted: bool


class MuteUserIn(BaseModel):
    # Duration in seconds (max 30 days). `None` or 0 means "forever".
    duration_seconds: Optional[int] = None


class RoleUpdateIn(BaseModel):
    role: Literal["admin", "moderator", "user", "guest"]


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
