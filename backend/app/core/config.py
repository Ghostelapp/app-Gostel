import os
import logging
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent.parent

JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALG = "HS256"
APP_NAME = os.environ.get("APP_NAME", "ghostel.app")
ALLOW_LEGACY_WS_TOKEN = os.environ.get("ALLOW_LEGACY_WS_TOKEN", "false").lower() == "true"
REMOVED_ASSISTANT_USER_ID = "ghost-ai-bot"
MAX_ENCRYPTED_ATTACHMENT_SIZE = int(
    os.environ.get("MAX_ENCRYPTED_ATTACHMENT_SIZE", str(10 * 1024 * 1024))
)
VOICE_MESSAGE_MAX_DURATION_MS = int(os.environ.get("VOICE_MESSAGE_MAX_DURATION_MS", "60000"))
SUPPORTED_VOICE_ATTACHMENT_MIME_TYPES = {
    "audio/aac",
    "audio/m4a",
    "audio/mp4",
    "audio/ogg",
    "audio/opus",
    "audio/webm",
    "audio/x-m4a",
}
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"  # legacy, retained for /push/test

CALL_RING_TIMEOUT_SECONDS = 45
CALL_TERMINAL_STATUSES = {
    "declined",
    "cancelled",
    "ended",
    "missed",
    "timeout",
    "failed",
    "rejected",
}
CALL_ACTIVE_STATUSES = {
    "ringing",
    "accepted",
    "answered",
    "connecting",
    "active",
    "reconnecting",
}
CALL_SIGNAL_EVENT_NAMES = {
    "call:offer": "call.offer",
    "call:answer": "call.answer",
    "call:ice": "call.ice_candidate",
    "call:ready": "call.ready",
    "call:accept": "call.accepted",
    "call:reject": "call.declined",
    "call:end": "call.ended",
    "call:cancel": "call.cancelled",
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ghostel")
