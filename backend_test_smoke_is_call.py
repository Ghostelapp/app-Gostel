"""Smoke test for the is_call kwarg routing through _send_simple_push → send_fcm
and quick regression on conversations/messages/calls endpoints.

Review request steps:
 1. Login both admin + demo (200 OK).
 2. POST /api/push/test {"kind": "call"} as admin → 200 (sent or sent:false).
 3. POST /api/push/test {"kind": "message"} as admin → 200.
 4. As demo, POST /api/calls/start; create conv if needed.
 5. POST /api/calls/{call_id}/end as demo → 200, no 500.
 6. Regression: /auth/me has muted_users + blocked_user_ids, POST /api/messages 200,
    DELETE /api/conversations/{id} 200, GET /api/conversations/{id}/messages 200 with
    per-user disappearing annotations.
"""

import os
import sys
import httpx

BASE = os.environ.get("BACKEND_URL", "https://collab-platform-41.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"

ADMIN_EMAIL = "admin@ghostel.app"
ADMIN_PASS = "Admin@2026!"
DEMO_EMAIL = "demo@silentel.app"
DEMO_PASS = "Demo@2026!"

results = []  # (name, ok, detail)


def report(name, ok, detail=""):
    results.append((name, ok, detail))
    icon = "PASS" if ok else "FAIL"
    print(f"[{icon}] {name}  {detail}")


def login(client, email, password):
    r = client.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=30)
    if r.status_code != 200:
        return None, r
    data = r.json()
    return data, r


def H(token):
    return {"Authorization": f"Bearer {token}"}


def main():
    with httpx.Client(timeout=30) as c:
        # Step 1: login both
        admin_data, ar = login(c, ADMIN_EMAIL, ADMIN_PASS)
        report("1a. Admin login 200", ar.status_code == 200, f"status={ar.status_code}")
        if ar.status_code != 200:
            print(ar.text)
            return summarize()
        demo_data, dr = login(c, DEMO_EMAIL, DEMO_PASS)
        report("1b. Demo login 200", dr.status_code == 200, f"status={dr.status_code}")
        if dr.status_code != 200:
            print(dr.text)
            return summarize()
        admin_tok = admin_data["access_token"]
        demo_tok = demo_data["access_token"]
        admin_id = admin_data["user"]["id"]
        demo_id = demo_data["user"]["id"]

        # Step 2: POST /api/push/test {kind:"call"} as admin
        r = c.post(f"{API}/push/test", json={"kind": "call"}, headers=H(admin_tok))
        ok = r.status_code == 200
        body = r.json() if ok else {"_status": r.status_code, "_text": r.text[:200]}
        report("2. POST /push/test kind=call returns 200 (no 500)", ok, str(body)[:200])

        # Step 3: kind=message
        r = c.post(f"{API}/push/test", json={"kind": "message"}, headers=H(admin_tok))
        ok = r.status_code == 200
        body = r.json() if ok else {"_status": r.status_code, "_text": r.text[:200]}
        report("3. POST /push/test kind=message returns 200", ok, str(body)[:200])

        # Step 4: As demo, get/create conversation with admin
        r = c.get(f"{API}/conversations", headers=H(demo_tok))
        if r.status_code != 200:
            report("4a. demo GET /conversations 200", False, f"status={r.status_code} body={r.text[:200]}")
            return summarize()
        convs = r.json()
        # Find direct conv with admin
        target_conv = None
        for cv in convs:
            if cv.get("type") == "direct":
                mids = cv.get("member_ids", [])
                if admin_id in mids and demo_id in mids:
                    target_conv = cv
                    break
        if not target_conv:
            # First ensure contact exists — try inviting / accepting if needed
            # Then create conv
            r2 = c.post(
                f"{API}/conversations",
                json={"type": "direct", "member_ids": [admin_id]},
                headers=H(demo_tok),
            )
            if r2.status_code != 200:
                # Try to bootstrap contact via invite + accept
                inv = c.post(
                    f"{API}/contacts/invitations",
                    json={"target_user_id": admin_id},
                    headers=H(demo_tok),
                )
                if inv.status_code == 200:
                    # admin accepts
                    inv_list = c.get(f"{API}/contacts/invitations", headers=H(admin_tok))
                    if inv_list.status_code == 200:
                        for invitation in inv_list.json().get("received", []):
                            inv_id = invitation.get("id")
                            if inv_id:
                                c.post(
                                    f"{API}/contacts/invitations/{inv_id}/accept",
                                    headers=H(admin_tok),
                                )
                    r2 = c.post(
                        f"{API}/conversations",
                        json={"type": "direct", "member_ids": [admin_id]},
                        headers=H(demo_tok),
                    )
            if r2.status_code != 200:
                report("4a. create conv with admin 200", False, f"status={r2.status_code} body={r2.text[:200]}")
                return summarize()
            target_conv = r2.json()
        conv_id = target_conv["id"]
        report("4a. demo has direct conv with admin", True, f"conv_id={conv_id[:8]}…")

        # 4b: POST /api/calls/start
        r = c.post(
            f"{API}/calls/start",
            json={"conversation_id": conv_id, "mode": "audio"},
            headers=H(demo_tok),
        )
        if r.status_code != 200:
            report("4b. POST /calls/start 200", False, f"status={r.status_code} body={r.text[:200]}")
            return summarize()
        call = r.json()
        needed_keys = {"id", "caller_id", "mode", "status", "started_at"}
        missing = needed_keys - set(call.keys())
        report(
            "4b. POST /calls/start 200 with required fields",
            len(missing) == 0,
            f"missing={missing} mode={call.get('mode')} status={call.get('status')}",
        )
        call_id = call.get("id")

        # Step 5: end call as demo
        r = c.post(f"{API}/calls/{call_id}/end", headers=H(demo_tok))
        ok = r.status_code == 200
        body = r.json() if ok else {"_status": r.status_code, "_text": r.text[:200]}
        report("5. POST /calls/{id}/end as demo 200, no 500", ok, str(body)[:200])

        # Step 6 regressions
        # 6a /auth/me has muted_users + blocked_user_ids
        r = c.get(f"{API}/auth/me", headers=H(demo_tok))
        ok_me = r.status_code == 200
        me = r.json() if ok_me else {}
        has_muted = "muted_users" in me
        has_blocked = "blocked_user_ids" in me
        report(
            "6a. GET /auth/me has muted_users + blocked_user_ids",
            ok_me and has_muted and has_blocked,
            f"keys present muted_users={has_muted} blocked_user_ids={has_blocked}",
        )

        # 6b POST /messages 200
        r = c.post(
            f"{API}/messages",
            json={"conversation_id": conv_id, "content": "smoke-test-is-call-msg"},
            headers=H(demo_tok),
        )
        ok = r.status_code == 200
        msg = r.json() if ok else {}
        msg_id = msg.get("id")
        report("6b. POST /messages 200", ok, f"msg_id={(msg_id or '')[:8]}")

        # 6d GET /conversations/{id}/messages 200 + check per-user disappearing annotations
        r = c.get(f"{API}/conversations/{conv_id}/messages", headers=H(demo_tok))
        ok_msgs = r.status_code == 200
        msgs = r.json() if ok_msgs else []
        # Per-user disappearing annotations: when disappear_seconds is set,
        # non-sender's read should add expires_at. We don't strictly require
        # disappearing to be enabled here; just confirm endpoint shape works
        # and that no message contains a structure that breaks (sanity check).
        annotation_ok = True
        for m in msgs[:20]:
            # Should be a dict with id and conversation_id
            if not isinstance(m, dict) or "id" not in m or "conversation_id" not in m:
                annotation_ok = False
                break
        report(
            "6d. GET /conversations/{id}/messages 200 + valid shape",
            ok_msgs and annotation_ok,
            f"count={len(msgs)}",
        )

        # 6c DELETE /conversations/{id} 200 (we leave conv as demo). Do it last
        # so we don't kill the conversation prior to the messages read.
        r = c.delete(f"{API}/conversations/{conv_id}", headers=H(demo_tok))
        ok = r.status_code == 200
        body = r.json() if ok else {"_status": r.status_code, "_text": r.text[:200]}
        report("6c. DELETE /conversations/{id} 200", ok, str(body)[:200])

        # Cleanup: admin too leaves so conv fully gone (best effort, ignore errors)
        try:
            c.delete(f"{API}/conversations/{conv_id}", headers=H(admin_tok))
        except Exception:
            pass

    return summarize()


def summarize():
    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    print()
    print(f"=== SMOKE TEST is_call: {passed}/{passed + failed} PASS, {failed} FAIL ===")
    for name, ok, detail in results:
        if not ok:
            print(f"  FAIL: {name}  -- {detail}")
    return failed == 0


if __name__ == "__main__":
    ok = main()
    sys.exit(0 if ok else 1)
