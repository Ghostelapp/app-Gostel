"""Per-user disappearing messages — verification for NEW behavior.

Validates:
1) Setup: login admin+demo, find/create direct, enable disappearing 30s.
2) Send-time: sender response has disappear_seconds=30, NO expires_at.
3) First read by recipient (demo): expires_at appears ≈ now+30s.
4) Sender re-fetch: same message returned WITHOUT expires_at for sender.
5) Wait ~35s. Recipient GET: message hidden. Sender GET: still in API (not blocking).
6) Group chat: per-user independence with 60s.
7) Idempotency: recipient repeated GETs → stable expires_at.
8) Regression: disappearing off → no disappear_seconds / no expires_at.
   DELETE /conversations/{id} works. DELETE /messages/{id} works.
"""
import os
import sys
import time
from datetime import datetime, timezone, timedelta
import requests

BASE = os.environ.get(
    "BACKEND_URL",
    "https://collab-platform-41.preview.emergentagent.com",
).rstrip("/") + "/api"
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
    j = r.json()
    return j["access_token"], j["user"]


def parse_iso(s):
    if s is None:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def ensure_contacts(demo_tok, demo_user, admin_tok, admin_user):
    r = requests.get(f"{BASE}/contacts", headers=H(demo_tok))
    if r.status_code == 200 and any(c["id"] == admin_user["id"] for c in r.json()):
        return True
    admin_username = admin_user.get("username") or "admin"
    inv = requests.post(
        f"{BASE}/contacts/invite",
        headers=H(demo_tok),
        json={"username": admin_username},
    )
    if inv.status_code not in (200, 201, 409):
        print(f"   invite create status={inv.status_code} body={inv.text[:200]}")
    invs = requests.get(f"{BASE}/contacts/invitations", headers=H(admin_tok)).json()
    incoming = invs.get("incoming") or []
    target = next(
        (i for i in incoming if (i.get("from_user") or {}).get("id") == demo_user["id"]),
        None,
    )
    if target:
        requests.post(
            f"{BASE}/contacts/invitations/{target['id']}/accept",
            headers=H(admin_tok),
        )
    r2 = requests.get(f"{BASE}/contacts", headers=H(demo_tok))
    return r2.status_code == 200 and any(c["id"] == admin_user["id"] for c in r2.json())


def get_or_create_direct(actor_tok, actor_user, other_user):
    convs = requests.get(f"{BASE}/conversations", headers=H(actor_tok)).json()
    for c in convs:
        if c.get("type") == "direct":
            ids = [m["id"] for m in c.get("members", [])]
            if other_user["id"] in ids and actor_user["id"] in ids:
                return c
    r = requests.post(
        f"{BASE}/conversations",
        headers=H(actor_tok),
        json={"type": "direct", "member_ids": [other_user["id"]]},
    )
    assert r.status_code == 200, f"create direct failed: {r.status_code} {r.text}"
    return r.json()


def find_msg(msgs, mid):
    for m in msgs:
        if m.get("id") == mid:
            return m
    return None


def set_disappearing(tok, conv_id, seconds):
    r = requests.patch(
        f"{BASE}/conversations/{conv_id}/disappearing",
        headers=H(tok),
        json={"seconds": seconds},
    )
    return r


def main():
    print(f"BASE = {BASE}")
    admin_tok, admin_user = login(ADMIN)
    demo_tok, demo_user = login(DEMO)
    print(f"admin id={admin_user['id']}  demo id={demo_user['id']}")

    _ok("ensure contacts admin↔demo", ensure_contacts(demo_tok, demo_user, admin_tok, admin_user))

    conv = get_or_create_direct(demo_tok, demo_user, admin_user)
    conv_id = conv["id"]
    print(f"direct conv_id={conv_id}")

    # -------- STEP 1: enable disappearing 30s
    r = set_disappearing(admin_tok, conv_id, 30)
    _ok(
        "PATCH /conversations/{id}/disappearing seconds=30 → 200",
        r.status_code == 200,
        f"status={r.status_code} body={r.text[:200]}",
    )
    if r.status_code == 200:
        body = r.json()
        c = body.get("conversation") or body
        _ok(
            "conversation.disappear_seconds == 30",
            (c.get("disappear_seconds") == 30) or (body.get("disappear_seconds") == 30),
            f"resp={body}",
        )

    # -------- STEP 2: SEND-TIME CHECK (as admin)
    bracket_send_start = datetime.now(timezone.utc)
    r = requests.post(
        f"{BASE}/messages",
        headers=H(admin_tok),
        json={
            "conversation_id": conv_id,
            "content": "Disappearing test message — per-user timer",
            "kind": "text",
        },
    )
    _ok("POST /messages (admin) → 200", r.status_code == 200, f"status={r.status_code}")
    sent = r.json()
    msg_id = sent.get("id")
    print(f"  sent msg id={msg_id}")
    _ok("send-time: disappear_seconds == 30", sent.get("disappear_seconds") == 30, f"got={sent.get('disappear_seconds')}")
    _ok(
        "send-time: NO expires_at in response (per-user starts on read)",
        "expires_at" not in sent or sent.get("expires_at") in (None, ""),
        f"got expires_at={sent.get('expires_at')}",
    )
    rb = sent.get("read_by") or []
    _ok(
        "send-time: read_by contains sender only (admin)",
        admin_user["id"] in rb and demo_user["id"] not in rb,
        f"read_by={rb}",
    )
    # read_at map (per-user) should not be populated for admin (sender) and
    # also should not be set for demo yet (demo hasn't read).
    read_at_map = sent.get("read_at") or {}
    _ok(
        "send-time: read_at map empty/absent for admin (sender)",
        admin_user["id"] not in read_at_map,
        f"read_at={read_at_map}",
    )

    # -------- STEP 3: RECIPIENT (demo) FIRST READ
    bracket_read_start = datetime.now(timezone.utc)
    r = requests.get(f"{BASE}/conversations/{conv_id}/messages", headers=H(demo_tok))
    bracket_read_end = datetime.now(timezone.utc)
    _ok("GET /conversations/{id}/messages (demo) → 200", r.status_code == 200, f"status={r.status_code}")
    msgs_demo = r.json() if r.status_code == 200 else []
    m_demo = find_msg(msgs_demo, msg_id)
    _ok("demo sees the disappearing message", m_demo is not None)
    if m_demo:
        exp = m_demo.get("expires_at")
        exp_dt = parse_iso(exp)
        _ok("demo's response includes expires_at (per-user)", exp_dt is not None, f"expires_at={exp}")
        if exp_dt is not None:
            # Expected window: read_start+30 .. read_end+30 + small slack
            low = bracket_read_start + timedelta(seconds=30) - timedelta(seconds=2)
            high = bracket_read_end + timedelta(seconds=30) + timedelta(seconds=5)
            _ok(
                "demo's expires_at ≈ first_read_time + 30s",
                low <= exp_dt <= high,
                f"expires_at={exp_dt.isoformat()} window=[{low.isoformat()},{high.isoformat()}]",
            )
        _ok("demo: message still has disappear_seconds=30", m_demo.get("disappear_seconds") == 30)
        demo_expires_at_first = m_demo.get("expires_at")
    else:
        demo_expires_at_first = None

    # -------- STEP 4: SENDER (admin) RE-FETCHES
    r = requests.get(f"{BASE}/conversations/{conv_id}/messages", headers=H(admin_tok))
    _ok("GET /conversations/{id}/messages (admin) → 200", r.status_code == 200, f"status={r.status_code}")
    msgs_admin = r.json() if r.status_code == 200 else []
    m_admin = find_msg(msgs_admin, msg_id)
    _ok("admin (sender) still sees message", m_admin is not None)
    if m_admin:
        _ok(
            "admin (sender): NO expires_at in response (sender excluded)",
            "expires_at" not in m_admin or m_admin.get("expires_at") in (None, ""),
            f"admin got expires_at={m_admin.get('expires_at')}",
        )
        _ok("admin (sender): disappear_seconds=30 present", m_admin.get("disappear_seconds") == 30)

    # -------- STEP 7 (do this BEFORE the wait): IDEMPOTENCY on recipient
    time.sleep(1.5)
    r = requests.get(f"{BASE}/conversations/{conv_id}/messages", headers=H(demo_tok))
    msgs_demo2 = r.json() if r.status_code == 200 else []
    m_demo2 = find_msg(msgs_demo2, msg_id)
    if m_demo2 and demo_expires_at_first:
        _ok(
            "idempotency: demo re-read returns SAME expires_at (no reset)",
            m_demo2.get("expires_at") == demo_expires_at_first,
            f"first={demo_expires_at_first} second={m_demo2.get('expires_at')}",
        )
    else:
        _ok("idempotency: demo re-read still shows message", m_demo2 is not None)

    # -------- STEP 5: WAIT ~35s then check expiry
    wait_secs = 35
    print(f"  sleeping {wait_secs}s to let demo's timer expire...")
    time.sleep(wait_secs)

    r = requests.get(f"{BASE}/conversations/{conv_id}/messages", headers=H(demo_tok))
    _ok("after wait: GET messages (demo) → 200", r.status_code == 200, f"status={r.status_code}")
    msgs_demo3 = r.json() if r.status_code == 200 else []
    m_demo3 = find_msg(msgs_demo3, msg_id)
    _ok(
        "after wait: demo NO LONGER sees the expired message",
        m_demo3 is None,
        f"still visible: {m_demo3}",
    )

    # Admin GET should not crash. Message may or may not be gone (lazy cleanup
    # happens on demo's GET above — for direct convs with only 2 members,
    # demo (only non-sender) expired → message should have been fully deleted).
    r = requests.get(f"{BASE}/conversations/{conv_id}/messages", headers=H(admin_tok))
    _ok("after wait: GET messages (admin) → 200 (not blocking)", r.status_code == 200, f"status={r.status_code}")
    msgs_admin_after = r.json() if r.status_code == 200 else []
    m_admin_after = find_msg(msgs_admin_after, msg_id)
    print(f"  admin sees message after expiry? {m_admin_after is not None} (either OK)")

    # -------- STEP 8: REGRESSION — disappearing OFF
    r = set_disappearing(admin_tok, conv_id, 0)
    _ok("regression: disable disappearing seconds=0 → 200", r.status_code == 200, f"status={r.status_code}")
    # Send a non-disappearing message
    r = requests.post(
        f"{BASE}/messages",
        headers=H(admin_tok),
        json={"conversation_id": conv_id, "content": "non-disappearing regression", "kind": "text"},
    )
    _ok("regression: POST /messages (no disappear) → 200", r.status_code == 200)
    plain = r.json()
    plain_id = plain.get("id")
    _ok(
        "regression: no disappear_seconds on plain message",
        "disappear_seconds" not in plain or plain.get("disappear_seconds") in (None, 0),
        f"got={plain.get('disappear_seconds')}",
    )
    _ok(
        "regression: no expires_at on plain message",
        "expires_at" not in plain or plain.get("expires_at") in (None, ""),
        f"got={plain.get('expires_at')}",
    )
    # demo opens chat — plain msg must NOT get expires_at stamped
    r = requests.get(f"{BASE}/conversations/{conv_id}/messages", headers=H(demo_tok))
    msgs_plain = r.json() if r.status_code == 200 else []
    m_plain_demo = find_msg(msgs_plain, plain_id)
    _ok("regression: demo sees the plain message", m_plain_demo is not None)
    if m_plain_demo:
        _ok(
            "regression: plain message has no expires_at even after demo's GET",
            "expires_at" not in m_plain_demo or m_plain_demo.get("expires_at") in (None, ""),
            f"got={m_plain_demo.get('expires_at')}",
        )

    # DELETE /messages/{id} works (admin deletes own)
    r = requests.delete(f"{BASE}/messages/{plain_id}", headers=H(admin_tok))
    _ok("regression: DELETE /messages/{own} → 200", r.status_code == 200, f"status={r.status_code}")

    # DELETE /messages/{other's} → 403
    # Send one as demo, admin tries to delete
    r = requests.post(
        f"{BASE}/messages",
        headers=H(demo_tok),
        json={"conversation_id": conv_id, "content": "demo msg", "kind": "text"},
    )
    if r.status_code == 200:
        demo_msg_id = r.json()["id"]
        r = requests.delete(f"{BASE}/messages/{demo_msg_id}", headers=H(admin_tok))
        _ok("regression: DELETE /messages/{other's} → 403", r.status_code == 403, f"status={r.status_code}")

    # -------- STEP 6: GROUP CHAT per-user independence
    # Create a group with admin+demo (no 3rd user). disappear 60s.
    print("  creating group chat for per-user independence...")
    r = requests.post(
        f"{BASE}/conversations",
        headers=H(admin_tok),
        json={
            "type": "group",
            "name": "Disappear Test Group",
            "member_ids": [demo_user["id"]],
        },
    )
    _ok("group: POST /conversations group → 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    group = r.json() if r.status_code == 200 else None
    if group:
        gid = group["id"]
        r = set_disappearing(admin_tok, gid, 60)
        _ok("group: enable disappearing 60s → 200", r.status_code == 200)

        # Admin sends a message
        bracket_g_send = datetime.now(timezone.utc)
        r = requests.post(
            f"{BASE}/messages",
            headers=H(admin_tok),
            json={"conversation_id": gid, "content": "group disappearing", "kind": "text"},
        )
        _ok("group: admin POST /messages → 200", r.status_code == 200)
        if r.status_code == 200:
            gmsg = r.json()
            gmsg_id = gmsg["id"]
            _ok("group send: disappear_seconds=60 on response", gmsg.get("disappear_seconds") == 60)
            _ok(
                "group send: NO expires_at at send-time",
                "expires_at" not in gmsg or gmsg.get("expires_at") in (None, ""),
                f"got={gmsg.get('expires_at')}",
            )

            # Demo opens
            bracket_g_read = datetime.now(timezone.utc)
            r = requests.get(f"{BASE}/conversations/{gid}/messages", headers=H(demo_tok))
            _ok("group: demo GET messages → 200", r.status_code == 200)
            g_msgs_demo = r.json() if r.status_code == 200 else []
            g_m_demo = find_msg(g_msgs_demo, gmsg_id)
            if g_m_demo:
                exp_dt = parse_iso(g_m_demo.get("expires_at"))
                _ok("group: demo sees expires_at", exp_dt is not None, f"got={g_m_demo.get('expires_at')}")
                if exp_dt:
                    low = bracket_g_read + timedelta(seconds=60) - timedelta(seconds=2)
                    high = bracket_g_read + timedelta(seconds=60) + timedelta(seconds=8)
                    _ok(
                        "group: demo expires_at ≈ now+60s",
                        low <= exp_dt <= high,
                        f"expires_at={exp_dt.isoformat()}",
                    )

            # Admin (sender) opens — no expires_at
            r = requests.get(f"{BASE}/conversations/{gid}/messages", headers=H(admin_tok))
            g_msgs_admin = r.json() if r.status_code == 200 else []
            g_m_admin = find_msg(g_msgs_admin, gmsg_id)
            _ok("group: admin (sender) sees message", g_m_admin is not None)
            if g_m_admin:
                _ok(
                    "group: admin (sender) has NO expires_at",
                    "expires_at" not in g_m_admin or g_m_admin.get("expires_at") in (None, ""),
                    f"got={g_m_admin.get('expires_at')}",
                )

            # DELETE /conversations/{id} regression — admin leaves group
            r = requests.delete(f"{BASE}/conversations/{gid}", headers=H(admin_tok))
            _ok("group: DELETE /conversations/{id} (admin leaves) → 200", r.status_code == 200, f"status={r.status_code}")

    # -------- Summary
    print("\n========== RESULTS ==========")
    print(f"PASS: {len(PASS)}")
    print(f"FAIL: {len(FAIL)}")
    for n, info in FAIL:
        print(f"  - {n}: {info}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
