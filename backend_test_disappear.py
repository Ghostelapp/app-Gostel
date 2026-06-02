"""Backend test for NEW 'disappear after read' behavior.

Verifies that:
- Sending a disappearing-message-enabled conversation stamps
  `disappear_seconds` on the message but DOES NOT set `expires_at`.
- The sender re-listing their own messages does NOT trigger the countdown.
- A non-sender listing messages sets `expires_at = now + disappear_seconds`.
- Calling list again is idempotent (expires_at unchanged).
- Group chat: first non-sender reader sets it; sender does not.
- With disappearing disabled, neither field is present on new messages.
"""
import os
import sys
import time
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


def H(tok):
    return {"Authorization": f"Bearer {tok}"}


def login(creds):
    r = requests.post(f"{BASE}/auth/login", json=creds, timeout=15)
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    return r.json()["access_token"], r.json()["user"]


def ensure_contacts(demo_tok, demo_user, admin_tok, admin_user):
    r = requests.get(f"{BASE}/contacts", headers=H(demo_tok))
    if r.status_code == 200 and any(c["id"] == admin_user["id"] for c in r.json()):
        return True
    admin_username = admin_user.get("username") or "admin"
    inv = requests.post(f"{BASE}/contacts/invite", headers=H(demo_tok),
                        json={"username": admin_username})
    if inv.status_code not in (200, 201, 409):
        print(f"   invite create status={inv.status_code} body={inv.text[:200]}")
    invs = requests.get(f"{BASE}/contacts/invitations", headers=H(admin_tok)).json()
    incoming = invs.get("incoming") or []
    target = next((i for i in incoming if (i.get("from_user") or {}).get("id") == demo_user["id"]), None)
    if target:
        requests.post(f"{BASE}/contacts/invitations/{target['id']}/accept", headers=H(admin_tok))
    r2 = requests.get(f"{BASE}/contacts", headers=H(demo_tok))
    return r2.status_code == 200 and any(c["id"] == admin_user["id"] for c in r2.json())


def get_or_create_direct(demo_tok, demo_user, admin_tok, admin_user):
    convs = requests.get(f"{BASE}/conversations", headers=H(demo_tok)).json()
    for c in convs:
        if c.get("type") == "direct":
            ids = [m["id"] for m in c.get("members", [])]
            if admin_user["id"] in ids and demo_user["id"] in ids:
                return c
    r = requests.post(
        f"{BASE}/conversations",
        headers=H(demo_tok),
        json={"type": "direct", "member_ids": [admin_user["id"]]},
    )
    assert r.status_code == 200, f"create direct failed: {r.status_code} {r.text}"
    return r.json()


def find_msg(msgs, mid):
    for m in msgs:
        if m["id"] == mid:
            return m
    return None


def main():
    print(f"BASE = {BASE}")
    admin_tok, admin_user = login(ADMIN)
    demo_tok, demo_user = login(DEMO)
    print(f"admin id={admin_user['id']}")
    print(f"demo  id={demo_user['id']}")

    _ok("ensure contacts", ensure_contacts(demo_tok, demo_user, admin_tok, admin_user))

    conv = get_or_create_direct(demo_tok, demo_user, admin_tok, admin_user)
    conv_id = conv["id"]
    print(f"direct conv_id={conv_id}")

    # -------- STEP 2: enable disappearing 60s
    r = requests.patch(
        f"{BASE}/conversations/{conv_id}/disappearing",
        headers=H(admin_tok),
        json={"seconds": 60},
    )
    _ok("PATCH disappearing seconds=60 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    if r.status_code == 200:
        body = r.json()
        _ok("conv.disappear_seconds == 60", body.get("disappear_seconds") == 60, str(body.get("disappear_seconds")))

    # -------- STEP 3: send-time check — admin sends a message
    t0 = datetime.now(timezone.utc)
    r = requests.post(
        f"{BASE}/messages",
        headers=H(admin_tok),
        json={"conversation_id": conv_id, "content": "disappear-after-read test", "kind": "text"},
    )
    _ok("POST /messages 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    if r.status_code != 200:
        print("Cannot continue — aborting.")
        return
    msg = r.json()
    mid = msg["id"]
    print(f"sent mid={mid}")
    _ok("send-time: disappear_seconds == 60", msg.get("disappear_seconds") == 60, str(msg.get("disappear_seconds")))
    _ok("send-time: NO expires_at on message",
        not msg.get("expires_at"),
        f"expires_at={msg.get('expires_at')}")

    # -------- STEP 4: sender re-opens own chat (no trigger)
    r = requests.get(f"{BASE}/conversations/{conv_id}/messages", headers=H(admin_tok))
    _ok("admin GET messages 200", r.status_code == 200, f"{r.status_code}")
    if r.status_code == 200:
        m = find_msg(r.json(), mid)
        _ok("admin sees own msg in list", m is not None)
        if m:
            _ok("admin re-open: STILL no expires_at (sender path)",
                not m.get("expires_at"),
                f"expires_at={m.get('expires_at')}")
            _ok("admin re-open: disappear_seconds still 60",
                m.get("disappear_seconds") == 60,
                str(m.get("disappear_seconds")))

    # -------- STEP 5: recipient opens chat — TRIGGERS the countdown
    t_trigger_start = datetime.now(timezone.utc)
    r = requests.get(f"{BASE}/conversations/{conv_id}/messages", headers=H(demo_tok))
    t_trigger_end = datetime.now(timezone.utc)
    _ok("demo GET messages 200 (first read)", r.status_code == 200, f"{r.status_code}")
    expires_at_first = None
    if r.status_code == 200:
        m = find_msg(r.json(), mid)
        _ok("demo sees admin's msg", m is not None)
        if m:
            ea = m.get("expires_at")
            _ok("first-read: expires_at IS set", bool(ea), f"expires_at={ea}")
            expires_at_first = ea
            _ok("first-read: disappear_seconds == 60",
                m.get("disappear_seconds") == 60,
                str(m.get("disappear_seconds")))
            if ea:
                try:
                    dt = datetime.fromisoformat(ea.replace("Z", "+00:00"))
                    # Expected: t_trigger_start + 60s <= dt <= t_trigger_end + 60s (+small buffer)
                    earliest = t_trigger_start.timestamp() + 60 - 5
                    latest = t_trigger_end.timestamp() + 60 + 5
                    actual = dt.timestamp()
                    _ok("first-read: expires_at ~ now+60s (±5s)",
                        earliest <= actual <= latest,
                        f"actual={actual} earliest={earliest} latest={latest} (diff={actual - t_trigger_end.timestamp()}s)")
                except Exception as e:
                    _ok("first-read: parse expires_at", False, str(e))

    # -------- STEP 6: idempotency — same expires_at on subsequent reads
    time.sleep(1.5)
    r = requests.get(f"{BASE}/conversations/{conv_id}/messages", headers=H(demo_tok))
    _ok("demo GET messages 200 (second read)", r.status_code == 200, f"{r.status_code}")
    if r.status_code == 200 and expires_at_first:
        m = find_msg(r.json(), mid)
        if m:
            _ok("idempotency: expires_at unchanged on re-read",
                m.get("expires_at") == expires_at_first,
                f"first={expires_at_first} second={m.get('expires_at')}")

    # Also sender re-reading must NOT change it
    r = requests.get(f"{BASE}/conversations/{conv_id}/messages", headers=H(admin_tok))
    if r.status_code == 200 and expires_at_first:
        m = find_msg(r.json(), mid)
        if m:
            _ok("idempotency: sender now sees expires_at == demo's first-read value",
                m.get("expires_at") == expires_at_first,
                f"sender={m.get('expires_at')} expected={expires_at_first}")

    # -------- STEP 7: GROUP chat first-reader wins
    g = requests.post(
        f"{BASE}/conversations",
        headers=H(admin_tok),
        json={"type": "group", "name": "Disappear Group", "member_ids": [demo_user["id"]]},
    )
    _ok("create group conversation 200", g.status_code == 200, f"{g.status_code} {g.text[:200]}")
    if g.status_code == 200:
        gconv = g.json()
        gid = gconv["id"]
        # enable disappearing
        gr = requests.patch(f"{BASE}/conversations/{gid}/disappearing",
                            headers=H(admin_tok), json={"seconds": 60})
        _ok("group PATCH disappearing 60s 200", gr.status_code == 200, f"{gr.status_code}")

        gs = requests.post(
            f"{BASE}/messages",
            headers=H(admin_tok),
            json={"conversation_id": gid, "content": "group disappear test", "kind": "text"},
        )
        _ok("group send msg 200", gs.status_code == 200, f"{gs.status_code} {gs.text[:200]}")
        if gs.status_code == 200:
            gmid = gs.json()["id"]
            _ok("group send-time: no expires_at",
                not gs.json().get("expires_at"),
                f"expires_at={gs.json().get('expires_at')}")
            _ok("group send-time: disappear_seconds=60",
                gs.json().get("disappear_seconds") == 60,
                str(gs.json().get("disappear_seconds")))

            # demo (non-sender) reads → expires_at gets set
            r = requests.get(f"{BASE}/conversations/{gid}/messages", headers=H(demo_tok))
            ga_first = None
            if r.status_code == 200:
                m = find_msg(r.json(), gmid)
                if m:
                    ga_first = m.get("expires_at")
                    _ok("group: demo first-read sets expires_at", bool(ga_first), f"expires_at={ga_first}")

            # admin (sender) reads — should NOT change it
            r = requests.get(f"{BASE}/conversations/{gid}/messages", headers=H(admin_tok))
            if r.status_code == 200:
                m = find_msg(r.json(), gmid)
                if m and ga_first:
                    _ok("group: sender's read does NOT alter expires_at",
                        m.get("expires_at") == ga_first,
                        f"sender_sees={m.get('expires_at')} first={ga_first}")

        # cleanup
        requests.delete(f"{BASE}/conversations/{gid}", headers=H(demo_tok))
        requests.delete(f"{BASE}/conversations/{gid}", headers=H(admin_tok))

    # -------- STEP 9: regression — turn off + DELETE own msg
    # Turn off disappearing
    off = requests.patch(
        f"{BASE}/conversations/{conv_id}/disappearing",
        headers=H(admin_tok),
        json={"seconds": 0},
    )
    _ok("PATCH disappearing seconds=0 (off) 200", off.status_code == 200, f"{off.status_code} {off.text[:200]}")
    if off.status_code == 200:
        _ok("conv.disappear_seconds is None after off",
            off.json().get("disappear_seconds") is None,
            str(off.json().get("disappear_seconds")))

    # Send new message — should NOT have disappear_seconds nor expires_at
    r = requests.post(
        f"{BASE}/messages",
        headers=H(admin_tok),
        json={"conversation_id": conv_id, "content": "regression no-disappear", "kind": "text"},
    )
    _ok("regression: POST /messages 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    if r.status_code == 200:
        m = r.json()
        mid2 = m["id"]
        _ok("regression: no disappear_seconds on message",
            not m.get("disappear_seconds"),
            f"disappear_seconds={m.get('disappear_seconds')}")
        _ok("regression: no expires_at on message",
            not m.get("expires_at"),
            f"expires_at={m.get('expires_at')}")

        # Even after non-sender read, expires_at must NOT get set
        r2 = requests.get(f"{BASE}/conversations/{conv_id}/messages", headers=H(demo_tok))
        if r2.status_code == 200:
            mm = find_msg(r2.json(), mid2)
            if mm:
                _ok("regression: after demo read, still no expires_at",
                    not mm.get("expires_at"),
                    f"expires_at={mm.get('expires_at')}")

        # demo deletes admin's msg → 403
        d = requests.delete(f"{BASE}/messages/{mid2}", headers=H(demo_tok))
        _ok("regression: delete other's msg → 403", d.status_code == 403, f"{d.status_code}")
        # admin deletes own msg → 200
        d2 = requests.delete(f"{BASE}/messages/{mid2}", headers=H(admin_tok))
        _ok("regression: delete own msg → 200", d2.status_code == 200, f"{d2.status_code}")
        if d2.status_code == 200:
            _ok("regression: deleted:true", d2.json().get("deleted") is True, str(d2.json()))

    # Restore: turn off (already off). Clean up: delete the original test msg (admin's)
    requests.delete(f"{BASE}/messages/{mid}", headers=H(admin_tok))

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
