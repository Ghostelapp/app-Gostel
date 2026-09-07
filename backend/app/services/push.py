import httpx
from typing import Optional

from app.core.config import logger, EXPO_PUSH_URL, CALL_TERMINAL_STATUSES
from app.core.database import db
from app.core.utils import now_utc

# FCM / APNs imports are done lazily inside functions to avoid import-time failures


def user_has_push_token(u: dict) -> bool:
    return bool(u.get("push_tokens") or u.get("push_token") or u.get("expo_push_token"))


def normalize_push_device_id(value: Optional[str]) -> str:
    return (value or "").strip()[:80]


def user_push_targets(u: dict) -> list[dict]:
    """Return registered push targets.

    Modern clients store all transports in ``push_tokens``. Legacy single-token
    fields are only a fallback for accounts that have no modern registrations;
    mixing both paths for calls can deliver duplicate incoming-call alerts.
    """
    targets: list[dict] = []
    seen: set[str] = set()
    for entry in u.get("push_tokens") or []:
        if not isinstance(entry, dict):
            continue
        token = (entry.get("token") or "").strip()
        if not token or token in seen:
            continue
        seen.add(token)
        targets.append(
            {
                "token": token,
                "token_type": (entry.get("token_type") or "fcm").strip().lower(),
                "platform": entry.get("platform") or "unknown",
                "device_id": normalize_push_device_id(entry.get("device_id")),
                "session_id": (entry.get("session_id") or "").strip(),
                "device_model": entry.get("device_model") or "",
                "os_version": entry.get("os_version") or "",
                "source": entry.get("source") or "",
                "registered_at": entry.get("registered_at") or "",
            }
        )
    legacy = (u.get("push_token") or u.get("expo_push_token") or "").strip()
    if not targets and legacy and legacy not in seen:
        targets.append(
            {
                "token": legacy,
                "token_type": (u.get("push_token_type") or "fcm").strip().lower(),
                "platform": u.get("push_platform") or "unknown",
                "device_id": "",
                "session_id": "",
                "device_model": "",
                "os_version": "",
                "source": "legacy",
                "registered_at": "",
            }
        )
    return targets


def compact_push_targets(targets: list[dict]) -> list[dict]:
    """Keep one latest token per user/device/type delivery lane.

    A single install can register multiple times over app upgrades. Sending to
    every historical token is what produces duplicate ringing for one incoming
    call, so call pushes use the newest entry for each device/token type.
    """
    compacted: dict[tuple[str, str, str], dict] = {}
    token_seen: set[str] = set()
    for target in targets:
        token = (target.get("token") or "").strip()
        if not token or token in token_seen:
            continue
        token_seen.add(token)
        user_id = (target.get("user_id") or "").strip()
        device_id = normalize_push_device_id(target.get("device_id"))
        token_type = (target.get("token_type") or "fcm").strip().lower()
        key = (user_id, device_id or token, token_type)
        current = compacted.get(key)
        if not current or (target.get("registered_at") or "") >= (current.get("registered_at") or ""):
            compacted[key] = target
    return list(compacted.values())


def push_target_install_key(target: dict) -> str:
    """Stable key for one app install across multiple push transports."""
    user_id = (target.get("user_id") or "").strip()
    device_id = normalize_push_device_id(target.get("device_id"))
    if device_id:
        return f"{user_id}:device:{device_id}"
    token = (target.get("token") or "").strip()
    return f"{user_id}:token:{token}"


async def sync_user_push_legacy_fields(user_id: str) -> None:
    # Legacy mirror fields caused duplicate call delivery when a user also had
    # modern ``push_tokens``. Keep reading legacy fields for old accounts, but
    # never recreate them for clients that register through /push/register.
    await db.users.update_one(
        {"id": user_id},
        {
            "$unset": {
                "expo_push_token": "",
                "push_platform": "",
                "push_token": "",
                "push_token_type": "",
            }
        },
    )


async def remove_push_token_from_users(
    token: str,
    user_id: Optional[str] = None,
    *,
    sync_legacy: bool = True,
) -> int:
    """Remove one physical device token from one account or from every account."""
    token = (token or "").strip()
    if not token:
        return 0
    affected_ids: set[str] = set()
    async for entry in db.users.find(
        {
            **({"id": user_id} if user_id else {}),
            "$or": [
                {"push_tokens.token": token},
                {"push_token": token},
                {"expo_push_token": token},
            ],
        },
        {"_id": 0, "id": 1},
    ):
        if entry.get("id"):
            affected_ids.add(entry["id"])
    user_filter = {"id": user_id} if user_id else {}
    await db.users.update_many(
        {**user_filter, "push_tokens.token": token},
        {"$pull": {"push_tokens": {"token": token}}},
    )
    await db.users.update_many(
        {
            **user_filter,
            "$or": [
                {"push_token": token},
                {"expo_push_token": token},
            ],
        },
        {
            "$unset": {
                "expo_push_token": "",
                "push_platform": "",
                "push_token": "",
                "push_token_type": "",
            }
        },
    )
    if sync_legacy:
        for affected_id in affected_ids:
            await sync_user_push_legacy_fields(affected_id)
    return len(affected_ids)


async def remove_push_device_from_users(device_id: str, user_id: Optional[str] = None) -> int:
    device_id = normalize_push_device_id(device_id)
    if not device_id:
        return 0
    affected_ids: set[str] = set()
    async for entry in db.users.find(
        {
            **({"id": user_id} if user_id else {}),
            "push_tokens.device_id": device_id,
        },
        {"_id": 0, "id": 1},
    ):
        if entry.get("id"):
            affected_ids.add(entry["id"])
    await db.users.update_many(
        {
            **({"id": user_id} if user_id else {}),
            "push_tokens.device_id": device_id,
        },
        {"$pull": {"push_tokens": {"device_id": device_id}}},
    )
    for affected_id in affected_ids:
        await sync_user_push_legacy_fields(affected_id)
    return len(affected_ids)


async def remove_push_device_from_other_users(device_id: str, user_id: str) -> int:
    """Move one physical phone to the current account without deleting its
    other transports from the same account.

    iOS registers multiple transports for the same install (PushKit VoIP, FCM
    and Expo fallback). Removing the whole device on every /push/register call
    made the last transport delete the previous ones, which broke VoIP/CallKit.
    """
    device_id = normalize_push_device_id(device_id)
    if not device_id:
        return 0
    affected_ids: set[str] = set()
    async for entry in db.users.find(
        {
            "id": {"$ne": user_id},
            "push_tokens.device_id": device_id,
        },
        {"_id": 0, "id": 1},
    ):
        if entry.get("id"):
            affected_ids.add(entry["id"])
    await db.users.update_many(
        {
            "id": {"$ne": user_id},
            "push_tokens.device_id": device_id,
        },
        {"$pull": {"push_tokens": {"device_id": device_id}}},
    )
    for affected_id in affected_ids:
        await sync_user_push_legacy_fields(affected_id)
    return len(affected_ids)


async def remove_push_tokens_for_session(user_id: str, session_id: Optional[str]) -> int:
    session_id = (session_id or "").strip()
    if not session_id:
        return 0
    user = await db.users.find_one(
        {"id": user_id},
        {"_id": 0, "push_tokens": 1},
    )
    if not user:
        return 0
    removed = len(
        [
            entry
            for entry in (user.get("push_tokens") or [])
            if isinstance(entry, dict) and (entry.get("session_id") or "").strip() == session_id
        ]
    )
    if removed == 0:
        return 0
    await db.users.update_one(
        {"id": user_id},
        {"$pull": {"push_tokens": {"session_id": session_id}}},
    )
    await sync_user_push_legacy_fields(user_id)
    return removed


async def _send_invite_push(target: dict, sender: dict):
    """Push notification for incoming contact invitation. Uses Direct FCM."""
    try:
        token = target.get("push_token") or target.get("expo_push_token")
        if not token:
            return
        token_type = target.get("push_token_type") or "fcm"
        sender_name = sender.get("name") or "@" + (sender.get("username") or "Someone")
        await _send_simple_push(
            token=token,
            token_type=token_type,
            title="👥 New contact request",
            body=f"{sender_name} wants to connect",
            channel="notifications",
            sound="notification",
            data={
                "type": "contact_invite",
                "from_user_id": sender.get("id", ""),
                "screen": "contacts",
            },
            ttl_seconds=3600,
        )
    except Exception as e:
        logger.warning(f"Invite push failed: {e}")


async def _send_simple_push(
    *,
    token: str,
    token_type: str = "fcm",
    title: str,
    body: str,
    channel: str = "notifications",
    sound: str = "notification",
    data: dict | None = None,
    ttl_seconds: int = 0,
    priority: str = "high",
    is_call: bool = False,
):
    """Lightweight push helper for non-message notifications (invites, group
    adds, system events). Uses direct FCM if token_type is fcm/apns; legacy
    Expo otherwise."""
    if not token:
        return
    if token_type in ("fcm", "apns"):
        from fcm import is_configured as fcm_is_configured, send_fcm

        if not fcm_is_configured():
            logger.warning("Simple push skipped — FCM not configured")
            return
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                res = await send_fcm(
                    client,
                    token=token,
                    title=title,
                    body=body,
                    channel_id=channel,
                    sound=sound,
                    priority=priority,
                    ttl_seconds=ttl_seconds,
                    data=data or {},
                    is_call=is_call,
                )
                if not res.get("ok"):
                    err = res.get("fcm_error_code") or res.get("error", "unknown")
                    logger.warning(f"Simple push failed: {err}")
                    if err in ("UNREGISTERED", "INVALID_ARGUMENT", "NOT_FOUND"):
                        await db.users.update_many(
                            {"push_token": token},
                            {"$unset": {"push_token": "", "push_token_type": "", "push_platform": "", "expo_push_token": ""}},
                        )
        except Exception as e:
            logger.warning(f"Simple push send error: {e}")
    else:
        # Legacy Expo token fallback
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    "https://exp.host/--/api/v2/push/send",
                    json={
                        "to": token,
                        "title": title,
                        "body": body,
                        "data": data or {},
                        "sound": expo_push_sound_name(sound),
                        "channelId": channel,
                        "priority": priority,
                        "ttl": ttl_seconds,
                    },
                )
        except Exception as e:
            logger.warning(f"Legacy Expo push failed: {e}")


async def _send_push_to_user(
    user_id: str,
    *,
    title: str,
    body: str,
    channel: str = "notifications",
    sound: str = "notification",
    data: dict | None = None,
    ttl_seconds: int = 0,
):
    """Convenience wrapper — load token by user_id and send."""
    try:
        u = await db.users.find_one(
            {"id": user_id},
            {"_id": 0, "id": 1, "push_token": 1, "expo_push_token": 1, "push_token_type": 1},
        )
        if not u:
            return
        token = u.get("push_token") or u.get("expo_push_token")
        if not token:
            return
        await _send_simple_push(
            token=token,
            token_type=u.get("push_token_type") or "fcm",
            title=title,
            body=body,
            channel=channel,
            sound=sound,
            data=data,
            ttl_seconds=ttl_seconds,
        )
    except Exception as e:
        logger.warning(f"_send_push_to_user failed: {e}")


def expo_push_sound_name(sound: str) -> str:
    """Expo/iOS custom sounds use the bundled file name, including extension."""
    sound = (sound or "default").strip()
    if sound in ("default", "defaultCritical"):
        return sound
    return sound if "." in sound else f"{sound}.wav"


def sanitize_diag_value(value, depth: int = 0):
    """Keep client diagnostics useful while preventing oversized/noisy payloads."""
    if depth > 3:
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:500]
    if isinstance(value, list):
        return [sanitize_diag_value(item, depth + 1) for item in value[:30]]
    if isinstance(value, dict):
        clean = {}
        for key, nested in list(value.items())[:80]:
            if not isinstance(key, str):
                continue
            clean[key[:80]] = sanitize_diag_value(nested, depth + 1)
        return clean
    return str(value)[:200]


async def _send_push_to_members(member_ids, sender_id, conv, msg):
    """Direct-FCM push delivery (HTTP v1). Falls back to Expo Push for legacy
    'expo' tokens that may exist in DB from previous deployments."""
    try:
        from fcm import is_configured as fcm_is_configured, send_fcm

        targets = [uid for uid in member_ids if uid != sender_id]
        if not targets:
            return
        # Filter out users who blocked the sender or muted this conversation
        # or muted the sender (per-user mute with optional expiry).
        recipients_full = await db.users.find(
            {
                "id": {"$in": targets},
                "$or": [
                    {"push_tokens.0": {"$exists": True}},
                    {"push_token": {"$exists": True, "$ne": None}},
                    {"expo_push_token": {"$exists": True, "$ne": None}},
                ],
            },
            {
                "_id": 0,
                "id": 1,
                "push_tokens": 1,
                "push_token": 1,
                "push_token_type": 1,
                "push_platform": 1,
                "expo_push_token": 1,
                "blocked_user_ids": 1,
                "muted_conversation_ids": 1,
                "muted_users": 1,
            },
        ).to_list(1000)
        conv_id = conv.get("id", "")
        now_iso = now_utc().isoformat()
        recipients = []
        for r in recipients_full:
            blocked = set(r.get("blocked_user_ids") or [])
            muted_convs = set(r.get("muted_conversation_ids") or [])
            muted_users_map = r.get("muted_users") or {}
            if sender_id in blocked:
                continue
            if conv_id and conv_id in muted_convs:
                continue
            user_mute = muted_users_map.get(sender_id)
            if user_mute:
                until = user_mute.get("until") if isinstance(user_mute, dict) else None
                # `until is None` means muted forever.
                if until is None or until > now_iso:
                    continue
            recipients.append(r)
        if not recipients:
            return

        is_call = msg.get("kind") == "call"
        if is_call:
            call_id = str(msg.get("id") or msg.get("call_id") or "")
            call = await db.calls.find_one({"id": call_id}, {"_id": 0})
            status = str((call or {}).get("status") or "").lower()
            expires_at = str((call or {}).get("expires_at") or (call or {}).get("expiresAt") or "")
            if (
                not call
                or status in CALL_TERMINAL_STATUSES
                or status != "ringing"
                or call.get("ended_at")
                or call.get("answered_at")
                or (expires_at and expires_at <= now_iso)
            ):
                logger.info(
                    "SKIP_PUSH_FOR_TERMINAL_CALL_STATE "
                    f"call={call_id[:8]} status={status or 'missing'}"
                )
                return

        title = conv.get("name") or "New message"
        if conv.get("type") == "direct":
            title = msg.get("sender_name", "New message")
        if is_call:
            title = f"📞 {msg.get('sender_name', 'Someone')} is calling"
        body_preview = msg.get("content", "")
        if is_call:
            title = "ghostel.app call"
            body_preview = "Incoming encrypted call"
        elif msg.get("e2ee"):
            body_preview = "Encrypted message"
        elif msg.get("kind") == "voice":
            body_preview = "🎙 Voice message"
        elif msg.get("kind") == "file":
            body_preview = "📎 Attachment"
        elif msg.get("kind") == "image":
            body_preview = "📷 Photo"
        body_preview = (body_preview or "")[:140]

        sound = "ringtone" if is_call else "message"
        channel_id = "calls" if is_call else "messages"
        ttl_sec = 30 if is_call else 0
        call_display_name = (
            msg.get("sender_name")
            or msg.get("caller_name")
            or "Someone"
        )
        call_display_name = str(call_display_name)[:80]
        # NOTE: FCM has a STRICT 4KB limit on the entire `data` dict for a
        # single message. Avatars are stored as base64 PNGs (often 50-100KB)
        # and MUST NOT be inlined here — that would exceed the limit and
        # FCM would reject the whole push with INVALID_ARGUMENT.
        # The native CallKeep screen will render the caller's initials when
        # no avatar is provided, so this is purely a visual fallback.
        common_data = {
            "conversation_id": conv.get("id", ""),
            "message_id": msg.get("id", ""),
            "call_id": msg.get("id", "") if is_call else "",
            "screen": "call" if is_call else "chat",
            "kind": "call" if is_call else str(msg.get("kind") or "message"),
            "push_kind": "call" if is_call else "message",
            # `incoming_call` is what the Android Headless JS handler matches on
            # (src/fcmBackground.ts). Older clients accepted "call" too — both
            # values are honored on the client.
            "type": "incoming_call" if is_call else "message",
            "sender_name": call_display_name if is_call else msg.get("sender_name", ""),
            # Caller-specific fields used by react-native-callkeep to render
            # the native OS-level incoming-call screen on the lockscreen.
            "caller_id": msg.get("caller_id", sender_id) if is_call else "",
            "caller_name": call_display_name if is_call else "",
            "encryptedDisplayName": msg.get("encryptedDisplayName", "") if is_call else "",
            # caller_avatar intentionally omitted — too big for FCM 4KB limit.
            "mode": msg.get("mode", "audio") if is_call else "",
        }

        # Split all registered devices by token type. A user may be logged in
        # on multiple phones, so never rely on the legacy single push_token.
        push_targets: list[dict] = []
        for r in recipients:
            for target in user_push_targets(r):
                push_targets.append({**target, "user_id": r.get("id")})
        push_targets = compact_push_targets(push_targets)
        fcm_recipients = [
            r for r in push_targets if (r.get("token_type") or "fcm") in ("fcm", "apns")
        ]
        expo_recipients = [r for r in push_targets if r.get("token_type") == "expo"]
        voip_recipients = [
            r for r in push_targets if is_call and r.get("token_type") == "voip"
        ]

        # ---- Native iOS PushKit path ----
        # A VoIP push wakes iOS and is reported to CallKit by AppDelegate before
        # React Native starts. This is the only reliable full-screen call path
        # for a locked or terminated iOS app.
        voip_ok = voip_err = 0
        voip_success_users: set[str] = set()
        voip_success_install_keys: set[str] = set()
        voip_success_users_without_device: set[str] = set()
        if voip_recipients:
            from apns import is_configured as apns_is_configured, send_voip_push

            if apns_is_configured():
                async with httpx.AsyncClient(http2=True, timeout=10) as apns_client:
                    for r in voip_recipients:
                        token = r["token"]
                        result = await send_voip_push(
                            apns_client,
                            token=token,
                            data=common_data,
                        )
                        if result.get("ok"):
                            voip_ok += 1
                            if r.get("user_id"):
                                voip_success_users.add(r["user_id"])
                            voip_success_install_keys.add(push_target_install_key(r))
                            if not normalize_push_device_id(r.get("device_id")) and r.get("user_id"):
                                voip_success_users_without_device.add(r["user_id"])
                        else:
                            voip_err += 1
                            reason = result.get("error", "unknown")
                            logger.warning(
                                f"APNs VoIP send failed reason={reason}"
                            )
                            if reason in (
                                "BadDeviceToken",
                                "DeviceTokenNotForTopic",
                                "Unregistered",
                            ):
                                await remove_push_token_from_users(token)
                logger.info(
                    f"APNs VoIP push: {voip_ok} ok / {voip_err} err, call={common_data.get('call_id', '')[:8]}"
                )
            else:
                logger.warning(
                    f"APNs VoIP not configured - skipped {len(voip_recipients)} recipients"
                )

        # ---- Direct FCM path ----
        fcm_ok = fcm_err = 0
        fcm_success_users: set[str] = set()
        fcm_success_install_keys: set[str] = set()
        fcm_success_users_without_device: set[str] = set()
        if fcm_recipients and fcm_is_configured():
            async with httpx.AsyncClient(timeout=10) as client:
                for r in fcm_recipients:
                    platform = str(r.get("platform") or "").lower()
                    if is_call and (
                        push_target_install_key(r) in voip_success_install_keys
                        or (
                            not normalize_push_device_id(r.get("device_id"))
                            and platform == "ios"
                            and r.get("user_id") in voip_success_users_without_device
                        )
                        or (
                            platform in {"", "ios", "unknown"}
                            and r.get("user_id") in voip_success_users
                        )
                    ):
                        continue
                    token = r["token"]
                    result = await send_fcm(
                        client,
                        token=token,
                        title=title,
                        body=body_preview,
                        channel_id=channel_id,
                        sound=sound,
                        priority="high",
                        ttl_seconds=ttl_sec,
                        data=common_data,
                        is_call=is_call,
                    )
                    if result.get("ok"):
                        fcm_ok += 1
                        if r.get("user_id"):
                            fcm_success_users.add(r["user_id"])
                        fcm_success_install_keys.add(push_target_install_key(r))
                        if not normalize_push_device_id(r.get("device_id")) and r.get("user_id"):
                            fcm_success_users_without_device.add(r["user_id"])
                    else:
                        fcm_err += 1
                        err_code = result.get("fcm_error_code") or result.get("error", "unknown")
                        logger.warning(
                            f"FCM send failed err={err_code} msg={result.get('message', '')[:120]}"
                        )
                        # Clean up unregistered tokens
                        if err_code in ("UNREGISTERED", "INVALID_ARGUMENT", "NOT_FOUND"):
                            await db.users.update_many(
                                {"$or": [{"push_token": token}, {"push_tokens.token": token}]},
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
            logger.info(
                f"FCM push: {fcm_ok} ok / {fcm_err} err, conv={conv.get('id', '?')[:8]}, kind={msg.get('kind', 'msg')}"
            )
        elif fcm_recipients and not fcm_is_configured():
            logger.warning(
                f"FCM not configured — skipped {len(fcm_recipients)} recipients"
            )

        # ---- Expo Push fallback ----
        # Each iOS install registers both transports. Use Expo only for users
        # whose direct FCM delivery did not succeed, avoiding duplicate alerts
        # while retaining EAS-managed APNs as an independent fallback.
        delivered_install_keys = fcm_success_install_keys | voip_success_install_keys
        delivered_users_without_device = (
            fcm_success_users_without_device | voip_success_users_without_device
        )
        expo_fallback_recipients = [
            r for r in expo_recipients
            if push_target_install_key(r) not in delivered_install_keys
            and not (
                not normalize_push_device_id(r.get("device_id"))
                and r.get("user_id") in delivered_users_without_device
            )
            and not (
                is_call
                and str(r.get("platform") or "").lower() in {"", "ios", "unknown"}
                and r.get("user_id") in voip_success_users
            )
        ]
        if expo_fallback_recipients:
            messages_payload = [
                {
                    "to": r["token"],
                    "title": title,
                    "body": body_preview,
                    "sound": expo_push_sound_name(sound),
                    "priority": "high",
                    "channelId": channel_id,
                    "ttl": ttl_sec,
                    "_contentAvailable": is_call,
                    "data": common_data,
                }
                for r in expo_fallback_recipients
            ]
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    resp = await client.post(EXPO_PUSH_URL, json=messages_payload)
                    if resp.status_code >= 400:
                        logger.warning(
                            f"Expo push (legacy) HTTP {resp.status_code}: {resp.text[:300]}"
                        )
                    else:
                        try:
                            payload = resp.json()
                        except Exception:
                            payload = {}
                        tickets = payload.get("data") if isinstance(payload, dict) else None
                        if not isinstance(tickets, list):
                            tickets = []
                        ok_count = sum(1 for ticket in tickets if ticket.get("status") == "ok")
                        err_tickets = [
                            ticket for ticket in tickets if ticket.get("status") != "ok"
                        ]
                        logger.info(
                            f"Expo push fallback: {ok_count} ok / {len(err_tickets)} err"
                        )
                        for ticket in err_tickets[:5]:
                            details = ticket.get("details") or {}
                            logger.warning(
                                "Expo push ticket error: "
                                f"status={ticket.get('status')} "
                                f"message={str(ticket.get('message', ''))[:180]} "
                                f"details={str(details)[:180]}"
                            )
            except Exception as exc:
                logger.warning(f"Expo push (legacy) failed: {exc}")
    except Exception as exc:
        logger.warning(f"_send_push_to_members failed: {exc}")


async def _send_call_control_push(
    call: dict,
    action: str,
    actor_id: str,
    actor_session_id: Optional[str] = None,
) -> None:
    """Wake background devices so native incoming-call UI stops ringing.

    WebSocket remains the primary real-time path while the app is active, but
    locked/background devices can be showing a native call UI without a live WS.
    This silent control payload only carries enough state to cancel ringing or
    clear active-call UI. iOS receives it directly over APNs VoIP when possible;
    FCM remains the Android path and a fallback for registered FCM/APNs tokens.
    """
    try:
        from fcm import is_configured as fcm_is_configured, send_fcm

        fcm_configured = fcm_is_configured()
        if not fcm_configured:
            logger.warning("FCM not configured - FCM call control fallback unavailable")

        member_ids = [member_id for member_id in call.get("member_ids", []) if member_id]
        if not member_ids:
            return

        users = await db.users.find(
            {
                "id": {"$in": member_ids},
                "$or": [
                    {"push_tokens.0": {"$exists": True}},
                    {"push_token": {"$exists": True, "$ne": None}},
                    {"expo_push_token": {"$exists": True, "$ne": None}},
                ],
            },
            {
                "_id": 0,
                "id": 1,
                "push_tokens": 1,
                "push_token": 1,
                "push_token_type": 1,
                "push_platform": 1,
                "expo_push_token": 1,
            },
        ).to_list(1000)

        targets: list[dict] = []
        voip_targets: list[dict] = []
        for user_doc in users:
            for target in user_push_targets(user_doc):
                token_type = (target.get("token_type") or "fcm").lower()
                platform = (target.get("platform") or "").lower()
                if token_type == "voip":
                    voip_targets.append({**target, "user_id": user_doc.get("id")})
                elif token_type in {"fcm", "apns"} and platform != "ios":
                    targets.append({**target, "user_id": user_doc.get("id")})
        targets = compact_push_targets(targets)
        voip_targets = compact_push_targets(voip_targets)
        if action == "accepted":
            # Signal-style split:
            # - call.accepted for the caller is delivered through signaling
            #   (WebSocket + persisted call_signals);
            # - call-control "accepted" is only a native UI cleanup event for
            #   the callee account's other devices. Sending it to the caller's
            #   iOS device can make CallKit emit a local end action and wrongly
            #   terminate an already accepted call.
            targets = [target for target in targets if target.get("user_id") == actor_id]
            voip_targets = [
                target for target in voip_targets if target.get("user_id") == actor_id
            ]
            if actor_session_id:
                targets = [
                    target
                    for target in targets
                    if not (
                        target.get("user_id") == actor_id
                        and (target.get("session_id") or "") == actor_session_id
                    )
                ]
                voip_targets = [
                    target
                    for target in voip_targets
                    if not (
                        target.get("user_id") == actor_id
                        and (target.get("session_id") or "") == actor_session_id
                    )
                ]
        if not targets and not voip_targets:
            return

        data = {
            "type": "call_control",
            "call_control_action": action,
            "call_id": call.get("id", ""),
            "conversation_id": call.get("conversation_id", ""),
            "actor_id": actor_id,
            "accepted_by": actor_id if action == "accepted" else "",
            "ended_by": actor_id if action != "accepted" else "",
            "status": action,
        }

        voip_ok = voip_err = 0
        if voip_targets:
            from apns import is_configured as apns_is_configured, send_voip_push

            if apns_is_configured():
                async with httpx.AsyncClient(http2=True, timeout=10) as apns_client:
                    for target in voip_targets:
                        token = target["token"]
                        result = await send_voip_push(
                            apns_client,
                            token=token,
                            data=data,
                        )
                        if result.get("ok"):
                            voip_ok += 1
                        else:
                            voip_err += 1
                            reason = result.get("error", "unknown")
                            logger.warning(
                                f"APNs VoIP call control failed action={action} reason={reason}"
                            )
                            if reason in (
                                "BadDeviceToken",
                                "DeviceTokenNotForTopic",
                                "Unregistered",
                            ):
                                await remove_push_token_from_users(token)
                logger.info(
                    "APNs VoIP call control "
                    f"action={action} call={str(call.get('id', ''))[:8]} "
                    f"ok={voip_ok} err={voip_err}"
                )
            else:
                logger.warning(
                    f"APNs VoIP not configured - skipped {len(voip_targets)} call control recipients"
                )

        ok = err = 0
        if targets and fcm_configured:
            async with httpx.AsyncClient(timeout=10) as client:
                for target in targets:
                    token = target["token"]
                    result = await send_fcm(
                        client,
                        token=token,
                        title="ghostel.app call",
                        body="",
                        channel_id="calls",
                        sound="default",
                        priority="high",
                        ttl_seconds=30,
                        data=data,
                        data_only=True,
                    )
                    if result.get("ok"):
                        ok += 1
                    else:
                        err += 1
                        err_code = result.get("fcm_error_code") or result.get("error", "unknown")
                        logger.warning(
                            f"Call control push failed action={action} err={err_code}"
                        )
                        if err_code in ("UNREGISTERED", "INVALID_ARGUMENT", "NOT_FOUND"):
                            await remove_push_token_from_users(token)
        elif targets and not fcm_configured:
            logger.warning(f"FCM not configured - skipped {len(targets)} call control recipients")
        logger.info(
            "Call control push "
            f"action={action} call={str(call.get('id', ''))[:8]} "
            f"fcm_ok={ok} fcm_err={err} voip_ok={voip_ok} voip_err={voip_err}"
        )
    except Exception as exc:
        logger.warning(f"_send_call_control_push failed: {exc}")
