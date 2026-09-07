import json
import asyncio
from typing import Optional

from fastapi import WebSocket


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


ws_manager = WSManager()


async def broadcast_to_members(member_ids, payload, exclude: Optional[str] = None):
    for uid in member_ids:
        if uid == exclude:
            continue
        await ws_manager.send_to(uid, payload)
