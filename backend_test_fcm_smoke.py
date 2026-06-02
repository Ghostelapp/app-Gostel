"""Smoke test for FCM payload changes in /app/backend/fcm.py (Phase H).

Steps (per review request):
 1. Login as admin@ghostel.app / Admin@2026!
 2. GET /api/auth/me — confirm well-formed (200, id/email/avatar/...)
 3. POST /api/push/test with body {"kind":"message"} and {"kind":"call"}
    - Either 200 with {sent:true/false}; no 500.
 4. Backend logs free of exceptions (checked separately).
 5. Regressions: POST /api/messages still sends, GET /api/conversations 200.
"""
import os
import sys
import json
import time
import requests

BACKEND_URL = os.environ.get("BACKEND_URL", "https://collab-platform-41.preview.emergentagent.com")
API = f"{BACKEND_URL.rstrip('/')}/api"

ADMIN_EMAIL = "admin@ghostel.app"
ADMIN_PASSWORD = "Admin@2026!"

results = []

def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    line = f"[{status}] {name}"
    if detail:
        line += f" — {detail}"
    print(line)
    results.append((name, ok, detail))


def main():
    # 1) Login
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    if r.status_code != 200:
        record("Step1 admin login", False, f"status={r.status_code} body={r.text[:300]}")
        return
    data = r.json()
    token = data.get("access_token")
    user = data.get("user") or {}
    record("Step1 admin login", bool(token) and bool(user.get("id")), f"user.id={user.get('id')} email={user.get('email')}")
    if not token:
        return
    H = {"Authorization": f"Bearer {token}"}

    # 2) /auth/me
    r = requests.get(f"{API}/auth/me", headers=H, timeout=10)
    ok = r.status_code == 200
    me = r.json() if ok else {}
    required = ["id", "email"]
    missing = [k for k in required if k not in me]
    well_formed = ok and not missing and "avatar" in me
    record(
        "Step2 GET /auth/me well-formed",
        well_formed,
        f"status={r.status_code} keys={sorted(list(me.keys()))[:12]} missing={missing}",
    )

    # 3) /push/test (kind=message and kind=call) — must not 500
    for kind in ("message", "call"):
        r = requests.post(f"{API}/push/test", headers=H, json={"kind": kind}, timeout=20)
        non_500 = r.status_code != 500 and r.status_code < 500
        try:
            body = r.json()
        except Exception:
            body = {"_raw": r.text[:300]}
        has_sent = isinstance(body, dict) and "sent" in body
        ok = r.status_code == 200 and has_sent
        record(
            f"Step3 POST /push/test kind={kind}",
            ok,
            f"status={r.status_code} sent={body.get('sent')} reason={body.get('reason')} error={body.get('error')} fcm_error_code={body.get('fcm_error_code')}",
        )
        if not non_500:
            record(f"Step3 /push/test kind={kind} did not 500", False, "500 occurred")
        else:
            record(f"Step3 /push/test kind={kind} did not 500", True)

    # 5) Regression — GET /conversations
    r = requests.get(f"{API}/conversations", headers=H, timeout=10)
    convs = r.json() if r.status_code == 200 else []
    record(
        "Step5a GET /conversations 200",
        r.status_code == 200 and isinstance(convs, list),
        f"status={r.status_code} count={len(convs) if isinstance(convs, list) else 'n/a'}",
    )

    # Pick an existing direct conversation to send a message
    conv_id = None
    if isinstance(convs, list):
        for c in convs:
            # Prefer a direct (non-system) conversation
            if c.get("type") in (None, "direct") and not c.get("is_system"):
                conv_id = c.get("id")
                break
        if not conv_id and convs:
            conv_id = convs[0].get("id")

    if not conv_id:
        record("Step5b POST /messages regression", False, "no conversation available for admin")
        return

    body_text = f"Phase H smoke test ping {int(time.time())}"
    r = requests.post(
        f"{API}/messages",
        headers=H,
        json={"conversation_id": conv_id, "content": body_text, "type": "text"},
        timeout=15,
    )
    ok = r.status_code in (200, 201)
    try:
        msg = r.json()
    except Exception:
        msg = {}
    record(
        "Step5b POST /messages regression",
        ok and isinstance(msg, dict) and msg.get("id"),
        f"status={r.status_code} msg.id={msg.get('id')} content={msg.get('content')[:40] if msg.get('content') else None}",
    )


if __name__ == "__main__":
    print(f"Backend: {API}\n")
    try:
        main()
    finally:
        passed = sum(1 for _, ok, _ in results if ok)
        total = len(results)
        print(f"\n=== {passed}/{total} PASS ===")
        sys.exit(0 if passed == total else 1)
