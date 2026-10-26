"""Session-bound WebSockets. Shared database validation works across workers."""
import asyncio
import json


class WSManager:
    def __init__(self, validate_session, *, max_connections_per_user=16):
        self.sockets = {}
        self._sessions = {}
        self._lock = asyncio.Lock()
        self._validate_session = validate_session
        self._max_connections = max_connections_per_user

    async def is_authorized(self, user_id, session_id):
        if not session_id:
            return False
        try:
            # On database failure, stop delivering private events (fail closed).
            return bool(await asyncio.wait_for(
                self._validate_session(user_id, session_id), timeout=3
            ))
        except Exception:
            return False

    async def connect(self, user_id, ws, session_id):
        if not await self.is_authorized(user_id, session_id):
            await ws.close(code=4401)
            return False
        async with self._lock:
            if len(self.sockets.get(user_id, ())) >= self._max_connections:
                accepted = False
            else:
                self.sockets.setdefault(user_id, set()).add(ws)
                self._sessions[ws] = session_id
                accepted = True
        if not accepted:
            await ws.close(code=4429)
        return accepted

    async def disconnect(self, user_id, ws):
        async with self._lock:
            self._sessions.pop(ws, None)
            if user_id in self.sockets:
                self.sockets[user_id].discard(ws)
                if not self.sockets[user_id]:
                    self.sockets.pop(user_id, None)

    async def close_socket(self, user_id, ws, code=4401):
        await self.disconnect(user_id, ws)
        try:
            await asyncio.wait_for(ws.close(code=code), timeout=3)
        except Exception:
            pass

    async def revoke_session(self, user_id, session_id):
        async with self._lock:
            sockets = [ws for ws in self.sockets.get(user_id, ())
                       if self._sessions.get(ws) == session_id]
        await asyncio.gather(*(self.close_socket(user_id, ws) for ws in sockets))

    async def send_to(self, user_id, payload):
        async with self._lock:
            sockets = [(ws, self._sessions.get(ws)) for ws in self.sockets.get(user_id, ())]
        for ws, session_id in sockets:
            # Never rely solely on an in-process cache: revocation may happen
            # in a different worker, or the session may expire while idle.
            if not await self.is_authorized(user_id, session_id):
                await self.close_socket(user_id, ws)
                continue
            try:
                await asyncio.wait_for(ws.send_text(json.dumps(payload)), timeout=3)
            except Exception:
                await self.close_socket(user_id, ws)
