"""Phase D backend integration tests for ghostel.app.

Targets:
- DELETE /api/conversations/{conv_id}
- GET /api/users/{user_id}
- POST /api/users/me/mute_user/{target_id}
- DELETE /api/users/me/mute_user/{target_id}
- GET /api/calls?conversation_id=...
- GET /api/auth/me (new shape)
- Regression: avatar, heartbeat, export, delete message
"""
import os
import sys
import time
import base64
from datetime import datetime, timezone
import requests

BASE = os.environ.get("BACKEND_URL", "https://collab-platform-41.preview.emergentagent.com").rstrip("/") + "/api"
ADMIN = {"email": "admin@ghostel.app", "password": "Admin@2026!"}
DEMO = {"email": "demo@silentel.app", "password": "Demo@2026!"}

PASS = []
FAIL = []


def _ok(name, cond, info=""):
    if cond:
        PASS.append(name)
        print(f"[PASS] {name}")
    else:
        FAIL.append((name, info))
        print(f"[FAIL] {name} -- {info}")


def login(creds):
    r = requests.post(f"{BASE}/auth/login", json=creds, timeout=15)
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    return r.json()["access_token"], r.json()["user"]


def H(tok):
    return {"Authorization": f"Bearer {tok}"}


def get_or_invite_contact(demo_tok, demo_user, admin_tok, admin_user):
    """Ensure admin and demo are mutual contacts."""
    # Check current contacts
    r = requests.get(f"{BASE}/contacts", headers=H(demo_tok))
    if r.status_code == 200:
        if any(c["id"] == admin_user["id"] for c in r.json()):
            return True
    # demo invites admin by admin's username
    admin_username = admin_user.get("username") or "admin"
    inv = requests.post(
        f"{BASE}/contacts/invite",
        headers=H(demo_tok),
        json={"username": admin_username},
    )
    if inv.status_code == 409:
        # already pending — fetch admin's incoming invites
        pass
    elif inv.status_code not in (200, 201):
        print(f"   invite create status={inv.status_code} body={inv.text[:200]}")
    # admin lists invitations and accepts
    invs = requests.get(f"{BASE}/contacts/invitations", headers=H(admin_tok)).json()
    incoming = invs.get("incoming") or []
    target = next((i for i in incoming if (i.get("from_user") or {}).get("id") == demo_user["id"]), None)
    if not target:
        # maybe already accepted?
        r2 = requests.get(f"{BASE}/contacts", headers=H(demo_tok))
        return any(c["id"] == admin_user["id"] for c in (r2.json() if r2.status_code == 200 else []))
    acc = requests.post(
        f"{BASE}/contacts/invitations/{target['id']}/accept", headers=H(admin_tok)
    )
    return acc.status_code == 200


def main():
    print(f"BASE = {BASE}")
    demo_tok, demo_user = login(DEMO)
    admin_tok, admin_user = login(ADMIN)
    print(f"demo id={demo_user['id']} username={demo_user.get('username')}")
    print(f"admin id={admin_user['id']} username={admin_user.get('username')}")

    # --- Test 6 FIRST: GET /auth/me shape (also used downstream)
    me = requests.get(f"{BASE}/auth/me", headers=H(demo_tok)).json()
    _ok("auth/me has muted_users", isinstance(me.get("muted_users"), dict), str(me.get("muted_users")))
    _ok("auth/me has muted_conversation_ids", isinstance(me.get("muted_conversation_ids"), list), str(me.get("muted_conversation_ids")))
    _ok("auth/me has blocked_user_ids", isinstance(me.get("blocked_user_ids"), list), str(me.get("blocked_user_ids")))
    _ok("auth/me has save_call_history bool", isinstance(me.get("save_call_history"), bool), str(me.get("save_call_history")))

    # Ensure contacts so we can create direct conv
    if not get_or_invite_contact(demo_tok, demo_user, admin_tok, admin_user):
        print("[WARN] Could not establish contact, will use group conversation fallback")
        use_group = True
    else:
        use_group = False

    # --- 1) Create + DELETE conversation
    if use_group:
        # admin creates group with both
        r = requests.post(
            f"{BASE}/conversations",
            headers=H(admin_tok),
            json={"type": "group", "name": "PhaseD Test Group", "member_ids": [demo_user["id"]]},
        )
    else:
        r = requests.post(
            f"{BASE}/conversations",
            headers=H(demo_tok),
            json={"type": "direct", "member_ids": [admin_user["id"]]},
        )
    _ok("create conversation 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    if r.status_code != 200:
        print("Cannot continue conversation deletion tests")
    else:
        conv = r.json()
        conv_id = conv["id"]
        print(f"conv_id={conv_id} type={conv.get('type')} members={[m['id'] for m in conv.get('members',[])]}")

        # Demo deletes the conv (leaves)
        d = requests.delete(f"{BASE}/conversations/{conv_id}", headers=H(demo_tok))
        _ok("demo DELETE conversation 200", d.status_code == 200, f"{d.status_code} {d.text[:200]}")
        if d.status_code == 200:
            body = d.json()
            _ok("DELETE returns deleted:true", body.get("deleted") is True, str(body))
            _ok("DELETE returns fully_deleted:false (admin still present)", body.get("fully_deleted") is False, str(body))

        # Verify demo no longer sees it
        demo_convs = requests.get(f"{BASE}/conversations", headers=H(demo_tok)).json()
        _ok(
            "demo /conversations no longer contains conv",
            not any(c["id"] == conv_id for c in demo_convs),
            "still present",
        )
        # Admin still sees it
        admin_convs = requests.get(f"{BASE}/conversations", headers=H(admin_tok)).json()
        _ok(
            "admin /conversations still contains conv",
            any(c["id"] == conv_id for c in admin_convs),
            "missing",
        )

        # Admin deletes too — should fully delete
        d2 = requests.delete(f"{BASE}/conversations/{conv_id}", headers=H(admin_tok))
        _ok("admin DELETE conversation 200", d2.status_code == 200, f"{d2.status_code} {d2.text[:200]}")
        if d2.status_code == 200:
            body2 = d2.json()
            _ok("admin DELETE fully_deleted:true", body2.get("fully_deleted") is True, str(body2))
        # Confirm gone for admin
        admin_convs2 = requests.get(f"{BASE}/conversations", headers=H(admin_tok)).json()
        _ok(
            "admin /conversations no longer contains conv after final delete",
            not any(c["id"] == conv_id for c in admin_convs2),
            "still present",
        )

    # --- 2) GET /api/users/{user_id}
    r = requests.get(f"{BASE}/users/{admin_user['id']}", headers=H(demo_tok))
    _ok("GET /users/{admin_id} 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    if r.status_code == 200:
        u = r.json()
        required = ["id", "name", "email", "username", "avatar", "last_seen", "last_active",
                   "is_blocked", "is_blocking_me", "is_contact", "muted", "muted_until"]
        missing = [k for k in required if k not in u]
        _ok("GET /users/{id} has all fields", not missing, f"missing={missing}")
        _ok("is_blocked false initially", u.get("is_blocked") is False, str(u.get("is_blocked")))
        _ok("is_blocking_me false", u.get("is_blocking_me") is False, str(u.get("is_blocking_me")))
        _ok("muted false initially", u.get("muted") is False, str(u.get("muted")))
        _ok("muted_until null initially", u.get("muted_until") is None, str(u.get("muted_until")))

    r404 = requests.get(f"{BASE}/users/bogus-id-xyz-no-user", headers=H(demo_tok))
    _ok("GET /users/{bogus} 404", r404.status_code == 404, f"{r404.status_code}")

    r_self = requests.get(f"{BASE}/users/{demo_user['id']}", headers=H(demo_tok))
    _ok("GET /users/{own_id} 200", r_self.status_code == 200, f"{r_self.status_code}")

    # --- 3) POST mute_user
    mute = requests.post(
        f"{BASE}/users/me/mute_user/{admin_user['id']}",
        headers=H(demo_tok),
        json={"duration_seconds": 3600},
    )
    _ok("POST mute_user (1h) 200", mute.status_code == 200, f"{mute.status_code} {mute.text[:200]}")
    if mute.status_code == 200:
        body = mute.json()
        _ok("mute response muted:true", body.get("muted") is True, str(body))
        until_iso = body.get("until")
        _ok("mute response has until ISO", isinstance(until_iso, str) and "T" in until_iso, str(until_iso))
        if isinstance(until_iso, str):
            try:
                # Parse ISO and verify within tolerance
                dt = datetime.fromisoformat(until_iso.replace("Z", "+00:00"))
                delta = (dt - datetime.now(timezone.utc)).total_seconds()
                _ok("mute until ~3600s from now", 3300 < delta < 3700, f"delta={delta}")
            except Exception as e:
                _ok("mute until parse", False, str(e))

        # Re-fetch user profile - should be muted
        u2 = requests.get(f"{BASE}/users/{admin_user['id']}", headers=H(demo_tok)).json()
        _ok("after mute: GET /users muted=true", u2.get("muted") is True, str(u2.get("muted")))
        _ok("after mute: muted_until matches", u2.get("muted_until") == until_iso, f"{u2.get('muted_until')} vs {until_iso}")

        # /auth/me reflects mute
        me2 = requests.get(f"{BASE}/auth/me", headers=H(demo_tok)).json()
        mu = me2.get("muted_users") or {}
        entry = mu.get(admin_user["id"])
        _ok("auth/me.muted_users contains admin", isinstance(entry, dict), str(entry))
        if isinstance(entry, dict):
            _ok("auth/me.muted_users[admin].until set", entry.get("until") == until_iso, f"{entry.get('until')} vs {until_iso}")

    # Mute forever (null)
    mute_forever = requests.post(
        f"{BASE}/users/me/mute_user/{admin_user['id']}",
        headers=H(demo_tok),
        json={"duration_seconds": None},
    )
    _ok("POST mute_user (forever) 200", mute_forever.status_code == 200, f"{mute_forever.status_code} {mute_forever.text[:200]}")
    if mute_forever.status_code == 200:
        b = mute_forever.json()
        _ok("forever mute until=null", b.get("until") is None, str(b))
        _ok("forever mute muted=true", b.get("muted") is True, str(b))

    # Self mute → 400
    self_mute = requests.post(
        f"{BASE}/users/me/mute_user/{demo_user['id']}",
        headers=H(demo_tok),
        json={"duration_seconds": 3600},
    )
    _ok("mute self → 400", self_mute.status_code == 400, f"{self_mute.status_code} {self_mute.text[:200]}")

    # Bogus → 404
    bogus_mute = requests.post(
        f"{BASE}/users/me/mute_user/bogus-id-xyz-no-user",
        headers=H(demo_tok),
        json={"duration_seconds": 3600},
    )
    _ok("mute bogus → 404", bogus_mute.status_code == 404, f"{bogus_mute.status_code} {bogus_mute.text[:200]}")

    # --- 4) DELETE mute_user
    unmute = requests.delete(
        f"{BASE}/users/me/mute_user/{admin_user['id']}",
        headers=H(demo_tok),
    )
    _ok("DELETE unmute 200", unmute.status_code == 200, f"{unmute.status_code} {unmute.text[:200]}")
    if unmute.status_code == 200:
        _ok("unmute response muted:false", unmute.json().get("muted") is False, str(unmute.json()))

    u3 = requests.get(f"{BASE}/users/{admin_user['id']}", headers=H(demo_tok)).json()
    _ok("after unmute: muted=false", u3.get("muted") is False, str(u3.get("muted")))

    me3 = requests.get(f"{BASE}/auth/me", headers=H(demo_tok)).json()
    _ok(
        "auth/me.muted_users no longer contains admin",
        admin_user["id"] not in (me3.get("muted_users") or {}),
        str(me3.get("muted_users")),
    )

    # --- 5) GET /api/calls?conversation_id=
    # Create a fresh group conv (admin) to use as filter target — likely has no calls
    cr = requests.post(
        f"{BASE}/conversations",
        headers=H(admin_tok),
        json={"type": "group", "name": "PhaseD calls filter", "member_ids": [demo_user["id"]]},
    )
    if cr.status_code == 200:
        empty_conv_id = cr.json()["id"]
        cal = requests.get(
            f"{BASE}/calls",
            headers=H(admin_tok),
            params={"conversation_id": empty_conv_id, "limit": 5},
        )
        _ok("GET /calls?conversation_id 200", cal.status_code == 200, f"{cal.status_code} {cal.text[:200]}")
        if cal.status_code == 200:
            data = cal.json()
            _ok("GET /calls?conversation_id returns list", isinstance(data, list), str(type(data)))
            # If any calls, verify they all match conv id
            if data:
                all_match = all(
                    (c.get("conv_id") == empty_conv_id or c.get("conversation_id") == empty_conv_id)
                    for c in data
                )
                _ok("all calls match conversation filter", all_match, str(data))
        # cleanup
        requests.delete(f"{BASE}/conversations/{empty_conv_id}", headers=H(admin_tok))
        requests.delete(f"{BASE}/conversations/{empty_conv_id}", headers=H(demo_tok))
    else:
        _ok("GET /calls?conversation_id 200", False, f"setup conv failed: {cr.status_code}")

    # --- 7) Regression — avatar
    # tiny 1x1 PNG base64
    tiny_png_b64 = (
        "data:image/png;base64,"
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    av = requests.patch(f"{BASE}/users/me/avatar", headers=H(demo_tok), json={"avatar": tiny_png_b64})
    _ok("PATCH avatar 200", av.status_code == 200, f"{av.status_code} {av.text[:200]}")

    # heartbeat
    hb = requests.post(f"{BASE}/users/me/heartbeat", headers=H(demo_tok))
    _ok("POST heartbeat 200", hb.status_code == 200, f"{hb.status_code} {hb.text[:200]}")
    if hb.status_code == 200:
        _ok("heartbeat ok:true", hb.json().get("ok") is True, str(hb.json()))

    # export
    ex = requests.get(f"{BASE}/users/me/export", headers=H(demo_tok))
    _ok("GET export 200", ex.status_code == 200, f"{ex.status_code}")
    if ex.status_code == 200:
        for k in ("profile", "contacts", "conversations", "messages", "calls", "counts"):
            _ok(f"export has '{k}'", k in ex.json(), str(list(ex.json().keys())))

    # --- DELETE message: own / someone else's
    # demo creates direct/group with admin (if not already), sends msg
    # Find or create a conversation with admin
    convs = requests.get(f"{BASE}/conversations", headers=H(demo_tok)).json()
    target_conv = None
    for c in convs:
        member_ids = [m["id"] for m in c.get("members", [])]
        if admin_user["id"] in member_ids:
            target_conv = c
            break
    if not target_conv:
        # try create direct
        if not use_group:
            cc = requests.post(
                f"{BASE}/conversations",
                headers=H(demo_tok),
                json={"type": "direct", "member_ids": [admin_user["id"]]},
            )
        else:
            cc = requests.post(
                f"{BASE}/conversations",
                headers=H(admin_tok),
                json={"type": "group", "name": "msg-del-test", "member_ids": [demo_user["id"]]},
            )
        if cc.status_code == 200:
            target_conv = cc.json()
    if target_conv:
        # demo sends a message
        msg_resp = requests.post(
            f"{BASE}/messages",
            headers=H(demo_tok),
            json={"conversation_id": target_conv["id"], "content": "test message to delete", "kind": "text"},
        )
        if msg_resp.status_code == 200:
            mid = msg_resp.json()["id"]
            # demo deletes own message
            d = requests.delete(f"{BASE}/messages/{mid}", headers=H(demo_tok))
            _ok("DELETE own message 200", d.status_code == 200, f"{d.status_code} {d.text[:200]}")
            if d.status_code == 200:
                _ok("DELETE own message deleted:true", d.json().get("deleted") is True, str(d.json()))

        # Admin sends a message; demo tries to delete -> 403
        admin_msg = requests.post(
            f"{BASE}/messages",
            headers=H(admin_tok),
            json={"conversation_id": target_conv["id"], "content": "admin msg", "kind": "text"},
        )
        if admin_msg.status_code == 200:
            amid = admin_msg.json()["id"]
            d403 = requests.delete(f"{BASE}/messages/{amid}", headers=H(demo_tok))
            _ok("DELETE other's message → 403", d403.status_code == 403, f"{d403.status_code} {d403.text[:200]}")
            # cleanup
            requests.delete(f"{BASE}/messages/{amid}", headers=H(admin_tok))
    else:
        print("[WARN] No conversation available for message delete tests")

    # ------ Summary
    print("\n" + "=" * 60)
    print(f"PASS: {len(PASS)}  FAIL: {len(FAIL)}")
    if FAIL:
        print("\nFAILURES:")
        for n, info in FAIL:
            print(f"  - {n}: {info}")
    print("=" * 60)
    sys.exit(0 if not FAIL else 1)


if __name__ == "__main__":
    main()
