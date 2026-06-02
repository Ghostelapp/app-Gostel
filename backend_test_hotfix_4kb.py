"""
CRITICAL HOTFIX SMOKE TEST — FCM 4KB limit fix (caller_avatar removal + defensive cap)

Verifies:
 1) admin login OK
 2) demo login OK
 3) POST /api/push/test {kind:'call'} as admin → 200, NO 500
 4) POST /api/push/test {kind:'message'} as admin → 200, NO 500
 5) POST /api/calls/start as demo (direct conv with admin, mode='audio') → 200, full call object
 6) POST /api/calls/{id}/end as demo → 200 {ended:true}
 7) Backend logs clean (no tracebacks during test window)
 8) Regression: /auth/me, POST /messages, GET /conversations → 200
"""
import os
import sys
import time
import json
import subprocess
from datetime import datetime

import httpx

BASE = "https://collab-platform-41.preview.emergentagent.com/api"

ADMIN_EMAIL = "admin@ghostel.app"
ADMIN_PASSWORD = "Admin@2026!"
DEMO_EMAIL = "demo@silentel.app"
DEMO_PASSWORD = "Demo@2026!"

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, info: str = "") -> None:
    results.append((name, ok, info))
    flag = "PASS" if ok else "FAIL"
    print(f"[{flag}] {name} :: {info}")


def login(client: httpx.Client, email: str, password: str) -> dict:
    r = client.post(f"{BASE}/auth/login", json={"email": email, "password": password})
    r.raise_for_status()
    return r.json()


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def main() -> int:
    test_start = datetime.utcnow().isoformat()
    print(f"\n=== Hotfix smoke test start @ {test_start} UTC ===")
    print(f"Backend: {BASE}\n")

    with httpx.Client(timeout=30) as client:
        # ── 1) Admin login ─────────────────────────────────────
        try:
            a = login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
            admin_token = a["access_token"]
            admin_id = a["user"]["id"]
            record("1. admin login", True, f"id={admin_id[:8]} token_len={len(admin_token)}")
        except Exception as e:
            record("1. admin login", False, str(e))
            return 1

        # ── 2) Demo login ──────────────────────────────────────
        try:
            d = login(client, DEMO_EMAIL, DEMO_PASSWORD)
            demo_token = d["access_token"]
            demo_id = d["user"]["id"]
            record("2. demo login", True, f"id={demo_id[:8]} token_len={len(demo_token)}")
        except Exception as e:
            record("2. demo login", False, str(e))
            return 1

        # ── 3) POST /api/push/test {kind:'call'} as admin ──────
        try:
            r = client.post(
                f"{BASE}/push/test",
                json={"kind": "call"},
                headers=auth_headers(admin_token),
            )
            ok = r.status_code == 200
            body = r.json() if ok else {"raw": r.text[:200]}
            record(
                "3. POST /push/test kind=call (admin) → 200 no 500",
                ok,
                f"status={r.status_code} body={body}",
            )
        except Exception as e:
            record("3. POST /push/test kind=call", False, str(e))

        # ── 4) POST /api/push/test {kind:'message'} as admin ───
        try:
            r = client.post(
                f"{BASE}/push/test",
                json={"kind": "message"},
                headers=auth_headers(admin_token),
            )
            ok = r.status_code == 200
            body = r.json() if ok else {"raw": r.text[:200]}
            record(
                "4. POST /push/test kind=message (admin) → 200 no 500",
                ok,
                f"status={r.status_code} body={body}",
            )
        except Exception as e:
            record("4. POST /push/test kind=message", False, str(e))

        # ── Find admin↔demo direct conv (bootstrap if needed) ──
        r = client.get(f"{BASE}/conversations", headers=auth_headers(demo_token))
        r.raise_for_status()
        convs = r.json()
        direct_conv = None
        for c in convs:
            if not c.get("is_group") and set(c.get("member_ids", [])) == {admin_id, demo_id}:
                direct_conv = c
                break
        if not direct_conv:
            # ensure contacts then try to create
            client.post(
                f"{BASE}/contacts/invite",
                json={"username": "admin"},
                headers=auth_headers(demo_token),
            )
            # admin accept
            ri = client.get(f"{BASE}/contacts/invitations", headers=auth_headers(admin_token))
            for inv in ri.json().get("received", []):
                if inv.get("from_user_id") == demo_id:
                    client.post(
                        f"{BASE}/contacts/invitations/{inv['id']}/accept",
                        headers=auth_headers(admin_token),
                    )
                    break
            r = client.post(
                f"{BASE}/conversations",
                json={"type": "direct", "member_ids": [admin_id]},
                headers=auth_headers(demo_token),
            )
            print(f"[debug] POST /conversations → {r.status_code} {r.text[:300]}")
            direct_conv = r.json()
            if "id" not in direct_conv:
                # re-fetch list
                r2 = client.get(f"{BASE}/conversations", headers=auth_headers(demo_token))
                for c in r2.json():
                    if not c.get("is_group") and set(c.get("member_ids", [])) == {admin_id, demo_id}:
                        direct_conv = c
                        break
        conv_id = direct_conv["id"]
        print(f"\n[info] direct conv id={conv_id}")

        # ── 5) POST /api/calls/start as demo (mode='audio') ───
        call_id = None
        try:
            r = client.post(
                f"{BASE}/calls/start",
                json={"conversation_id": conv_id, "mode": "audio"},
                headers=auth_headers(demo_token),
            )
            ok = r.status_code == 200
            body = r.json() if ok else {"raw": r.text[:300]}
            if ok:
                required = {"id", "caller_id", "mode", "status", "started_at", "member_ids"}
                missing = required - set(body.keys())
                ok = ok and not missing
                if ok:
                    call_id = body["id"]
                    record(
                        "5. POST /calls/start (demo, audio) → 200 with full call object",
                        True,
                        f"id={call_id[:8]} caller_id={body['caller_id'][:8]} mode={body['mode']} status={body['status']}",
                    )
                else:
                    record(
                        "5. POST /calls/start missing fields",
                        False,
                        f"missing={missing} body_keys={list(body.keys())}",
                    )
            else:
                record(
                    "5. POST /calls/start",
                    False,
                    f"status={r.status_code} body={body}",
                )
        except Exception as e:
            record("5. POST /calls/start", False, str(e))

        # ── 6) POST /api/calls/{id}/end as demo ───────────────
        if call_id:
            try:
                r = client.post(
                    f"{BASE}/calls/{call_id}/end",
                    headers=auth_headers(demo_token),
                )
                ok = r.status_code == 200
                body = r.json() if ok else {"raw": r.text[:200]}
                ok = ok and body.get("ended") is True
                record(
                    "6. POST /calls/{id}/end (demo) → 200 {ended:true}",
                    ok,
                    f"status={r.status_code} body={body}",
                )
            except Exception as e:
                record("6. POST /calls/{id}/end", False, str(e))
        else:
            record("6. POST /calls/{id}/end", False, "skipped — no call_id")

        # ── 8) Regression: GET /auth/me ────────────────────────
        try:
            r = client.get(f"{BASE}/auth/me", headers=auth_headers(admin_token))
            ok = r.status_code == 200
            body = r.json() if ok else {}
            required = {"id", "email", "muted_users", "blocked_user_ids"}
            missing = required - set(body.keys()) if ok else required
            ok = ok and not missing
            record(
                "8a. GET /auth/me (admin) → 200 with schema",
                ok,
                f"status={r.status_code} keys_missing={missing}",
            )
        except Exception as e:
            record("8a. GET /auth/me", False, str(e))

        # ── 8b) Regression: POST /messages ─────────────────────
        try:
            r = client.post(
                f"{BASE}/messages",
                json={"conversation_id": conv_id, "content": "hotfix smoke test message"},
                headers=auth_headers(demo_token),
            )
            ok = r.status_code == 200
            body = r.json() if ok else {}
            msg_id = body.get("id") if ok else None
            ok = ok and bool(msg_id)
            record(
                "8b. POST /messages (demo) → 200 with id",
                ok,
                f"status={r.status_code} msg_id={msg_id[:8] if msg_id else None}",
            )
        except Exception as e:
            record("8b. POST /messages", False, str(e))

        # ── 8c) Regression: GET /conversations ─────────────────
        try:
            r = client.get(f"{BASE}/conversations", headers=auth_headers(demo_token))
            ok = r.status_code == 200
            count = len(r.json()) if ok else 0
            record(
                "8c. GET /conversations (demo) → 200",
                ok,
                f"status={r.status_code} count={count}",
            )
        except Exception as e:
            record("8c. GET /conversations", False, str(e))

    # ── 7) Backend logs clean ──────────────────────────────────
    try:
        out = subprocess.run(
            ["tail", "-n", "200", "/var/log/supervisor/backend.err.log"],
            capture_output=True,
            text=True,
            check=False,
        )
        log = out.stdout
        bad_markers = []
        for line in log.splitlines():
            low = line.lower()
            if "traceback" in low:
                bad_markers.append(line)
            elif "INVALID_ARGUMENT" in line and "too big" in line:
                bad_markers.append(line)
            elif " 500 " in line and "/api/" in line:
                bad_markers.append(line)
        ok = len(bad_markers) == 0
        record(
            "7. Backend logs clean (no tracebacks / no FCM-too-big / no 500)",
            ok,
            f"bad_lines={len(bad_markers)}" + (f" ex={bad_markers[0][:140]}" if bad_markers else ""),
        )
    except Exception as e:
        record("7. Backend log scan", False, str(e))

    # ── Summary ───────────────────────────────────────────────
    print("\n=== SUMMARY ===")
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"Passed: {passed}/{total}")
    for name, ok, info in results:
        flag = "PASS" if ok else "FAIL"
        print(f"  [{flag}] {name}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
