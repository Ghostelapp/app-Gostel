"""Password reset primitives and delivery.

Security-sensitive parts are kept free of database dependencies so they can be
unit tested without starting the API or exposing live secrets.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import os
import secrets
import smtplib
import ssl
from email.message import EmailMessage
from urllib.parse import quote

RESET_TTL_MINUTES = max(5, min(int(os.environ.get("PASSWORD_RESET_TTL_MINUTES", "15")), 60))
RESET_MAX_ATTEMPTS = max(3, min(int(os.environ.get("PASSWORD_RESET_MAX_ATTEMPTS", "5")), 10))


def _secret_digest(secret: str, pepper: str, purpose: str) -> str:
    message = f"{purpose}:{secret}".encode("utf-8")
    return hmac.new(pepper.encode("utf-8"), message, hashlib.sha256).hexdigest()


def secret_matches(secret: str, expected_digest: str, pepper: str, purpose: str) -> bool:
    if not secret or not expected_digest:
        return False
    actual = _secret_digest(secret, pepper, purpose)
    return hmac.compare_digest(actual, expected_digest)


def new_reset_secrets(pepper: str) -> dict[str, str]:
    token = secrets.token_urlsafe(32)
    code = f"{secrets.randbelow(1_000_000):06d}"
    return {
        "token": token,
        "code": code,
        "token_hash": _secret_digest(token, pepper, "password-reset-token"),
        "code_hash": _secret_digest(code, pepper, "password-reset-code"),
    }


def password_reset_url(base_url: str, email: str, token: str) -> str:
    base = base_url.rstrip("/")
    return f"{base}?email={quote(email, safe='')}&token={quote(token, safe='')}"


def smtp_configured() -> bool:
    return bool(os.environ.get("SMTP_HOST") and os.environ.get("SMTP_FROM_EMAIL"))


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    return default if raw is None else raw.strip().lower() in {"1", "true", "yes", "on"}


def _send_email_sync(to_email: str, subject: str, text_body: str, html_body: str) -> None:
    host = os.environ["SMTP_HOST"].strip()
    port = int(os.environ.get("SMTP_PORT", "465"))
    username = os.environ.get("SMTP_USERNAME", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "")
    from_email = os.environ["SMTP_FROM_EMAIL"].strip()
    from_name = os.environ.get("SMTP_FROM_NAME", "ghostel.app").strip()
    use_ssl = _bool_env("SMTP_USE_SSL", port == 465)
    use_starttls = _bool_env("SMTP_USE_STARTTLS", not use_ssl)

    message = EmailMessage()
    message["From"] = f"{from_name} <{from_email}>"
    message["To"] = to_email
    message["Subject"] = subject
    message["Auto-Submitted"] = "auto-generated"
    message.set_content(text_body)
    message.add_alternative(html_body, subtype="html")

    context = ssl.create_default_context()
    smtp_class = smtplib.SMTP_SSL if use_ssl else smtplib.SMTP
    with smtp_class(host, port, timeout=15, context=context) if use_ssl else smtp_class(host, port, timeout=15) as smtp:
        if not use_ssl:
            smtp.ehlo()
            if use_starttls:
                smtp.starttls(context=context)
                smtp.ehlo()
        if username:
            smtp.login(username, password)
        smtp.send_message(message)


async def send_password_reset_email(to_email: str, code: str, reset_url: str) -> None:
    safe_url = html.escape(reset_url, quote=True)
    safe_code = html.escape(code)
    text = (
        "Otrzymalismy prosbe o zmiane hasla do konta ghostel.app.\n\n"
        f"Kod: {code}\n"
        f"Link: {reset_url}\n\n"
        f"Kod i link wygasna za {RESET_TTL_MINUTES} minut. "
        "Jesli to nie Ty, zignoruj ta wiadomosc."
    )
    html_body = f"""<!doctype html>
<html lang="pl"><body style="font-family:Arial,sans-serif;background:#0a0e14;color:#f4f4f5;padding:24px">
<div style="max-width:560px;margin:auto;background:#141a24;border:1px solid #283243;border-radius:16px;padding:28px">
<h1 style="font-size:22px;margin-top:0">Zmiana hasla ghostel.app</h1>
<p>Otrzymalismy prosbe o zmiane hasla do Twojego konta.</p>
<p style="font-size:30px;letter-spacing:8px;font-weight:bold;color:#22d3ee">{safe_code}</p>
<p><a href="{safe_url}" style="display:inline-block;background:#22d3ee;color:#071018;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:bold">Ustaw nowe haslo</a></p>
<p style="color:#a1a1aa;font-size:13px">Kod i link wygasna za {RESET_TTL_MINUTES} minut. Jesli to nie Ty, zignoruj te wiadomosc.</p>
</div></body></html>"""
    await asyncio.to_thread(
        _send_email_sync,
        to_email,
        "Zmiana hasla ghostel.app",
        text,
        html_body,
    )
