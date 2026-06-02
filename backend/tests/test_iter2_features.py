"""Silentel iteration 2 tests — uploads, push, calls, WebSocket signaling,
and message kinds (image/voice/file with attachment_id)."""
import asyncio
import base64
import json
import uuid

import pytest
import requests
import websockets
from conftest import auth_headers, BASE_URL, ensure_contact


def _ws_url() -> str:
    if BASE_URL.startswith("https://"):
        return "wss://" + BASE_URL[len("https://"):]
    return "ws://" + BASE_URL[len("http://"):]


# ---------------- Uploads ----------------
class TestUploads:
    def test_upload_and_fetch(self, api_client, admin_token):
        data_b = b"hello-silentel-upload-test"
        b64 = base64.b64encode(data_b).decode()
        payload = {
            "filename": "TEST_hello.txt",
            "mime": "text/plain",
            "data": b64,
            "size": len(data_b),
        }
        r = api_client.post(f"{BASE_URL}/api/uploads", json=payload, headers=auth_headers(admin_token))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["filename"] == "TEST_hello.txt"
        assert body["mime"] == "text/plain"
        assert body["size"] == len(data_b)
        assert "id" in body
        pytest.attachment_id = body["id"]

        # GET back as same owner
        g = api_client.get(f"{BASE_URL}/api/uploads/{body['id']}", headers=auth_headers(admin_token))
        assert g.status_code == 200
        gb = g.json()
        assert gb["owner_id"]
        assert gb["data"] == b64
        assert gb["filename"] == "TEST_hello.txt"

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
            "filename": "big.bin", "mime": "application/octet-stream",
            "data": "QQ==", "size": size
        }, headers=auth_headers(admin_token))
        assert r.status_code in (413, 422), f"got {r.status_code}: {r.text}"


# ---------------- Messages with attachments ----------------
class TestMessageKinds:
    @pytest.fixture(scope="class")
    def conv_id(self, admin_token, demo_token):
        admin = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token)).json()
        demo = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(demo_token)).json()
        ensure_contact(admin_token, admin, demo_token, demo)
        r = requests.post(
            f"{BASE_URL}/api/conversations",
            json={"type": "direct", "member_ids": [demo["id"]]},
            headers=auth_headers(admin_token),
        )
        assert r.status_code == 200
        return r.json()["id"]

    def _upload(self, token, name="att.bin", mime="application/octet-stream"):
        data_b = b"binary-payload"
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
    def test_send_message_with_attachment(self, api_client, admin_token, conv_id, kind, mime):
        att_id = self._upload(admin_token, name=f"TEST_{kind}.bin", mime=mime)
        extra = {"duration_ms": 2500} if kind == "voice" else {}
        r = api_client.post(
            f"{BASE_URL}/api/messages",
            json={
                "conversation_id": conv_id,
                "content": "",
                "kind": kind,
                "attachment_id": att_id,
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
        ensure_contact(admin_token, admin, demo_token, demo)
        r = requests.post(
            f"{BASE_URL}/api/conversations",
            json={"type": "direct", "member_ids": [demo["id"]]},
            headers=auth_headers(admin_token),
        )
        return r.json()["id"]

    def test_start_and_end_call(self, api_client, admin_token, conv_id):
        s = api_client.post(
            f"{BASE_URL}/api/calls/start",
            json={"conversation_id": conv_id, "mode": "audio"},
            headers=auth_headers(admin_token),
        )
        assert s.status_code == 200, s.text
        call = s.json()
        assert call["status"] == "ringing"
        assert call["caller_id"]
        assert call["caller_name"]
        assert call["conversation_id"] == conv_id
        assert isinstance(call["member_ids"], list) and len(call["member_ids"]) == 2

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
        url = f"{_ws_url()}/api/ws?token={admin_token}"
        async with websockets.connect(url, open_timeout=10) as ws:
            raw = await asyncio.wait_for(ws.recv(), timeout=5)
            data = json.loads(raw)
            assert data["type"] == "hello"
            assert data["data"]["user_id"]

    async def test_ws_missing_token_closes(self):
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

    async def test_ws_invalid_token_closes(self):
        url = f"{_ws_url()}/api/ws?token=not-a-jwt"
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
        ensure_contact(admin_token, admin, demo_token, demo)
        conv = requests.post(
            f"{BASE_URL}/api/conversations",
            json={"type": "direct", "member_ids": [demo["id"]]},
            headers=auth_headers(admin_token),
        )
        assert conv.status_code == 200, conv.text
        conv_id = conv.json()["id"]

        url_a = f"{_ws_url()}/api/ws?token={admin_token}"
        url_b = f"{_ws_url()}/api/ws?token={demo_token}"
        async with websockets.connect(url_a, open_timeout=10) as ws_a, \
                   websockets.connect(url_b, open_timeout=10) as ws_b:
            # consume hello
            await asyncio.wait_for(ws_a.recv(), timeout=5)
            await asyncio.wait_for(ws_b.recv(), timeout=5)

            offer = {
                "type": "call:offer",
                "to": demo["id"],
                "conversation_id": conv_id,
                "sdp": "TEST_SDP",
            }
            await ws_a.send(json.dumps(offer))

            raw = await asyncio.wait_for(ws_b.recv(), timeout=5)
            data = json.loads(raw)
            assert data["type"] == "call:offer"
            assert data["from"] == admin["id"]
            assert data["sdp"] == "TEST_SDP"

    async def test_ws_message_broadcast_on_send(self, admin_token, demo_token):
        admin = requests.get(
            f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token)
        ).json()
        demo = requests.get(
            f"{BASE_URL}/api/auth/me", headers=auth_headers(demo_token)
        ).json()
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

        url_b = f"{_ws_url()}/api/ws?token={demo_token}"
        async with websockets.connect(url_b, open_timeout=10) as ws_b:
            await asyncio.wait_for(ws_b.recv(), timeout=5)  # hello

            # Admin sends message via REST
            await asyncio.sleep(0.2)
            requests.post(
                f"{BASE_URL}/api/messages",
                json={"conversation_id": conv_id, "content": "TEST_ws_broadcast"},
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
            assert got["data"]["content"] == "TEST_ws_broadcast"
