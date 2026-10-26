"""Offline behavioral regression tests; never connect to production/MongoDB."""
import ast
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code = status_code


def handlers():
    tree = ast.parse((Path(__file__).parents[1] / 'server.py').read_text())
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.AsyncFunctionDef) and node.name in {
            'two_factor_setup', 'two_factor_enable', 'two_factor_disable'
        }:
            node.decorator_list = []
            node.args.defaults = []
            nodes.append(node)
    update = AsyncMock(return_value=SimpleNamespace(matched_count=1))
    env = dict(db=SimpleNamespace(users=SimpleNamespace(update_one=update)),
               HTTPException=HTTPException, enforce_rate_limit=AsyncMock(),
               TwoFASetupIn=object, TwoFAVerifyIn=object, APP_NAME='test',
               verify_password=lambda pw, hashed: pw == 'correct',
               pyotp=SimpleNamespace(random_base32=lambda: 'new-secret',
                   TOTP=lambda secret: SimpleNamespace(
                       verify=lambda code, **kw: code == '123456',
                       provisioning_uri=lambda **kw: 'otpauth://test')))
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'server.py', 'exec'), env)
    return env


class SecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_setup_cannot_disable_enabled_mfa(self):
        e = handlers()
        with self.assertRaises(HTTPException) as err:
            await e['two_factor_setup'](SimpleNamespace(password='correct'),
                dict(id='u', email='u@example.test', two_factor_enabled=True))
        self.assertEqual(err.exception.status_code, 409)
        e['db'].users.update_one.assert_not_awaited()

    async def test_setup_requires_password(self):
        e = handlers()
        with self.assertRaises(HTTPException) as err:
            await e['two_factor_setup'](SimpleNamespace(password='wrong'), dict(id='u'))
        self.assertEqual(err.exception.status_code, 401)
        e['db'].users.update_one.assert_not_awaited()

    async def test_setup_does_not_overwrite_concurrent_enable(self):
        e = handlers()
        e['db'].users.update_one.return_value.matched_count = 0
        with self.assertRaises(HTTPException) as err:
            await e['two_factor_setup'](SimpleNamespace(password='correct'),
                dict(id='u', email='u@example.test'))
        self.assertEqual(err.exception.status_code, 409)
        self.assertEqual(e['db'].users.update_one.call_args.args[0],
                         {'id': 'u', 'two_factor_enabled': {'$ne': True}})

    async def test_totp_endpoints_stop_when_rate_limited(self):
        for name in ('setup', 'enable', 'disable'):
            e = handlers()
            e['enforce_rate_limit'].side_effect = HTTPException(429, 'limited')
            with self.assertRaises(HTTPException) as err:
                await e['two_factor_' + name](SimpleNamespace(password='correct', code='123456'),
                    dict(id='u', email='u@example.test', totp_secret='secret'))
            self.assertEqual(err.exception.status_code, 429)
            e['db'].users.update_one.assert_not_awaited()

    async def test_stale_totp_secret_cannot_enable_or_disable_new_secret(self):
        for name in ('enable', 'disable'):
            e = handlers()
            e['db'].users.update_one.return_value.matched_count = 0
            with self.assertRaises(HTTPException) as err:
                await e['two_factor_' + name](SimpleNamespace(code='123456'),
                    dict(id='u', totp_secret='old', two_factor_enabled=True))
            self.assertEqual(err.exception.status_code, 409)
            self.assertEqual(e['db'].users.update_one.call_args.args[0]['totp_secret'], 'old')

    async def test_valid_enable_and_disable(self):
        for name, enabled in [('enable', True), ('disable', False)]:
            e = handlers()
            result = await e['two_factor_' + name](SimpleNamespace(code='123456'),
                dict(id='u', totp_secret='secret', two_factor_enabled=True))
            self.assertEqual(result['two_factor_enabled'], enabled)


if __name__ == '__main__':
    unittest.main()
