import json
import asyncio
from typing import Dict, List, Optional
from fastapi import Depends, WebSocket, WebSocketDisconnect, HTTPException

from app.core.config import logger
from app.core.database import db
from app.core.utils import now_utc
from app.core.auth import get_current_user


class WSManager:
    def __init__(self):
        self.sockets: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, user_id: str, ws: WebSocket):
        async with self._lock:
            self.sockets.setdefault(user_id, set()).add(ws)

    async def disconnect(self, user_id: str, ws: WebSocket):
        async with self._lock:
            if user_id in self.sockets:
                self.sockets[user_id].discard(ws)
                if not self.sockets[user_id]:
                    self.sockets.pop(user_id, None)

    async def send_to(self, user_id: str, payload: dict):
        async with self._lock:
            sockets = list(self.sockets.get(user_id, []))
        for ws in sockets:
            try:
                await ws.send_text(json.dumps(payload))
            except Exception:
                pass


async def broadcast_to_members(member_ids, payload, exclude: Optional[str] = None):
    for uid in member_ids:
        if uid == exclude:
            continue
        await ws_manager.send_to(uid, payload)


async def issue_ws_ticket(user: dict = Depends(get_current_user)):
    ticket, jti, expires_at = create_ws_ticket(user["id"], user.get("_auth_sid"))
    await db.ws_tickets.insert_one(
        {"jti": jti, "user_id": user["id"], "expires_at": expires_at}
    )
    return {"ticket": ticket, "expires_in": 60}


async def websocket_endpoint(
    websocket: WebSocket,
    ticket: Optional[str] = None,
    token: Optional[str] = None,
):
    await websocket.accept()
    credential = ticket or (token if ALLOW_LEGACY_WS_TOKEN else None)
    if not credential:
        await websocket.send_text(json.dumps({"type": "error", "data": "missing ticket"}))
        await websocket.close()
        return
    try:
        payload = jwt.decode(credential, JWT_SECRET, algorithms=[JWT_ALG])
        user_id = payload.get("sub")
        credential_type = payload.get("type")
        if not user_id or credential_type not in ("ws", "access"):
            raise ValueError("invalid ticket")
        session_id = payload.get("sid")
        if session_id:
            session = await db.user_sessions.find_one(
                {"id": session_id, "user_id": user_id},
                {"_id": 0, "revoked_at": 1, "expires_at": 1},
            )
            if not session or session.get("revoked_at"):
                raise ValueError("session revoked")
        if credential_type == "ws":
            jti = payload.get("jti")
            if not jti:
                raise ValueError("invalid ticket")
            consumed = await db.ws_tickets.find_one_and_delete(
                {"jti": jti, "user_id": user_id, "expires_at": {"$gt": now_utc()}}
            )
            if not consumed:
                raise ValueError("used or expired ticket")
        elif not token or not ALLOW_LEGACY_WS_TOKEN:
            raise ValueError("legacy token disabled")
        elif payload.get("jti") and await db.revoked_tokens.find_one(
            {"jti": payload["jti"]}, {"_id": 1}
        ):
            raise ValueError("token revoked")
        ws_user = await db.users.find_one({"id": user_id}, {"_id": 0, "id": 1})
        if not ws_user:
            raise ValueError("user not found")
    except Exception:
        await websocket.send_text(json.dumps({"type": "error", "data": "invalid ticket"}))
        await websocket.close()
        return

    await ws_manager.connect(user_id, websocket)
    # Mark user as online (best-effort)
    try:
        await db.users.update_one(
            {"id": user_id},
            {"$set": {"status": "online", "last_active": now_utc().isoformat()}},
        )
    except Exception:
        pass
    await websocket.send_text(json.dumps({"type": "hello", "data": {"user_id": user_id}}))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            mtype = data.get("type")
            # WebRTC signaling: forward to target user
            if mtype in {
                "call:offer",
                "call:answer",
                "call:ice",
                "call:reject",
                "call:end",
                "call:ringing",
                "call:accept",   # callee tapped Accept (UI signal)
                "call:ready",    # callee's PC + media ready, caller can send offer
                "call:cancel",   # caller cancelled before answer
            }:
                target = data.get("to")
                if mtype in {"call:offer", "call:answer", "call:ice"}:
                    signal = data.get("e2ee_signal")
                    if not data.get("encrypted") or not isinstance(signal, dict):
                        await websocket.send_text(
                            json.dumps({"type": "error", "data": "call signal must be end-to-end encrypted"})
                        )
                        continue
                    # Do not forward accidental plaintext SDP/ICE material.
                    data = {
                        k: v
                        for k, v in data.items()
                        if k not in {"sdp", "candidate"}
                    }
                if target:
                    data = normalize_call_signal_envelope(
                        {**data, "type": mtype},
                        call_id=str(data.get("call_id") or data.get("callId") or ""),
                        sender_id=user_id,
                        receiver_id=str(target),
                    )
                if target and await user_can_signal_target(user_id, target, data):
                    await ws_manager.send_to(target, {**data, "from": user_id})
                elif target:
                    await websocket.send_text(
                        json.dumps({"type": "error", "data": "unauthorized signal"})
                    )
            elif mtype == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect(user_id, websocket)
        # If user no longer has any active WS, mark them offline + record last_seen
        try:
            still_online = bool(ws_manager.sockets.get(user_id))
            if not still_online:
                now = now_utc().isoformat()
                await db.users.update_one(
                    {"id": user_id},
                    {"$set": {"status": "offline", "last_seen": now, "last_active": now}},
                )
        except Exception:
            pass
