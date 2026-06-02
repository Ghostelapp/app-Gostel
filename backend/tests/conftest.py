import os
import pytest
import requests
from pathlib import Path
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[2]

# Load local env files when tests are run from a developer machine.
# Environment variables already set by CI/shell still win.
load_dotenv(ROOT_DIR / "frontend" / ".env")
load_dotenv(ROOT_DIR / "backend" / ".env")

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("BACKEND_URL")
    or "http://127.0.0.1:8000"
).rstrip("/")
if BASE_URL.endswith("/api"):
    BASE_URL = BASE_URL[:-4].rstrip("/")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@ghostel.app")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "Admin@2026!")
DEMO_EMAIL = os.environ.get("DEMO_EMAIL", "demo@silentel.app")
DEMO_PASSWORD = os.environ.get("DEMO_PASSWORD", "Demo@2026!")


@pytest.fixture(scope="session")
def base_url():
    assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL not set"
    return BASE_URL


@pytest.fixture
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=20,
    )
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def demo_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD},
        timeout=20,
    )
    assert r.status_code == 200, f"Demo login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def ensure_contact(source_token: str, source_user: dict, target_token: str, target_user: dict):
    contacts = requests.get(
        f"{BASE_URL}/api/contacts",
        headers=auth_headers(source_token),
        timeout=20,
    )
    assert contacts.status_code == 200, contacts.text
    if any(c["id"] == target_user["id"] for c in contacts.json()):
        return

    invite = requests.post(
        f"{BASE_URL}/api/contacts/invite",
        json={"username": target_user["username"]},
        headers=auth_headers(source_token),
        timeout=20,
    )
    assert invite.status_code in (200, 201, 409), invite.text

    target_invitations = requests.get(
        f"{BASE_URL}/api/contacts/invitations",
        headers=auth_headers(target_token),
        timeout=20,
    )
    assert target_invitations.status_code == 200, target_invitations.text
    incoming = target_invitations.json().get("incoming") or []
    pending = next(
        (i for i in incoming if (i.get("from_user") or {}).get("id") == source_user["id"]),
        None,
    )
    if pending:
        accepted = requests.post(
            f"{BASE_URL}/api/contacts/invitations/{pending['id']}/accept",
            headers=auth_headers(target_token),
            timeout=20,
        )
        assert accepted.status_code == 200, accepted.text
        return

    # If the target had already invited the source, accepting the opposite
    # pending request still establishes the same contact relation.
    source_invitations = requests.get(
        f"{BASE_URL}/api/contacts/invitations",
        headers=auth_headers(source_token),
        timeout=20,
    )
    assert source_invitations.status_code == 200, source_invitations.text
    incoming = source_invitations.json().get("incoming") or []
    pending = next(
        (i for i in incoming if (i.get("from_user") or {}).get("id") == target_user["id"]),
        None,
    )
    if pending:
        accepted = requests.post(
            f"{BASE_URL}/api/contacts/invitations/{pending['id']}/accept",
            headers=auth_headers(source_token),
            timeout=20,
        )
        assert accepted.status_code == 200, accepted.text
        return

    contacts = requests.get(
        f"{BASE_URL}/api/contacts",
        headers=auth_headers(source_token),
        timeout=20,
    )
    assert any(c["id"] == target_user["id"] for c in contacts.json())
