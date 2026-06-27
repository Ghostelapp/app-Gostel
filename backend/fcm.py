"""
Direct FCM HTTP v1 push sender — bypasses Expo Push API.

Why this exists
---------------
The Expo Push API requires the FCM Service Account JSON to be uploaded
to the EAS project that owns the build (project ID `extra.eas.projectId`).
On Emergent's managed deploy, builds run under Emergent's own EAS account
(`emergent001`), which the end-user does not have admin access to.

This module sends push notifications directly to Firebase Cloud Messaging
using a Service Account JSON we host server-side, so we don't depend on
Expo's push gateway at all.

Configuration
-------------
Service Account JSON can be provided via:
  1. File at /app/backend/firebase-service-account.json
  2. Environment variable FCM_SERVICE_ACCOUNT_JSON (full JSON as one-line string)
  3. Environment variable FCM_SERVICE_ACCOUNT_PATH (path to JSON file)

Project ID is auto-detected from the JSON (`project_id` field).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any

logger = logging.getLogger("ghostel.fcm")

_FCM_SCOPES = ["https://www.googleapis.com/auth/firebase.messaging"]
_FCM_ENDPOINT_TPL = "https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"

# In-memory cache for the OAuth2 access token (valid 1h).
_token_cache: dict = {"access_token": None, "expires_at": 0.0}
_token_lock = threading.Lock()

_credentials = None
_project_id: str | None = None
_config_loaded = False
_config_error: str | None = None


def _load_credentials():
    """Loads service-account credentials once on first use."""
    global _credentials, _project_id, _config_loaded, _config_error
    if _config_loaded:
        return
    _config_loaded = True

    raw_info: dict | None = None
    raw_json = os.environ.get("FCM_SERVICE_ACCOUNT_JSON", "").strip()
    file_path = os.environ.get("FCM_SERVICE_ACCOUNT_PATH", "").strip()
    candidate_paths = [
        file_path,
        os.path.join(os.path.dirname(__file__), "firebase-service-account.json"),
        "/app/backend/firebase-service-account.json",
    ]

    if raw_json:
        try:
            raw_info = json.loads(raw_json)
        except Exception as e:
            _config_error = f"FCM_SERVICE_ACCOUNT_JSON invalid: {e}"
            logger.warning(_config_error)
            return
    else:
        for candidate in [p for p in candidate_paths if p]:
            if not os.path.exists(candidate):
                continue
            try:
                with open(candidate, "r", encoding="utf-8") as f:
                    raw_info = json.load(f)
                break
            except Exception as e:
                _config_error = f"Failed to read {candidate}: {e}"
                logger.warning(_config_error)
                return
    if raw_info is None:
        _config_error = (
            "No Firebase service account configured. "
            "Set FCM_SERVICE_ACCOUNT_JSON env var OR place JSON at "
            "backend/firebase-service-account.json"
        )
        logger.warning(_config_error)
        return

    try:
        from google.oauth2 import service_account  # type: ignore

        _credentials = service_account.Credentials.from_service_account_info(
            raw_info, scopes=_FCM_SCOPES
        )
        _project_id = raw_info.get("project_id")
        if not _project_id:
            _config_error = "Service account JSON has no project_id"
            logger.warning(_config_error)
            return
        logger.info(f"FCM credentials loaded for project '{_project_id}'")
    except Exception as e:
        _config_error = f"Service account load failed: {e}"
        logger.warning(_config_error)


def is_configured() -> bool:
    _load_credentials()
    return _credentials is not None and _project_id is not None


def get_config_error() -> str | None:
    _load_credentials()
    return _config_error


def get_project_id() -> str | None:
    _load_credentials()
    return _project_id


def _get_access_token(*, force_refresh: bool = False) -> str | None:
    """Returns a cached OAuth2 access token, refreshing if needed."""
    _load_credentials()
    if not _credentials:
        return None
    now = time.time()
    with _token_lock:
        if (
            not force_refresh
            and _token_cache["access_token"]
            and now < _token_cache["expires_at"] - 60
        ):
            return _token_cache["access_token"]
        try:
            from google.auth.transport.requests import Request  # type: ignore

            if force_refresh:
                _credentials.token = None
            _credentials.refresh(Request())
            _token_cache["access_token"] = _credentials.token
            # google.oauth2.credentials.expiry is naive UTC datetime
            if _credentials.expiry:
                # Never keep an OAuth token longer than 55 minutes locally,
                # even if a malformed/skewed expiry value is returned.
                _token_cache["expires_at"] = min(
                    _credentials.expiry.timestamp(), now + 3300
                )
            else:
                _token_cache["expires_at"] = now + 3300  # 55 min
            return _token_cache["access_token"]
        except Exception as e:
            logger.warning(f"FCM token refresh failed: {e}")
            return None


def build_message(
    *,
    token: str,
    title: str,
    body: str,
    channel_id: str = "messages",
    sound: str = "default",
    priority: str = "high",
    ttl_seconds: int = 0,
    data: dict | None = None,
    is_call: bool = False,
    data_only: bool = False,
) -> dict:
    """Builds an FCM HTTP v1 message payload.

    Notes:
      - `sound` for Android is the resource filename WITHOUT extension
        (e.g. `ringtone` for /res/raw/ringtone.wav)
      - `channel_id` must match a channel registered by the client
      - `ttl` is "30s" string per FCM v1 spec
    """
    str_data: dict[str, str] = {}
    if data:
        for k, v in data.items():
            if v is None:
                continue
            str_data[str(k)] = str(v)

    # ── FCM 4KB safety net ────────────────────────────────────────────────
    # FCM rejects any message whose serialized data dict exceeds 4096 bytes
    # with INVALID_ARGUMENT "message is too big". Defensively drop any single
    # field that, by itself, exceeds 1KB (typically base64 avatars, large
    # message previews, etc.) so a bad caller never crashes the whole push.
    # We log the drop but keep the push going.
    _MAX_SINGLE_FIELD = 1024
    _dropped: list[str] = []
    for k in list(str_data.keys()):
        if len(str_data[k]) > _MAX_SINGLE_FIELD:
            _dropped.append(f"{k}={len(str_data[k])}B")
            del str_data[k]
    if _dropped:
        logger.warning(
            f"FCM build_message dropped oversized fields to stay under 4KB: {', '.join(_dropped)}"
        )

    # ── Calls ──────────────────────────────────────────────────────────────
    # DATA-ONLY calls:
    # Incoming calls must wake the native background handler so the app can
    # display Android Telecom / CallKeep on top of the lockscreen. A regular
    # FCM `notification` block would show a banner, but on killed/background
    # apps Android may not run Headless JS until the user taps it. For calls,
    # we therefore send high-priority data only and let the client render the
    # native incoming-call UI. Regular messages still use notification+data.
    # ──────────────────────────────────────────────────────────────────────
    android_block: dict[str, Any]
    apns_block: dict[str, Any]
    if data_only:
        android_block = {
            "priority": "high",
            "collapse_key": str_data.get("call_id") or str_data.get("type") or "ghostel_control",
            "direct_boot_ok": True,
        }
        apns_block = {
            "headers": {
                "apns-priority": "5",
                "apns-push-type": "background",
            },
            "payload": {
                "aps": {
                    "content-available": 1,
                },
            },
        }
    elif is_call:
        # Mirror title/body into data so a Headless JS handler (when present)
        # can use them without parsing the notification block.
        str_data.setdefault("title", title)
        str_data.setdefault("body", body)

        android_block = {
            "priority": "high",
            "collapse_key": str_data.get("call_id") or "incoming_call",
            "direct_boot_ok": True,
        }
        # iOS: VoIP-style alert with critical sound to bypass silent/DND.
        apns_block = {
            "headers": {
                "apns-priority": "10",
                "apns-push-type": "alert",
            },
            "payload": {
                "aps": {
                    "alert": {"title": title, "body": body},
                    "sound": (
                        {
                            "name": f"{sound}.wav" if sound != "default" else "default",
                            "critical": 1,
                            "volume": 1.0,
                        }
                        if sound != "default"
                        else "default"
                    ),
                    "interruption-level": "critical",
                    "content-available": 1,
                },
            },
        }
    else:
        # ── Regular messages / notifications ──
        android_notif: dict[str, Any] = {
            "title": title,
            "body": body,
            "channel_id": channel_id,
            "sound": sound,
            "default_vibrate_timings": True,
            # Wake the screen + show heads-up banner with max priority.
            "notification_priority": "PRIORITY_MAX",
            "visibility": "PUBLIC",
            "default_light_settings": True,
        }
        android_block = {
            "priority": "high" if priority == "high" else "normal",
            "notification": android_notif,
        }
        apns_block = {
            "headers": {
                "apns-priority": "10" if priority == "high" else "5",
                "apns-push-type": "alert",
            },
            "payload": {
                "aps": {
                    "alert": {"title": title, "body": body},
                    "sound": (
                        {
                            "name": f"{sound}.wav" if sound != "default" else "default",
                            "critical": 0,
                            "volume": 1.0,
                        }
                        if sound != "default"
                        else "default"
                    ),
                    "interruption-level": "time-sensitive",
                    "content-available": 0,
                },
            },
        }

    msg: dict[str, Any] = {
        "message": {
            "token": token,
            "data": str_data,
            "android": android_block,
            "apns": apns_block,
        }
    }
    if ttl_seconds and ttl_seconds > 0:
        msg["message"]["android"]["ttl"] = f"{ttl_seconds}s"
        msg["message"]["apns"]["headers"]["apns-expiration"] = str(
            int(time.time()) + ttl_seconds
        )
    return msg


def _response_fcm_error_code(response) -> str | None:
    try:
        body_data = response.json()
    except Exception:
        return None
    if not isinstance(body_data, dict):
        return None
    details = (body_data.get("error") or {}).get("details") or []
    for detail in details:
        if isinstance(detail, dict) and detail.get("@type", "").endswith("FcmError"):
            return detail.get("errorCode")
    return None


async def send_fcm(
    httpx_client,
    *,
    token: str,
    title: str,
    body: str,
    channel_id: str = "messages",
    sound: str = "default",
    priority: str = "high",
    ttl_seconds: int = 0,
    data: dict | None = None,
    is_call: bool = False,
    data_only: bool = False,
) -> dict:
    """Sends a single FCM v1 push. Returns {ok, status_code, error?, message_name?}.

    Caller must provide an httpx.AsyncClient for connection reuse.
    """
    if not is_configured():
        return {
            "ok": False,
            "status_code": 0,
            "error": "fcm_not_configured",
            "detail": get_config_error(),
        }

    access_token = _get_access_token()
    if not access_token:
        return {
            "ok": False,
            "status_code": 0,
            "error": "token_refresh_failed",
        }

    project_id = get_project_id()
    url = _FCM_ENDPOINT_TPL.format(project_id=project_id)
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json; charset=utf-8",
    }
    payload = build_message(
        token=token,
        title=title,
        body=body,
        channel_id=channel_id,
        sound=sound,
        priority=priority,
        ttl_seconds=ttl_seconds,
        data=data,
        is_call=is_call,
        data_only=data_only,
    )

    try:
        resp = await httpx_client.post(url, headers=headers, json=payload, timeout=10)
        if (
            resp.status_code == 401
            and _response_fcm_error_code(resp) != "THIRD_PARTY_AUTH_ERROR"
        ):
            # A service-account token can occasionally be revoked before its
            # advertised expiry. Refresh once and replay the same idempotent
            # FCM request instead of dropping the notification until restart.
            logger.warning("FCM authorization rejected; refreshing OAuth token and retrying")
            refreshed_token = _get_access_token(force_refresh=True)
            if refreshed_token:
                headers = {
                    **headers,
                    "Authorization": f"Bearer {refreshed_token}",
                }
                resp = await httpx_client.post(
                    url, headers=headers, json=payload, timeout=10
                )
        result: dict[str, Any] = {"status_code": resp.status_code}
        try:
            body_data = resp.json()
        except Exception:
            body_data = None
        if 200 <= resp.status_code < 300:
            result["ok"] = True
            result["message_name"] = (
                body_data.get("name") if isinstance(body_data, dict) else None
            )
            return result
        # Error path — surface FCM error code for diagnostics
        result["ok"] = False
        if isinstance(body_data, dict):
            err = body_data.get("error", {})
            result["error"] = err.get("status", "unknown")
            result["message"] = err.get("message")
            # FCM error details often include INVALID_ARGUMENT or NOT_FOUND or UNREGISTERED
            details = err.get("details") or []
            for d in details:
                if isinstance(d, dict) and d.get("@type", "").endswith(
                    "FcmError"
                ):
                    result["fcm_error_code"] = d.get("errorCode")
                    break
        else:
            result["error"] = "non_json_response"
            result["raw"] = resp.text[:500]
        return result
    except Exception as e:
        return {"ok": False, "status_code": 0, "error": "request_failed", "detail": str(e)}
