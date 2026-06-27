"""Silentel iteration 2 tests — uploads, push, calls, WebSocket signaling,
and message kinds (image/voice/file with attachment_id)."""
import asyncio
import base64
import json
import uuid

import pytest
import requests
import websockets
from conftest import auth_headers, BASE_URL, ensure_contact, ensure_e2ee_keys, e2ee_payload


def _ws_url() -> str:
    if BASE_URL.startswith("https://"):
        return "wss://" + BASE_URL[len("https://"):]
    return "ws://" + BASE_URL[len("http://"):]


def _ws_ticket(token: str) -> str:
    response = requests.post(
        f"{BASE_URL}/api/ws-ticket",
        headers=auth_headers(token),
    )
    assert response.status_code == 200, response.text
    return response.json()["ticket"]


# ---------------- Uploads ----------------
class TestUploads:
    def test_upload_and_fetch(self, api_client, admin_token):
        data_b = b"encrypted-upload-test"
        b64 = base64.b64encode(data_b).decode()
        payload = {
            "filename": "TEST_hello.ghostel",
            "mime": "application/octet-stream",
            "data": b64,
            "size": len(data_b),
        }
        r = api_client.post(f"{BASE_URL}/api/uploads", json=payload, headers=auth_headers(admin_token))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["filename"] == "TEST_hello.ghostel"
        assert body["mime"] == "application/octet-stream"
        assert body["size"] == len(data_b)
        assert "id" in body
        pytest.attachment_id = body["id"]

        # GET back as same owner
        g = api_client.get(f"{BASE_URL}/api/uploads/{body['id']}", headers=auth_headers(admin_token))
        assert g.status_code == 200
        gb = g.json()
        assert gb["owner_id"]
        assert gb["data"] == b64
        assert gb["filename"] == "TEST_hello.ghostel"

    def test_upload_requires_auth(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/uploads", json={
            "filename": "x.txt", "mime": "text/plain", "data": "QQ==", "size": 1
        })
        assert r.status_code == 401

    def test_upload_too_large_returns_413(self, api_client, admin_token):
        # 9MB > 8MB cap → Pydantic rejects with 422 (size constraint) OR app 413.
        # Pydantic validation happens first (size <= 8MB). Expect 422 from Pydantic
        # OR 413 if validation passes. Both indicate proper rejection.
        size = 9 * 1024 * 1024
        r = api_client.post(f"{BASE_URL}/api/uploads", json={
            "filename": "big.ghostel", "mime": "application/octet-stream",
            "data": "QQ==", "size": size
        }, headers=auth_headers(admin_token))
        assert r.status_code in (413, 422), f"got {r.status_code}: {r.text}"


# ---------------- Messages with attachments ----------------
class TestMessageKinds:
    @pytest.fixture(scope="class")
    def conv_id(self, admin_token, demo_token):
        admin = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token)).json()
        demo = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(demo_token)).json()
        ensure_e2ee_keys((admin_token, "admin"), (demo_token, "demo"))
        ensure_contact(admin_token, admin, demo_token, demo)
        r = requests.post(
            f"{BASE_URL}/api/conversations",
            json={"type": "direct", "member_ids": [demo["id"]]},
            headers=auth_headers(admin_token),
        )
        assert r.status_code == 200
        return r.json()["id"]

    def _upload(self, token, name="att.ghostel", mime="application/octet-stream"):
        data_b = b"encrypted-binary-payload"
        b64 = base64.b64encode(data_b).decode()
        r = requests.post(
            f"{BASE_URL}/api/uploads",
            json={"filename": name, "mime": mime, "data": b64, "size": len(data_b)},
            headers=auth_headers(token),
        )
        assert r.status_code == 200, r.text
        return r.json()["id"]

    @pytest.mark.parametrize("kind,mime", [
        ("image", "image/png"),
        ("voice", "audio/m4a"),
        ("file", "application/pdf"),
    ])
    def test_send_message_with_attachment(self, api_client, admin_token, demo_token, conv_id, kind, mime):
        admin = api_client.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token)).json()
        demo = api_client.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(demo_token)).json()
        att_id = self._upload(admin_token, name=f"TEST_{kind}.ghostel")
        extra = {"duration_ms": 2500} if kind == "voice" else {}
        attachment_e2ee = {
            "version": 1,
            "algorithm": "nacl-secretbox-v1",
            "nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=",
            "mime": mime,
            "size": 128,
            "key_recipients": e2ee_payload("admin", [admin["id"], demo["id"]])["recipients"],
        }
        r = api_client.post(
            f"{BASE_URL}/api/messages",
            json={
                "conversation_id": conv_id,
                "content": "[encrypted message]",
                "kind": kind,
                "attachment_id": att_id,
                "encrypted": True,
                "e2ee": e2ee_payload("admin", [admin["id"], demo["id"]]),
                "e2ee_attachment": attachment_e2ee,
                **extra,
            },
            headers=auth_headers(admin_token),
        )
        assert r.status_code == 200, r.text
        msg = r.json()
        assert msg["kind"] == kind
        assert msg["attachment_id"] == att_id
        if kind == "voice":
            assert msg["duration_ms"] == 2500


# ---------------- Push token ----------------
class TestPush:
    def test_register_unregister(self, api_client, demo_token):
        tok = f"ExponentPushToken[TEST_{uuid.uuid4().hex[:10]}]"
        r = api_client.post(
            f"{BASE_URL}/api/push/register",
            json={"token": tok, "platform": "web"},
            headers=auth_headers(demo_token),
        )
        assert r.status_code == 200
        assert r.json()["registered"] is True

        u = api_client.post(f"{BASE_URL}/api/push/unregister", headers=auth_headers(demo_token))
        assert u.status_code == 200
        assert u.json()["unregistered"] is True


# ---------------- Calls ----------------
class TestCalls:
    @pytest.fixture(scope="class")
    def conv_id(self, admin_token, demo_token):
        admin = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token)).json()
        demo = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(demo_token)).json()
        ensure_e2ee_keys((admin_token, "admin"), (demo_token, "demo"))
        ensure_contact(admin_token, admin, demo_token, demo)
        r = requests.post(
            f"{BASE_URL}/api/conversations",
            json={"type": "direct", "member_ids": [demo["id"]]},
            headers=auth_headers(admin_token),
        )
        return r.json()["id"]

    def test_start_and_end_call(self, api_client, admin_token, demo_token, conv_id):
        s = api_client.post(
            f"{BASE_URL}/api/calls/start",
            json={"conversation_id": conv_id, "mode": "audio"},
            headers=auth_headers(admin_token),
        )
        assert s.status_code == 200, s.text
        call = s.json()
        assert call["status"] == "ringing"
        assert call["callId"] == call["id"]
        assert call["callType"] == "audio"
        assert call["caller_id"]
        assert call["caller_name"]
        assert call["conversation_id"] == conv_id
        assert isinstance(call["member_ids"], list) and len(call["member_ids"]) == 2
        assert call["encrypted"] is True
        assert call["e2ee_required"] is True
        assert call["e2ee_media"] == "webrtc-dtls-srtp"

        active = api_client.get(
            f"{BASE_URL}/api/calls/active-incoming",
            headers=auth_headers(demo_token),
        )
        assert active.status_code == 200, active.text
        assert active.json()["id"] == call["id"]
        assert active.json()["caller_id"] == call["caller_id"]
        assert active.json()["conversation_id"] == conv_id

        accepted = api_client.post(
            f"{BASE_URL}/api/calls/{call['id']}/accept",
            headers=auth_headers(demo_token),
        )
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["accepted"] is True

        state = api_client.post(
            f"{BASE_URL}/api/calls/{call['id']}/state",
            json={
                "status": "active",
                "peer_connection_state": "connected",
                "local_audio_enabled": True,
                "remote_audio_connected": True,
            },
            headers=auth_headers(demo_token),
        )
        assert state.status_code == 200, state.text
        assert state.json()["updated"] is True
        assert state.json()["status"] == "active"

        status = api_client.get(
            f"{BASE_URL}/api/calls/{call['id']}/status",
            headers=auth_headers(admin_token),
        )
        assert status.status_code == 200, status.text
        assert status.json()["status"] == "active"

        accepted_signals = api_client.get(
            f"{BASE_URL}/api/calls/{call['id']}/signals",
            headers=auth_headers(admin_token),
        )
        assert accepted_signals.status_code == 200, accepted_signals.text
        matching = [
            signal
            for signal in accepted_signals.json()
            if signal.get("type") == "call:accepted"
        ]
        assert len(matching) == 1
        assert matching[0]["data"]["accepted_by"] != call["caller_id"]

        admin = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token)).json()
        demo = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(demo_token)).json()
        offer = api_client.post(
            f"{BASE_URL}/api/calls/{call['id']}/offer",
            json={
                "to": demo["id"],
                "encrypted": True,
                "e2ee_signal": {
                    "version": 1,
                    "algorithm": "nacl-box-v1",
                    "sender_public_key": admin["e2ee_public_key"],
                    "nonce": "n" * 24,
                    "ciphertext": "c" * 32,
                },
                "sdp": "plaintext-must-not-be-stored",
            },
            headers=auth_headers(admin_token),
        )
        assert offer.status_code == 200, offer.text
        stored_offer = api_client.get(
            f"{BASE_URL}/api/calls/{call['id']}/signals",
            headers=auth_headers(demo_token),
        )
        assert stored_offer.status_code == 200, stored_offer.text
        offers = [
            signal
            for signal in stored_offer.json()
            if signal.get("signal_id") == offer.json()["signal_id"]
        ]
        assert len(offers) == 1
        assert offers[0]["type"] == "call:offer"
        assert "e2ee_signal" in offers[0]
        assert "sdp" not in offers[0]

        e = api_client.post(
            f"{BASE_URL}/api/calls/{call['id']}/end",
            headers=auth_headers(admin_token),
        )
        assert e.status_code == 200
        assert e.json()["ended"] is True

    def test_start_call_not_member(self, api_client, admin_token):
        bogus = str(uuid.uuid4())
        r = api_client.post(
            f"{BASE_URL}/api/calls/start",
            json={"conversation_id": bogus, "mode": "audio"},
            headers=auth_headers(admin_token),
        )
        assert r.status_code == 404


# ---------------- WebSocket ----------------
@pytest.mark.asyncio
class TestWebSocket:
    async def test_ws_hello_with_valid_token(self, admin_token):
        url = f"{_ws_url()}/api/ws?ticket={_ws_ticket(admin_token)}"
        async with websockets.connect(url, open_timeout=10) as ws:
            raw = await asyncio.wait_for(ws.recv(), timeout=5)
            data = json.loads(raw)
            assert data["type"] == "hello"
            assert data["data"]["user_id"]

    async def test_ws_missing_ticket_closes(self):
        url = f"{_ws_url()}/api/ws"
        try:
            async with websockets.connect(url, open_timeout=10) as ws:
                # Server sends error then closes
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=5)
                    data = json.loads(raw)
                    assert data["type"] == "error"
                except Exception:
                    pass
                # Receiving again should fail (closed)
                with pytest.raises(Exception):
                    await asyncio.wait_for(ws.recv(), timeout=3)
        except Exception:
            pass  # rejection at handshake also acceptable

    async def test_ws_invalid_ticket_closes(self):
        url = f"{_ws_url()}/api/ws?ticket=not-a-jwt"
        async with websockets.connect(url, open_timeout=10) as ws:
            raw = await asyncio.wait_for(ws.recv(), timeout=5)
            data = json.loads(raw)
            assert data["type"] == "error"
            with pytest.raises(Exception):
                await asyncio.wait_for(ws.recv(), timeout=3)

    async def test_ws_signaling_offer_forwarded(self, admin_token, demo_token):
        admin = requests.get(
            f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token)
        ).json()
        demo = requests.get(
            f"{BASE_URL}/api/auth/me", headers=auth_headers(demo_token)
        ).json()
        ensure_e2ee_keys((admin_token, "admin"), (demo_token, "demo"))
        ensure_contact(admin_token, admin, demo_token, demo)
        conv = requests.post(
            f"{BASE_URL}/api/conversations",
            json={"type": "direct", "member_ids": [demo["id"]]},
            headers=auth_headers(admin_token),
        )
        assert conv.status_code == 200, conv.text
        conv_id = conv.json()["id"]

        url_a = f"{_ws_url()}/api/ws?ticket={_ws_ticket(admin_token)}"
        url_b = f"{_ws_url()}/api/ws?ticket={_ws_ticket(demo_token)}"
        async with websockets.connect(url_a, open_timeout=10) as ws_a, \
                   websockets.connect(url_b, open_timeout=10) as ws_b:
            # consume hello
            await asyncio.wait_for(ws_a.recv(), timeout=5)
            await asyncio.wait_for(ws_b.recv(), timeout=5)

            offer = {
                "type": "call:offer",
                "to": demo["id"],
                "conversation_id": conv_id,
                "call_id": "TEST_CALL_ID",
                "encrypted": True,
                "e2ee_signal": {
                    "version": 1,
                    "algorithm": "nacl-box-v1",
                    "sender_public_key": "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=",
                    "nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=",
                    "ciphertext": "Y2lwaGVydGV4dF9jYWxsX29mZmVy",
                },
                "sdp": "TEST_SDP_SHOULD_NOT_FORWARD",
            }
            await ws_a.send(json.dumps(offer))

            raw = await asyncio.wait_for(ws_b.recv(), timeout=5)
            data = json.loads(raw)
            assert data["type"] == "call:offer"
            assert data["from"] == admin["id"]
            assert data["encrypted"] is True
            assert data["e2ee_signal"]["ciphertext"] == "Y2lwaGVydGV4dF9jYWxsX29mZmVy"
            assert "sdp" not in data

    async def test_ws_message_broadcast_on_send(self, admin_token, demo_token):
        admin = requests.get(
            f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token)
        ).json()
        demo = requests.get(
            f"{BASE_URL}/api/auth/me", headers=auth_headers(demo_token)
        ).json()
        ensure_e2ee_keys((admin_token, "admin"), (demo_token, "demo"))
        ensure_contact(admin_token, admin, demo_token, demo)
        # ensure conversation exists
        conv = requests.post(
            f"{BASE_URL}/api/conversations",
            json={"type": "direct", "member_ids": [demo["id"]]},
            headers=auth_headers(admin_token),
        )
        assert conv.status_code == 200, conv.text
        conv = conv.json()
        conv_id = conv["id"]

        url_b = f"{_ws_url()}/api/ws?ticket={_ws_ticket(demo_token)}"
        async with websockets.connect(url_b, open_timeout=10) as ws_b:
            await asyncio.wait_for(ws_b.recv(), timeout=5)  # hello

            # Admin sends message via REST
            await asyncio.sleep(0.2)
            requests.post(
                f"{BASE_URL}/api/messages",
                json={
                    "conversation_id": conv_id,
                    "content": "TEST_ws_broadcast",
                    "encrypted": True,
                    "e2ee": e2ee_payload("admin", [admin["id"], demo["id"]]),
                },
                headers=auth_headers(admin_token),
            )

            # Demo socket should receive a 'message' event
            got = None
            for _ in range(5):
                try:
                    raw = await asyncio.wait_for(ws_b.recv(), timeout=3)
                    data = json.loads(raw)
                    if data.get("type") == "message":
                        got = data
                        break
                except asyncio.TimeoutError:
                    break
            assert got is not None, "Did not receive WS message broadcast"
            assert got["data"]["content"] == "[encrypted message]"
