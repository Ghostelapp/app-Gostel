"""Offline regression tests for the actual API handlers, without starting MongoDB."""
import ast
import asyncio
import logging
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from typing import Optional
from datetime import datetime, timedelta, timezone
import uuid


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code = status_code
        self.detail = detail


class DuplicateKeyError(Exception):
    pass


def handlers():
    tree = ast.parse((Path(__file__).parents[1] / "server.py").read_text())
    names = {
        "accept_call", "_finish_call", "_send_call_control_push", "start_call",
        "update_call_client_state", "public_call_status",
    }
    nodes = []
    for node in tree.body:
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name in names:
            node.decorator_list = []
            node.args.defaults = []
            nodes.append(node)
    calls = SimpleNamespace(find_one=AsyncMock(), update_one=AsyncMock(), delete_one=AsyncMock(), insert_one=AsyncMock())
    db = SimpleNamespace(calls=calls, conversations=SimpleNamespace(find_one=AsyncMock()),
                         call_signals=SimpleNamespace(update_one=AsyncMock(), insert_many=AsyncMock()))
    env = dict(Optional=Optional, db=db, HTTPException=HTTPException, DuplicateKeyError=DuplicateKeyError,
               CallStartIn=object, CallStateUpdateIn=object, enforce_rate_limit=AsyncMock(),
               ensure_direct_conversation_not_blocked=AsyncMock(),
               expire_stale_ringing_calls_for_user=AsyncMock(),
               require_conversation_e2ee_ready=AsyncMock(return_value=[
                   {"id": "caller", "e2ee_public_key": "caller-key"},
                   {"id": "callee", "e2ee_public_key": "callee-key"},
               ]),
               now_utc=lambda: datetime.now(timezone.utc), datetime=datetime, uuid=uuid,
               timedelta=timedelta, CALL_RING_TIMEOUT_SECONDS=45,
               logger=logging.getLogger("test.calls"), broadcast_to_members=AsyncMock(),
               _send_call_control_push=AsyncMock(), asyncio=asyncio,
               CALL_TERMINAL_STATUSES={"ended", "declined", "cancelled", "timeout", "missed", "failed"})
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), env)
    return env


def call(**overrides):
    return {
        **dict(id="call", member_ids=["caller", "callee"], caller_id="caller",
               status="ringing", ended_at=None, answered_at=None),
        **overrides,
    }


class CallTransitions(unittest.IsolatedAsyncioTestCase):
    async def test_public_status_is_scoped_to_the_requesting_participant(self):
        env = handlers()
        call_data = {
            **call(),
            "status": "answered",
            "lastKnownClientState": {
                "caller": {"status": "active"},
                "callee": {"status": "reconnecting"},
            },
        }
        self.assertEqual(env["public_call_status"](call_data, "caller")["status"], "active")
        self.assertEqual(env["public_call_status"](call_data, "callee")["status"], "reconnecting")
        self.assertEqual(env["public_call_status"](call_data, "other")["status"], "answered")

    async def test_group_conversation_cannot_start_voice_call(self):
        env = handlers()
        env["db"].conversations.find_one.return_value = {
            "id": "group", "type": "group", "member_ids": ["caller", "callee", "third"]
        }
        with self.assertRaises(HTTPException) as error:
            await env["start_call"](
                SimpleNamespace(conversation_id="group", mode="audio", call_id=None),
                {"id": "caller"},
            )
        self.assertEqual(error.exception.status_code, 400)
        env["db"].calls.insert_one.assert_not_awaited()

    async def test_concurrent_active_call_insert_returns_conflict(self):
        env = handlers()
        env["db"].conversations.find_one.return_value = {
            "id": "conversation", "type": "direct", "member_ids": ["caller", "callee"]
        }
        env["db"].calls.find_one.side_effect = [None, None]
        env["db"].calls.insert_one.side_effect = DuplicateKeyError("active slot already claimed")
        with self.assertRaises(HTTPException) as error:
            await env["start_call"](
                SimpleNamespace(conversation_id="conversation", mode="audio", call_id=None),
                {"id": "caller"},
            )
        self.assertEqual(error.exception.status_code, 409)
        env["expire_stale_ringing_calls_for_user"].assert_awaited_once_with("caller")

    async def test_media_status_is_stored_per_participant(self):
        env = handlers()
        env["db"].calls.find_one.return_value = {
            **call(), "status": "answered", "answered_at": "2026-01-01T00:00:00+00:00",
            "lastKnownClientState": {},
        }
        result = await env["update_call_client_state"](
            "call",
            SimpleNamespace(
                status="active", peer_connection_state="connected",
                local_audio_enabled=True, remote_audio_connected=True,
            ),
            {"id": "callee"},
        )
        self.assertEqual(result["status"], "answered")
        self.assertEqual(result["client_status"], "active")
        update = env["db"].calls.update_one.await_args.args[1]["$set"]
        self.assertNotIn("status", update)
        self.assertEqual(update["lastKnownClientState.callee"]["status"], "active")

    async def test_media_status_cannot_activate_unanswered_call(self):
        env = handlers()
        env["db"].calls.find_one.return_value = call()
        with self.assertRaises(HTTPException) as error:
            await env["update_call_client_state"](
                "call",
                SimpleNamespace(
                    status="active", peer_connection_state="connected",
                    local_audio_enabled=True, remote_audio_connected=True,
                ),
                {"id": "callee"},
            )
        self.assertEqual(error.exception.status_code, 409)
        env["db"].calls.update_one.assert_not_awaited()

    async def test_missing_call_cannot_be_accepted(self):
        env = handlers()
        env['db'].calls.find_one.return_value = None
        with self.assertRaises(HTTPException) as error:
            await env['accept_call']('missing', {'id': 'callee'})
        self.assertEqual(error.exception.status_code, 404)

    async def test_caller_cannot_answer_own_call(self):
        env = handlers()
        env['db'].calls.find_one.return_value = call()
        with self.assertRaises(HTTPException) as error:
            await env['accept_call']('call', {'id': 'caller'})
        self.assertEqual(error.exception.status_code, 403)

    async def test_expired_invite_cannot_be_accepted(self):
        env = handlers()
        env['db'].calls.find_one.return_value = call(expires_at='2000-01-01T00:00:00+00:00')
        result = await env['accept_call']('call', {'id': 'callee'})
        self.assertFalse(result['accepted'])
        env['db'].calls.update_one.assert_not_awaited()

    async def test_end_winning_accept_race_does_not_broadcast_accept(self):
        env = handlers()
        ended = {**call(), 'status': 'cancelled', 'ended_at': '2026-01-01T00:00:00+00:00'}
        env['db'].calls.find_one.side_effect = [call(), ended]
        env['db'].calls.update_one.return_value = SimpleNamespace(matched_count=0)
        result = await env['accept_call']('call', {'id': 'callee'})
        self.assertFalse(result['accepted'])
        self.assertEqual(result['status'], 'cancelled')
        env['broadcast_to_members'].assert_not_awaited()

    async def test_duplicate_accept_does_not_send_another_push(self):
        env = handlers()
        env['db'].calls.find_one.return_value = {**call(), 'status': 'answered', 'answered_at': '2026-01-01T00:00:00+00:00'}
        result = await env['accept_call']('call', {'id': 'callee'})
        self.assertTrue(result['accepted'])
        env['broadcast_to_members'].assert_not_awaited()

    async def test_decline_losing_accept_race_cannot_end_connected_call(self):
        env = handlers()
        answered = {**call(), 'status': 'answered', 'answered_at': '2026-01-01T00:00:00+00:00'}
        env['db'].calls.find_one.side_effect = [call(), answered]
        env['db'].calls.update_one.return_value = SimpleNamespace(matched_count=0)
        result = await env['_finish_call']('call', {'id': 'callee'}, 'decline')
        self.assertFalse(result['ended'])
        self.assertEqual(result['reason'], 'already_accepted')
        self.assertEqual(env['db'].calls.update_one.await_count, 1)
        env['broadcast_to_members'].assert_not_awaited()

    async def test_second_hangup_is_idempotent(self):
        env = handlers()
        env['db'].calls.find_one.return_value = {**call(), 'status': 'ended', 'ended_at': '2026-01-01T00:00:00+00:00'}
        result = await env['_finish_call']('call', {'id': 'callee'}, 'end')
        self.assertTrue(result['idempotent'])
        env['db'].calls.update_one.assert_not_awaited()

    async def test_ending_call_releases_active_conversation_slot(self):
        env = handlers()
        env['_send_call_control_push'] = AsyncMock()
        env['asyncio'] = SimpleNamespace(create_task=lambda task: task.close())
        env['db'].calls.find_one.return_value = {
            **call(), 'status': 'answered', 'answered_at': '2026-01-01T00:00:00+00:00',
            '_active_conversation_id': 'conversation',
        }
        env['db'].calls.update_one.return_value = SimpleNamespace(matched_count=1)
        await env['_finish_call']('call', {'id': 'callee'}, 'end')
        update = env['db'].calls.update_one.await_args.args[1]
        self.assertEqual(update['$unset'], {'_active_conversation_id': ''})

    async def test_other_device_cannot_accept_an_answered_call(self):
        env = handlers()
        env['db'].calls.find_one.return_value = {**call(), 'status': 'answered',
            'answered_at': '2026-01-01T00:00:00+00:00', 'calleeDeviceId': 'phone-one'}
        result = await env['accept_call']('call', {'id': 'callee', '_auth_sid': 'phone-two'})
        self.assertFalse(result['accepted'])
        self.assertEqual(result['reason'], 'answered_elsewhere')

    async def test_control_push_uses_fcm_for_ios_and_never_voip_tokens(self):
        await self.check_control_targets('ended', {'caller-fcm', 'callee-fcm', 'other-fcm'})

    async def test_accepted_push_only_cleans_other_callee_devices(self):
        await self.check_control_targets('accepted', {'other-fcm'})

    async def check_control_targets(self, action, expected):
        env = handlers()
        users = [
            {'id': 'caller', 'push_tokens': [{'token': 'caller-fcm', 'token_type': 'fcm', 'platform': 'ios'}]},
            {'id': 'callee', 'push_tokens': [
                {'token': 'callee-fcm', 'token_type': 'fcm', 'platform': 'ios', 'session_id': 'phone-one'},
                {'token': 'other-fcm', 'token_type': 'fcm', 'platform': 'ios', 'session_id': 'phone-two'},
                {'token': 'voip-token', 'token_type': 'voip', 'platform': 'ios'},
            ]},
        ]
        env['db'].users = SimpleNamespace(find=lambda *args: SimpleNamespace(to_list=AsyncMock(return_value=users)))
        env['user_push_targets'] = lambda user: user['push_tokens']
        env['compact_push_targets'] = lambda targets: targets
        class Client:
            def __init__(self, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
        env['httpx'] = SimpleNamespace(AsyncClient=Client)
        send = AsyncMock(return_value={'ok': True})
        with patch.dict('sys.modules', {'fcm': SimpleNamespace(is_configured=lambda: True, send_fcm=send)}):
            await env['_send_call_control_push'](call(), action, 'callee', 'phone-one')
        self.assertEqual({item.kwargs['token'] for item in send.await_args_list}, expected)
        self.assertTrue(all(item.kwargs['data_only'] for item in send.await_args_list))


if __name__ == '__main__':
    unittest.main()
