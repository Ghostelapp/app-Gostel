import uuid

import requests

from conftest import BASE_URL, auth_headers


def _h(token: str):
    return auth_headers(token)


def _register_user(prefix: str):
    email = f"{prefix}-{uuid.uuid4().hex[:10]}@example.com"
    password = "Pass@2026!"
    res = requests.post(
        f"{BASE_URL}/api/auth/register",
        json={"email": email, "password": password, "name": prefix},
        timeout=20,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    return {
        "email": email,
        "password": password,
        "token": body["access_token"],
        "session_id": body["session_id"],
        "user": body["user"],
    }


def _login_user(email: str, password: str):
    res = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=20,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    return {
        "token": body["access_token"],
        "session_id": body["session_id"],
        "user": body["user"],
    }


def _register_push(token: str, push_token: str, device_id: str, token_type: str = "fcm"):
    res = requests.post(
        f"{BASE_URL}/api/push/register",
        headers=_h(token),
        json={
            "token": push_token,
            "platform": "android",
            "token_type": token_type,
            "device_id": device_id,
            "device_model": "Ghostel Test Device",
            "os_version": "1.0",
            "source": "pytest",
        },
        timeout=20,
    )
    assert res.status_code == 200, res.text


class TestPushSessionDeviceBinding:
    def test_unregister_without_payload_removes_only_current_session_tokens(self):
        user = _register_user("push-session")
        second = _login_user(user["email"], user["password"])

        _register_push(user["token"], f"tok-{uuid.uuid4().hex[:12]}", "device-session-a")
        _register_push(second["token"], f"tok-{uuid.uuid4().hex[:12]}", "device-session-b")

        listed_before = requests.get(
            f"{BASE_URL}/api/push/devices",
            headers=_h(second["token"]),
            timeout=20,
        )
        assert listed_before.status_code == 200, listed_before.text
        before_ids = {device["id"] for device in listed_before.json()["devices"]}
        assert {"device-session-a", "device-session-b"}.issubset(before_ids)

        unregistered = requests.post(
            f"{BASE_URL}/api/push/unregister",
            headers=_h(user["token"]),
            json={},
            timeout=20,
        )
        assert unregistered.status_code == 200, unregistered.text
        assert unregistered.json()["scope"] == "session"

        listed_after = requests.get(
            f"{BASE_URL}/api/push/devices",
            headers=_h(second["token"]),
            timeout=20,
        )
        assert listed_after.status_code == 200, listed_after.text
        after_ids = {device["id"] for device in listed_after.json()["devices"]}
        assert "device-session-a" not in after_ids
        assert "device-session-b" in after_ids

    def test_register_moves_whole_device_between_accounts(self):
        first = _register_user("push-move-a")
        second = _register_user("push-move-b")

        _register_push(first["token"], f"tok-{uuid.uuid4().hex[:12]}", "device-shared", "fcm")
        _register_push(first["token"], f"tok-{uuid.uuid4().hex[:12]}", "device-shared", "expo")

        moved = requests.post(
            f"{BASE_URL}/api/push/register",
            headers=_h(second["token"]),
            json={
                "token": f"tok-{uuid.uuid4().hex[:12]}",
                "platform": "android",
                "token_type": "fcm",
                "device_id": "device-shared",
                "device_model": "Ghostel Test Device",
                "os_version": "1.0",
                "source": "pytest",
            },
            timeout=20,
        )
        assert moved.status_code == 200, moved.text

        first_devices = requests.get(
            f"{BASE_URL}/api/push/devices",
            headers=_h(first["token"]),
            timeout=20,
        )
        second_devices = requests.get(
            f"{BASE_URL}/api/push/devices",
            headers=_h(second["token"]),
            timeout=20,
        )
        assert first_devices.status_code == 200, first_devices.text
        assert second_devices.status_code == 200, second_devices.text

        first_ids = {device["id"] for device in first_devices.json()["devices"]}
        second_ids = {device["id"] for device in second_devices.json()["devices"]}
        assert "device-shared" not in first_ids
        assert "device-shared" in second_ids
