"""Silentel Enterprise API tests — covers auth, users, conversations,
messages, reactions, search, status updates, and TOTP 2FA flow."""
import base64
import os
import time
import uuid
import pyotp
import pytest
import requests
from conftest import auth_headers, BASE_URL, ensure_contact

ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@ghostel.app")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "Admin@2026!")
DEMO_EMAIL = os.environ.get("DEMO_EMAIL", "demo@silentel.app")


# ----------------- Auth -----------------
class TestAuth:
    def test_health(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/")
        assert r.status_code == 200
        assert r.json().get("status") == "ok"

    def test_admin_login(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL, "password": ADMIN_PASSWORD
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert "access_token" in body
        assert body["user"]["email"] == ADMIN_EMAIL
        assert body["user"]["role"] == "admin"

    def test_login_wrong_password(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL, "password": "WRONG"
        })
        assert r.status_code == 401

    def test_register_new_user(self, api_client):
        email = f"test_{uuid.uuid4().hex[:8]}@silentel.app"
        r = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email, "password": "Pass@2026!", "name": "TEST User", "title": "QA"
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert "access_token" in body
        assert body["user"]["email"] == email

        # duplicate
        r2 = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email, "password": "Pass@2026!", "name": "TEST User"
        })
        assert r2.status_code == 400

    def test_me(self, api_client, admin_token):
        r = api_client.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token))
        assert r.status_code == 200
        assert r.json()["email"] == ADMIN_EMAIL

    def test_me_no_token(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 401


# ----------------- Users / Status -----------------
class TestUsers:
    def test_list_users_excludes_self(self, api_client, admin_token, demo_token):
        admin = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token)).json()
        demo = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(demo_token)).json()
        ensure_contact(admin_token, admin, demo_token, demo)

        r = api_client.get(f"{BASE_URL}/api/users", headers=auth_headers(admin_token))
        assert r.status_code == 200
        users = r.json()
        assert isinstance(users, list)
        assert all(u["email"] != ADMIN_EMAIL for u in users)
        assert any(u["email"] == DEMO_EMAIL for u in users)

    @pytest.mark.parametrize("status_val", ["online", "busy", "away", "offline"])
    def test_update_status(self, api_client, admin_token, status_val):
        r = api_client.patch(
            f"{BASE_URL}/api/users/me/status",
            json={"status": status_val},
            headers=auth_headers(admin_token),
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == status_val

        # Verify persistence
        me = api_client.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token))
        assert me.json()["status"] == status_val


# ----------------- Conversations + Messages -----------------
class TestChat:
    @pytest.fixture(scope="class")
    def ids(self, admin_token, demo_token):
        a = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token)).json()
        d = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(demo_token)).json()
        ensure_contact(admin_token, a, demo_token, d)
        return {"admin_id": a["id"], "demo_id": d["id"]}

    def test_create_direct_conversation_idempotent(self, api_client, admin_token, ids):
        r1 = api_client.post(
            f"{BASE_URL}/api/conversations",
            json={"type": "direct", "member_ids": [ids["demo_id"]]},
            headers=auth_headers(admin_token),
        )
        assert r1.status_code == 200, r1.text
        c1 = r1.json()
        assert c1["type"] == "direct"
        assert len(c1["members"]) == 2

        r2 = api_client.post(
            f"{BASE_URL}/api/conversations",
            json={"type": "direct", "member_ids": [ids["demo_id"]]},
            headers=auth_headers(admin_token),
        )
        assert r2.status_code == 200
        assert r2.json()["id"] == c1["id"], "Direct conversation must be idempotent"

        pytest.direct_conv_id = c1["id"]

    def test_create_group_conversation(self, api_client, admin_token, ids):
        r = api_client.post(
            f"{BASE_URL}/api/conversations",
            json={"type": "group", "member_ids": [ids["demo_id"]], "name": "TEST_Group"},
            headers=auth_headers(admin_token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["type"] == "group"
        assert body["name"] == "TEST_Group"
        pytest.group_conv_id = body["id"]

    def test_list_conversations(self, api_client, admin_token):
        r = api_client.get(f"{BASE_URL}/api/conversations", headers=auth_headers(admin_token))
        assert r.status_code == 200
        convs = r.json()
        ids = [c["id"] for c in convs]
        assert pytest.direct_conv_id in ids
        assert pytest.group_conv_id in ids

    def test_send_message_and_list(self, api_client, admin_token, demo_token):
        admin = api_client.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(admin_token)).json()
        demo = api_client.get(f"{BASE_URL}/api/auth/me", headers=auth_headers(demo_token)).json()
        admin_pub = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE="
        demo_pub = "YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI="
        for token, public_key in [(admin_token, admin_pub), (demo_token, demo_pub)]:
            key = api_client.post(
                f"{BASE_URL}/api/e2ee/keys",
                json={"public_key": public_key, "algorithm": "nacl-box-v1"},
                headers=auth_headers(token),
            )
            assert key.status_code == 200, key.text

        plaintext = f"TEST_hello_secure_{uuid.uuid4().hex[:8]}"
        pytest.search_plaintext = plaintext
        payload = {
            "version": 1,
            "algorithm": "nacl-box-v1",
            "sender_public_key": admin_pub,
            "recipients": {
                admin["id"]: {"nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=", "ciphertext": "Y2lwaGVydGV4dF9mb3JfYWRtaW4="},
                demo["id"]: {"nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=", "ciphertext": "Y2lwaGVydGV4dF9mb3JfZGVtbw=="},
            },
        }
        send = api_client.post(
            f"{BASE_URL}/api/messages",
            json={
                "conversation_id": pytest.direct_conv_id,
                "content": plaintext,
                "encrypted": True,
                "e2ee": payload,
            },
            headers=auth_headers(admin_token),
        )
        assert send.status_code == 200, send.text
        msg = send.json()
        assert msg["content"] == "[encrypted message]"
        assert msg.get("encrypted") is True
        assert plaintext not in str(msg)
        pytest.msg_id = msg["id"]

        # Demo user lists messages and marks as read
        lst = api_client.get(
            f"{BASE_URL}/api/conversations/{pytest.direct_conv_id}/messages",
            headers=auth_headers(demo_token),
        )
        assert lst.status_code == 200
        contents = [m["content"] for m in lst.json()]
        assert "[encrypted message]" in contents

    def test_reaction_toggle(self, api_client, demo_token):
        # add
        r1 = api_client.post(
            f"{BASE_URL}/api/messages/{pytest.msg_id}/reactions",
            json={"emoji": "👍"},
            headers=auth_headers(demo_token),
        )
        assert r1.status_code == 200
        assert "👍" in r1.json()["reactions"]
        # toggle off
        r2 = api_client.post(
            f"{BASE_URL}/api/messages/{pytest.msg_id}/reactions",
            json={"emoji": "👍"},
            headers=auth_headers(demo_token),
        )
        assert r2.status_code == 200
        assert "👍" not in r2.json()["reactions"]

    def test_search(self, api_client, admin_token):
        r = api_client.get(
            f"{BASE_URL}/api/search?q={pytest.search_plaintext}",
            headers=auth_headers(admin_token),
        )
        assert r.status_code == 200
        results = r.json()
        assert not any(pytest.search_plaintext in m["content"] for m in results)

    def test_send_e2ee_message_does_not_store_plaintext(self, api_client, admin_token, demo_token, ids):
        admin_pub = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE="
        demo_pub = "YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI="
        for token, public_key in [(admin_token, admin_pub), (demo_token, demo_pub)]:
            key = api_client.post(
                f"{BASE_URL}/api/e2ee/keys",
                json={"public_key": public_key, "algorithm": "nacl-box-v1"},
                headers=auth_headers(token),
            )
            assert key.status_code == 200, key.text

        secret_plaintext = f"TEST_E2EE_SECRET_{uuid.uuid4().hex[:8]}"
        payload = {
            "version": 1,
            "algorithm": "nacl-box-v1",
            "sender_public_key": admin_pub,
            "recipients": {
                ids["admin_id"]: {"nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=", "ciphertext": "Y2lwaGVydGV4dF9mb3JfYWRtaW4="},
                ids["demo_id"]: {"nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=", "ciphertext": "Y2lwaGVydGV4dF9mb3JfZGVtbw=="},
            },
        }
        send = api_client.post(
            f"{BASE_URL}/api/messages",
            json={
                "conversation_id": pytest.direct_conv_id,
                "content": secret_plaintext,
                "encrypted": True,
                "e2ee": payload,
            },
            headers=auth_headers(admin_token),
        )
        assert send.status_code == 200, send.text
        msg = send.json()
        assert msg["encrypted"] is True
        assert msg["content"] == "[encrypted message]"
        assert msg["e2ee"]["sender_public_key"] == admin_pub
        assert secret_plaintext not in str(msg)

        search = api_client.get(
            f"{BASE_URL}/api/search?q={secret_plaintext}",
            headers=auth_headers(admin_token),
        )
        assert search.status_code == 200
        assert search.json() == []

    def test_send_group_e2ee_message_does_not_store_plaintext(self, api_client, admin_token, demo_token, ids):
        admin_pub = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE="
        demo_pub = "YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI="
        for token, public_key in [(admin_token, admin_pub), (demo_token, demo_pub)]:
            key = api_client.post(
                f"{BASE_URL}/api/e2ee/keys",
                json={"public_key": public_key, "algorithm": "nacl-box-v1"},
                headers=auth_headers(token),
            )
            assert key.status_code == 200, key.text

        secret_plaintext = f"TEST_GROUP_E2EE_SECRET_{uuid.uuid4().hex[:8]}"
        payload = {
            "version": 1,
            "algorithm": "nacl-box-v1",
            "sender_public_key": admin_pub,
            "recipients": {
                ids["admin_id"]: {"nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=", "ciphertext": "Z3JvdXBfY2lwaGVyX2FkbWlu"},
                ids["demo_id"]: {"nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=", "ciphertext": "Z3JvdXBfY2lwaGVyX2RlbW8="},
            },
        }
        send = api_client.post(
            f"{BASE_URL}/api/messages",
            json={
                "conversation_id": pytest.group_conv_id,
                "content": secret_plaintext,
                "encrypted": True,
                "e2ee": payload,
            },
            headers=auth_headers(admin_token),
        )
        assert send.status_code == 200, send.text
        msg = send.json()
        assert msg["encrypted"] is True
        assert msg["content"] == "[encrypted message]"
        assert secret_plaintext not in str(msg)

        search = api_client.get(
            f"{BASE_URL}/api/search?q={secret_plaintext}",
            headers=auth_headers(admin_token),
        )
        assert search.status_code == 200
        assert search.json() == []

    def test_send_e2ee_attachment_keeps_metadata_encrypted(self, api_client, admin_token, demo_token, ids):
        admin_pub = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE="
        demo_pub = "YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI="
        for token, public_key in [(admin_token, admin_pub), (demo_token, demo_pub)]:
            key = api_client.post(
                f"{BASE_URL}/api/e2ee/keys",
                json={"public_key": public_key, "algorithm": "nacl-box-v1"},
                headers=auth_headers(token),
            )
            assert key.status_code == 200, key.text

        encrypted_blob = base64.b64encode(b"ciphertext-only").decode()
        upload = api_client.post(
            f"{BASE_URL}/api/uploads",
            json={
                "filename": "sealed.ghostel",
                "mime": "application/octet-stream",
                "data": encrypted_blob,
                "size": len(b"ciphertext-only"),
            },
            headers=auth_headers(admin_token),
        )
        assert upload.status_code == 200, upload.text

        secret_filename = f"TEST_E2EE_FILE_{uuid.uuid4().hex[:8]}.pdf"
        e2ee = {
            "version": 1,
            "algorithm": "nacl-box-v1",
            "sender_public_key": admin_pub,
            "recipients": {
                ids["admin_id"]: {"nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=", "ciphertext": "ZmlsZV9uYW1lX2FkbWlu"},
                ids["demo_id"]: {"nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=", "ciphertext": "ZmlsZV9uYW1lX2RlbW8="},
            },
        }
        e2ee_attachment = {
            "version": 1,
            "algorithm": "nacl-secretbox-v1",
            "nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=",
            "mime": "application/pdf",
            "size": 128,
            "key_recipients": {
                ids["admin_id"]: {"nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=", "ciphertext": "ZmlsZV9rZXlfYWRtaW4="},
                ids["demo_id"]: {"nonce": "bm9uY2Vfbm9uY2Vfbm9uY2Vfbm9uY2U=", "ciphertext": "ZmlsZV9rZXlfZGVtbw=="},
            },
        }
        send = api_client.post(
            f"{BASE_URL}/api/messages",
            json={
                "conversation_id": pytest.direct_conv_id,
                "content": secret_filename,
                "kind": "file",
                "attachment_id": upload.json()["id"],
                "encrypted": True,
                "e2ee": e2ee,
                "e2ee_attachment": e2ee_attachment,
            },
            headers=auth_headers(admin_token),
        )
        assert send.status_code == 200, send.text
        msg = send.json()
        assert msg["content"] == "[encrypted message]"
        assert msg["encrypted"] is True
        assert msg["e2ee_attachment"]["mime"] == "application/pdf"
        assert secret_filename not in str(msg)


# ----------------- 2FA -----------------
class TestTwoFactor:
    def test_full_2fa_flow(self, api_client):
        # Register a fresh user
        email = f"tfa_{uuid.uuid4().hex[:8]}@silentel.app"
        password = "Pass@2026!"
        reg = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email, "password": password, "name": "TEST 2FA"
        })
        assert reg.status_code == 200
        token = reg.json()["access_token"]

        # Setup
        s = api_client.post(
            f"{BASE_URL}/api/auth/2fa/setup",
            json={"password": password},
            headers=auth_headers(token),
        )
        assert s.status_code == 200
        secret = s.json()["secret"]
        assert s.json()["otpauth_uri"].startswith("otpauth://")

        # Enable with valid code
        code = pyotp.TOTP(secret).now()
        e = api_client.post(
            f"{BASE_URL}/api/auth/2fa/enable",
            json={"code": code},
            headers=auth_headers(token),
        )
        assert e.status_code == 200, e.text
        assert e.json()["two_factor_enabled"] is True

        # Login without code -> requires_2fa
        l1 = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": email, "password": password
        })
        assert l1.status_code == 200
        assert l1.json().get("requires_2fa") is True

        # Login with code -> success
        code2 = pyotp.TOTP(secret).now()
        l2 = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": email, "password": password, "totp_code": code2
        })
        assert l2.status_code == 200, l2.text
        assert "access_token" in l2.json()

        # Login with wrong code
        l3 = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": email, "password": password, "totp_code": "000000"
        })
        assert l3.status_code == 401
