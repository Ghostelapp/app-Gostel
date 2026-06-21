"""Iteration 4: Admin endpoints + regression smoke."""
import uuid
import requests
from conftest import (
    BASE_URL,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    DEMO_EMAIL,
    DEMO_PASSWORD,
    auth_headers,
    ensure_contact,
    ensure_e2ee_keys,
    e2ee_payload,
)

ADMIN_PW = ADMIN_PASSWORD
DEMO_PW = DEMO_PASSWORD


def _login(email, pw):
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": email, "password": pw}, timeout=20)
    assert r.status_code == 200, f"login {email} -> {r.status_code} {r.text}"
    return r.json()


def _h(token):
    return auth_headers(token)


# ---------- Admin auth ----------
class TestAdminAuth:
    def test_admin_login_returns_admin_role(self):
        body = _login(ADMIN_EMAIL, ADMIN_PW)
        assert "access_token" in body
        assert isinstance(body.get("session_id"), str) and len(body["session_id"]) >= 8
        assert body["user"]["role"] == "admin"
        assert body["user"]["email"] == ADMIN_EMAIL

    def test_demo_login_is_user_role(self):
        body = _login(DEMO_EMAIL, DEMO_PW)
        assert body["user"]["role"] in ("user", "moderator", "guest")
        assert body["user"]["role"] != "admin"

    def test_logout_revokes_current_session(self):
        body = _login(DEMO_EMAIL, DEMO_PW)
        token = body["access_token"]
        session_id = body["session_id"]
        out = requests.post(f"{BASE_URL}/api/auth/logout", headers=_h(token), timeout=20)
        assert out.status_code == 200, out.text

        me = requests.get(f"{BASE_URL}/api/auth/me", headers=_h(token), timeout=20)
        assert me.status_code == 401

        fresh = _login(DEMO_EMAIL, DEMO_PW)
        listed = requests.get(f"{BASE_URL}/api/auth/sessions", headers=_h(fresh["access_token"]), timeout=20)
        assert listed.status_code == 200, listed.text
        assert all(s["id"] != session_id or s["revoked_at"] for s in listed.json()["sessions"])

    def test_revoke_other_session_invalidates_its_token(self):
        current = _login(DEMO_EMAIL, DEMO_PW)
        other = _login(DEMO_EMAIL, DEMO_PW)

        listed = requests.get(f"{BASE_URL}/api/auth/sessions", headers=_h(current["access_token"]), timeout=20)
        assert listed.status_code == 200, listed.text
        data = listed.json()
        assert any(s["id"] == current["session_id"] and s["current"] for s in data["sessions"])
        assert any(s["id"] == other["session_id"] for s in data["sessions"])

        revoked = requests.delete(
            f"{BASE_URL}/api/auth/sessions/{other['session_id']}",
            headers=_h(current["access_token"]),
            timeout=20,
        )
        assert revoked.status_code == 200, revoked.text
        assert revoked.json()["revoked"] is True
        assert revoked.json()["current_session_revoked"] is False

        me_other = requests.get(f"{BASE_URL}/api/auth/me", headers=_h(other["access_token"]), timeout=20)
        assert me_other.status_code == 401

        me_current = requests.get(f"{BASE_URL}/api/auth/me", headers=_h(current["access_token"]), timeout=20)
        assert me_current.status_code == 200


# ---------- /api/admin/users ----------
class TestAdminUsers:
    def test_admin_list_users_has_admin_fields(self):
        token = _login(ADMIN_EMAIL, ADMIN_PW)["access_token"]
        r = requests.get(f"{BASE_URL}/api/admin/users", headers=_h(token), timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list) and len(data) >= 2
        # Find admin in list
        admin = next((u for u in data if u["email"] == ADMIN_EMAIL), None)
        assert admin is not None
        for k in ("last_seen", "push_registered", "two_factor_enabled", "role", "id", "email"):
            assert k in admin, f"missing admin field {k}"
        assert isinstance(admin["push_registered"], bool)
        assert isinstance(admin["two_factor_enabled"], bool)

    def test_non_admin_cannot_list_users(self):
        token = _login(DEMO_EMAIL, DEMO_PW)["access_token"]
        r = requests.get(f"{BASE_URL}/api/admin/users", headers=_h(token), timeout=20)
        assert r.status_code == 403

    def test_unauth_cannot_list_users(self):
        r = requests.get(f"{BASE_URL}/api/admin/users", timeout=20)
        assert r.status_code == 401


# ---------- /api/admin/stats ----------
class TestAdminStats:
    def test_admin_stats_shape_and_types(self):
        token = _login(ADMIN_EMAIL, ADMIN_PW)["access_token"]
        r = requests.get(f"{BASE_URL}/api/admin/stats", headers=_h(token), timeout=20)
        assert r.status_code == 200
        d = r.json()
        for k in ("users", "conversations", "messages", "online",
                  "two_factor_enabled", "push_ready"):
            assert k in d, f"missing stats key {k}"
            assert isinstance(d[k], int), f"{k} is not int: {type(d[k])}"
        assert d["users"] >= 2

    def test_non_admin_cannot_get_stats(self):
        token = _login(DEMO_EMAIL, DEMO_PW)["access_token"]
        r = requests.get(f"{BASE_URL}/api/admin/stats", headers=_h(token), timeout=20)
        assert r.status_code == 403


# ---------- PATCH role ----------
class TestAdminRoleUpdate:
    def _make_user(self):
        email = f"TEST_role_{uuid.uuid4().hex[:8]}@example.com"
        r = requests.post(f"{BASE_URL}/api/auth/register",
                          json={"email": email, "password": "Pass@2026!",
                                "name": "RoleTest"}, timeout=20)
        assert r.status_code == 200, r.text
        return r.json()["user"]["id"], email, r.json()["access_token"]

    def test_promote_to_moderator(self):
        admin = _login(ADMIN_EMAIL, ADMIN_PW)
        uid, _, _ = self._make_user()
        r = requests.patch(f"{BASE_URL}/api/admin/users/{uid}/role",
                           headers=_h(admin["access_token"]),
                           json={"role": "moderator"}, timeout=20)
        assert r.status_code == 200
        assert r.json()["role"] == "moderator"
        # verify persisted via list
        r2 = requests.get(f"{BASE_URL}/api/admin/users",
                          headers=_h(admin["access_token"]), timeout=20)
        match = next((u for u in r2.json() if u["id"] == uid), None)
        assert match and match["role"] == "moderator"

    def test_admin_cannot_demote_self(self):
        admin = _login(ADMIN_EMAIL, ADMIN_PW)
        r = requests.patch(
            f"{BASE_URL}/api/admin/users/{admin['user']['id']}/role",
            headers=_h(admin["access_token"]),
            json={"role": "moderator"}, timeout=20,
        )
        assert r.status_code == 400

    def test_non_admin_cannot_change_role(self):
        demo = _login(DEMO_EMAIL, DEMO_PW)
        uid, _, _ = self._make_user()
        r = requests.patch(f"{BASE_URL}/api/admin/users/{uid}/role",
                           headers=_h(demo["access_token"]),
                           json={"role": "admin"}, timeout=20)
        assert r.status_code == 403

    def test_invalid_role_rejected(self):
        admin = _login(ADMIN_EMAIL, ADMIN_PW)
        uid, _, _ = self._make_user()
        r = requests.patch(f"{BASE_URL}/api/admin/users/{uid}/role",
                           headers=_h(admin["access_token"]),
                           json={"role": "superduper"}, timeout=20)
        assert r.status_code == 422


# ---------- DELETE user ----------
class TestAdminDelete:
    def _make_user(self):
        email = f"TEST_del_{uuid.uuid4().hex[:8]}@example.com"
        r = requests.post(f"{BASE_URL}/api/auth/register",
                          json={"email": email, "password": "Pass@2026!",
                                "name": "DelTest"}, timeout=20)
        assert r.status_code == 200, r.text
        return r.json()["user"]["id"], r.json()["access_token"]

    def test_delete_user_and_pull_from_conversations(self):
        admin = _login(ADMIN_EMAIL, ADMIN_PW)
        demo = _login(DEMO_EMAIL, DEMO_PW)
        victim_id, victim_token = self._make_user()
        victim_user = requests.get(
            f"{BASE_URL}/api/auth/me",
            headers=_h(victim_token),
            timeout=20,
        ).json()
        ensure_contact(admin["access_token"], admin["user"], demo["access_token"], demo["user"])
        ensure_contact(admin["access_token"], admin["user"], victim_token, victim_user)

        # Create a group conversation containing demo + victim + admin.
        # Group members must be contacts of the creator.
        r = requests.post(
            f"{BASE_URL}/api/conversations",
            headers=_h(admin["access_token"]),
            json={"type": "group", "name": "TEST_iter4_grp",
                  "member_ids": [demo["user"]["id"], victim_id]},
            timeout=20,
        )
        assert r.status_code == 200, r.text
        conv_id = r.json()["id"]
        member_ids_before = [m["id"] for m in r.json()["members"]]
        assert victim_id in member_ids_before

        # Delete victim
        d = requests.delete(f"{BASE_URL}/api/admin/users/{victim_id}",
                            headers=_h(admin["access_token"]), timeout=20)
        assert d.status_code == 200
        assert d.json().get("deleted") is True

        # Conversation should no longer contain victim
        c = requests.get(f"{BASE_URL}/api/conversations/{conv_id}",
                         headers=_h(admin["access_token"]), timeout=20)
        assert c.status_code == 200
        ids_after = [m["id"] for m in c.json()["members"]]
        assert victim_id not in ids_after

        # Victim token should now fail /auth/me
        me = requests.get(f"{BASE_URL}/api/auth/me",
                          headers=_h(victim_token), timeout=20)
        assert me.status_code == 401

    def test_admin_cannot_delete_self(self):
        admin = _login(ADMIN_EMAIL, ADMIN_PW)
        r = requests.delete(
            f"{BASE_URL}/api/admin/users/{admin['user']['id']}",
            headers=_h(admin["access_token"]), timeout=20,
        )
        assert r.status_code == 400

    def test_non_admin_cannot_delete(self):
        demo = _login(DEMO_EMAIL, DEMO_PW)
        uid, _ = self._make_user()
        r = requests.delete(f"{BASE_URL}/api/admin/users/{uid}",
                            headers=_h(demo["access_token"]), timeout=20)
        assert r.status_code == 403


# ---------- Regression smoke ----------
class TestRegression:
    def test_health(self):
        r = requests.get(f"{BASE_URL}/api/", timeout=10)
        assert r.status_code == 200
        assert r.json().get("status") == "ok"

    def test_auth_me_demo(self):
        token = _login(DEMO_EMAIL, DEMO_PW)["access_token"]
        r = requests.get(f"{BASE_URL}/api/auth/me", headers=_h(token), timeout=10)
        assert r.status_code == 200
        assert r.json()["email"] == DEMO_EMAIL

    def test_list_users_for_demo(self):
        token = _login(DEMO_EMAIL, DEMO_PW)["access_token"]
        r = requests.get(f"{BASE_URL}/api/users", headers=_h(token), timeout=10)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_create_conversation_and_message(self):
        admin = _login(ADMIN_EMAIL, ADMIN_PW)
        demo = _login(DEMO_EMAIL, DEMO_PW)
        ensure_e2ee_keys((admin["access_token"], "admin"), (demo["access_token"], "demo"))
        ensure_contact(admin["access_token"], admin["user"], demo["access_token"], demo["user"])
        r = requests.post(f"{BASE_URL}/api/conversations",
                          headers=_h(admin["access_token"]),
                          json={"type": "direct",
                                "member_ids": [demo["user"]["id"]]}, timeout=20)
        assert r.status_code == 200
        cid = r.json()["id"]
        m = requests.post(f"{BASE_URL}/api/messages",
                          headers=_h(admin["access_token"]),
                          json={"conversation_id": cid,
                                "content": f"TEST iter4 {uuid.uuid4().hex[:6]}",
                                "kind": "text",
                                "encrypted": True,
                                "e2ee": e2ee_payload("admin", [admin["user"]["id"], demo["user"]["id"]])}, timeout=20)
        assert m.status_code == 200
        assert m.json()["content"] == "[encrypted message]"

    def test_push_register(self):
        token = _login(DEMO_EMAIL, DEMO_PW)["access_token"]
        r = requests.post(f"{BASE_URL}/api/push/register",
                          headers=_h(token),
                          json={"token": "ExponentPushToken[TEST_iter4]",
                                "platform": "web"}, timeout=10)
        assert r.status_code == 200
        assert r.json()["registered"] is True

    def test_upload_attachment(self):
        token = _login(DEMO_EMAIL, DEMO_PW)["access_token"]
        r = requests.post(f"{BASE_URL}/api/uploads",
                          headers=_h(token),
                          json={"filename": "TEST_iter4.ghostel", "mime": "application/octet-stream",
                                "data": "aGVsbG8=", "size": 5}, timeout=20)
        assert r.status_code == 200
        assert r.json()["filename"] == "TEST_iter4.ghostel"
