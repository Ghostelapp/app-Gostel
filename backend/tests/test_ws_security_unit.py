"""Offline tests; no environment files, network or real database are used."""
import ast
import asyncio
import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from backend.ws_manager import WSManager


def validator(db):
    tree = ast.parse((Path(__file__).parents[1] / 'server.py').read_text())
    node = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                and n.name == 'websocket_session_active')
    env = dict(db=db, datetime=datetime, now_utc=lambda: datetime.now(timezone.utc),
               ensure_utc=lambda dt: dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc))
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'server.py', 'exec'), env)
    return env['websocket_session_active']


def socket():
    return SimpleSocket()


class SimpleSocket:
    def __init__(self):
        self.send_text = AsyncMock()
        self.close = AsyncMock()


class WebsocketSecurity(unittest.IsolatedAsyncioTestCase):
    async def test_revoked_session_cannot_connect(self):
        manager = WSManager(AsyncMock(return_value=False))
        ws = socket()
        self.assertFalse(await manager.connect('u', ws, 'revoked'))
        ws.close.assert_awaited_once_with(code=4401)
        self.assertFalse(manager.sockets)

    async def test_missing_session_is_rejected(self):
        validate = AsyncMock(return_value=True)
        manager = WSManager(validate)
        self.assertFalse(await manager.connect('u', socket(), None))
        validate.assert_not_awaited()

    async def test_local_revocation_only_closes_matching_device(self):
        manager = WSManager(AsyncMock(return_value=True))
        a, b = socket(), socket()
        await manager.connect('u', a, 'a')
        await manager.connect('u', b, 'b')
        await manager.revoke_session('u', 'a')
        a.close.assert_awaited_once()
        b.close.assert_not_awaited()
        await manager.send_to('u', {'type':'event'})
        a.send_text.assert_not_awaited()
        b.send_text.assert_awaited_once()

    async def test_revocation_in_another_worker_stops_outbound_events(self):
        state = {'active': True}
        async def validate(user, sid):
            return state['active']
        worker_a, worker_b = WSManager(validate), WSManager(validate)
        a, b = socket(), socket()
        await worker_a.connect('u', a, 's')
        await worker_b.connect('u', b, 's')
        state['active'] = False
        await worker_a.revoke_session('u', 's')
        await worker_b.send_to('u', {'content':'private'})
        b.send_text.assert_not_awaited()
        b.close.assert_awaited_once_with(code=4401)

    async def test_database_failure_fails_closed(self):
        validate = AsyncMock(return_value=True)
        manager = WSManager(validate)
        ws = socket()
        await manager.connect('u', ws, 's')
        validate.side_effect = RuntimeError('database unavailable')
        await manager.send_to('u', {'content':'private'})
        ws.send_text.assert_not_awaited()
        ws.close.assert_awaited_once()

    async def test_connection_limit_and_disconnect_cleanup(self):
        manager = WSManager(AsyncMock(return_value=True), max_connections_per_user=1)
        a, b = socket(), socket()
        self.assertTrue(await manager.connect('u', a, 's'))
        self.assertFalse(await manager.connect('u', b, 's'))
        b.close.assert_awaited_once_with(code=4429)
        await manager.disconnect('u', a)
        self.assertTrue(await manager.connect('u', b, 's'))

    async def test_database_validator_rejects_missing_expired_revoked_and_deleted_user(self):
        users = SimpleNamespace(find_one=AsyncMock(return_value={'id':'u'}))
        sessions = SimpleNamespace(find_one=AsyncMock())
        check = validator(SimpleNamespace(users=users, user_sessions=sessions))
        future = datetime.now(timezone.utc) + timedelta(hours=1)
        for row in (None, {}, {'expires_at':'invalid'}, {'expires_at':datetime.now(timezone.utc)-timedelta(seconds=1)},
                    {'expires_at':future, 'revoked_at':'now'}):
            sessions.find_one.return_value = row
            self.assertFalse(await check('u','s'))
        sessions.find_one.return_value = {'expires_at':future}
        self.assertTrue(await check('u','s'))
        users.find_one.return_value = None
        self.assertFalse(await check('u','s'))


class FakeDisconnect(Exception):
    pass


class FakeHTTPException(Exception):
    pass


def endpoint(manager, receive, *, rate_error=False, interval=0.005):
    tree = ast.parse((Path(__file__).parents[1] / 'server.py').read_text())
    node = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                and n.name == 'websocket_endpoint')
    node.decorator_list = []
    for arg in node.args.args:
        arg.annotation = None
    ws = socket()
    ws.accept = AsyncMock()
    ws.receive_text = receive
    rate = AsyncMock(side_effect=FakeHTTPException() if rate_error else None)
    users = SimpleNamespace(find_one=AsyncMock(return_value={'id':'u'}),update_one=AsyncMock())
    env = dict(asyncio=asyncio,json=json,ws_manager=manager,ALLOW_LEGACY_WS_TOKEN=False,
               JWT_SECRET='test-only',JWT_ALG='HS256',
               jwt=SimpleNamespace(decode=lambda *a,**kw: {'sub':'u','type':'ws','sid':'s','jti':'ticket'}),
               db=SimpleNamespace(users=users,ws_tickets=SimpleNamespace(find_one_and_delete=AsyncMock(return_value={'jti':'ticket'}))),
               now_utc=lambda: datetime.now(timezone.utc),WS_SESSION_CHECK_SECONDS=interval,
               WS_MAX_MESSAGE_BYTES=64,WebSocketDisconnect=FakeDisconnect,HTTPException=FakeHTTPException,
               enforce_rate_limit=rate,user_can_signal_target=AsyncMock(return_value=True),
               normalize_call_signal_envelope=lambda data,**kw:data)
    exec(compile(ast.Module(body=[node],type_ignores=[]),'server.py','exec'),env)
    return env['websocket_endpoint'],ws,rate


class WebsocketEndpointSecurity(unittest.IsolatedAsyncioTestCase):
    async def test_idle_session_revoked_by_other_worker_is_closed(self):
        state = {'active':True}
        async def validate(*args):
            return state['active']
        async def receive():
            state['active'] = False
            await asyncio.sleep(10)  # cancelled by the handler's short timeout
        manager = WSManager(validate)
        handler,ws,_ = endpoint(manager,receive)
        await handler(ws,ticket='test')
        ws.close.assert_awaited_once_with(code=4401)
        self.assertFalse(manager.sockets)

    async def test_incoming_event_after_revocation_is_not_processed(self):
        state = {'active':True}
        async def validate(*args):
            return state['active']
        async def receive():
            state['active'] = False
            return '{"type":"ping"}'
        handler,ws,rate = endpoint(WSManager(validate),receive)
        await handler(ws,ticket='test')
        rate.assert_not_awaited()
        self.assertEqual(ws.send_text.await_count,1)  # hello only; no pong
        ws.close.assert_awaited_once_with(code=4401)

    async def test_oversized_event_is_closed_before_parsing(self):
        handler,ws,rate = endpoint(WSManager(AsyncMock(return_value=True)),AsyncMock(return_value='x'*65))
        await handler(ws,ticket='test')
        ws.close.assert_awaited_once_with(code=1009)
        rate.assert_not_awaited()

    async def test_event_rate_limit_closes_connection(self):
        handler,ws,_ = endpoint(WSManager(AsyncMock(return_value=True)),AsyncMock(return_value='{}'),rate_error=True)
        await handler(ws,ticket='test')
        ws.close.assert_awaited_once_with(code=4429)

    async def test_non_object_json_does_not_crash_connection(self):
        handler,ws,_ = endpoint(WSManager(AsyncMock(return_value=True)),
            AsyncMock(side_effect=['[]','null','{"type":"ping"}',FakeDisconnect()]))
        await handler(ws,ticket='test')
        self.assertEqual(ws.send_text.call_args_list[-1].args[0],'{"type": "pong"}')
