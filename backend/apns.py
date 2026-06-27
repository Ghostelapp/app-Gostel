"""Direct APNs delivery for iOS PushKit incoming-call notifications."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import httpx
import jwt


_AUTH_CACHE: dict[str, Any] = {
    "configuration": None,
    "token": "",
    "expires_at": 0.0,
}


def _configuration() -> tuple[str, str, str, str, bool]:
    return (
        os.environ.get("APNS_KEY_PATH", "").strip(),
        os.environ.get("APNS_KEY_ID", "").strip(),
        os.environ.get("APNS_TEAM_ID", "").strip(),
        os.environ.get("APNS_BUNDLE_ID", "app.ghostel").strip(),
        os.environ.get("APNS_USE_SANDBOX", "false").strip().lower() == "true",
    )


def is_configured() -> bool:
    key_path, key_id, team_id, bundle_id, _ = _configuration()
    return bool(
        key_path
        and key_id
        and team_id
        and bundle_id
        and Path(key_path).is_file()
    )


def _authorization_header() -> str:
    key_path, key_id, team_id, _, _ = _configuration()
    configuration = (key_path, key_id, team_id)
    now = time.time()
    if (
        _AUTH_CACHE["configuration"] == configuration
        and _AUTH_CACHE["token"]
        and now < _AUTH_CACHE["expires_at"]
    ):
        return f"bearer {_AUTH_CACHE['token']}"

    private_key = Path(key_path).read_text(encoding="utf-8")
    token = jwt.encode(
        {"iss": team_id, "iat": int(now)},
        private_key,
        algorithm="ES256",
        headers={"alg": "ES256", "kid": key_id},
    )
    _AUTH_CACHE.update(
        {
            "configuration": configuration,
            "token": token,
            # Apple accepts provider tokens for one hour. Refresh early.
            "expires_at": now + 45 * 60,
        }
    )
    return f"bearer {token}"


def build_voip_payload(data: dict[str, Any]) -> dict[str, Any]:
    call_id = str(data.get("call_id") or data.get("message_id") or "")
    return {
        "aps": {"content-available": 1},
        "uuid": call_id,
        "call_id": call_id,
        "type": "incoming_call",
        "screen": "call",
        "kind": "call",
        "conversation_id": str(data.get("conversation_id") or ""),
        "caller_id": str(data.get("caller_id") or ""),
        "caller_name": str(data.get("caller_name") or "ghostel.app call"),
        "encryptedDisplayName": str(data.get("encryptedDisplayName") or ""),
        "mode": str(data.get("mode") or "audio"),
        "sent_at": int(time.time()),
    }


async def send_voip_push(
    client: httpx.AsyncClient,
    *,
    token: str,
    data: dict[str, Any],
) -> dict[str, Any]:
    key_path, key_id, team_id, bundle_id, use_sandbox = _configuration()
    if not all((key_path, key_id, team_id, bundle_id)):
        return {"ok": False, "error": "APNS_NOT_CONFIGURED"}

    endpoint = "api.sandbox.push.apple.com" if use_sandbox else "api.push.apple.com"
    call_id = str(data.get("call_id") or data.get("message_id") or "")
    headers = {
        "authorization": _authorization_header(),
        "apns-topic": os.environ.get("APNS_VOIP_TOPIC", f"{bundle_id}.voip"),
        "apns-push-type": "voip",
        "apns-priority": "10",
        "apns-expiration": "0",
    }
    if call_id:
        headers["apns-collapse-id"] = call_id[:64]

    response = await client.post(
        f"https://{endpoint}/3/device/{token}",
        headers=headers,
        content=json.dumps(build_voip_payload(data), separators=(",", ":")).encode("utf-8"),
    )
    if response.status_code == 200:
        return {"ok": True, "apns_id": response.headers.get("apns-id", "")}

    try:
        error_payload = response.json()
    except Exception:
        error_payload = {}
    reason = str(error_payload.get("reason") or f"HTTP_{response.status_code}")
    return {
        "ok": False,
        "status_code": response.status_code,
        "error": reason,
        "timestamp": error_payload.get("timestamp"),
    }
