import unittest
from unittest.mock import AsyncMock
from backend.request_limits import RequestBodyLimit


class BodyLimits(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, chunks, headers=(), catches=False):
        read = []
        async def app(scope, receive, send):
            try:
                while True:
                    event = await receive()
                    read.append(event.get('body'))
                    if not event.get('more_body'):
                        break
            except Exception:
                if not catches:
                    raise
            await send({'type':'http.response.start', 'status':200})
            await send({'type':'http.response.body', 'body':b'ok'})
        receive = AsyncMock(side_effect=[{'type':'http.request','body':x,'more_body':i<len(chunks)-1}
                                        for i,x in enumerate(chunks)])
        send = AsyncMock()
        await RequestBodyLimit(app, max_bytes=5)({'type':'http','headers':headers}, receive, send)
        return read, receive, send

    async def test_rejects_declared_size_before_reading(self):
        read, receive, send = await self.invoke([b'123456'], [(b'content-length',b'6')])
        receive.assert_not_awaited()
        self.assertEqual(send.call_args_list[0].args[0]['status'],413)

    async def test_chunked_stream_stops_before_oversized_chunk_reaches_parser(self):
        read, receive, send = await self.invoke([b'123',b'456',b'789'])
        self.assertEqual(read,[b'123'])
        self.assertEqual(receive.await_count,2)
        self.assertEqual(send.call_args_list[0].args[0]['status'],413)

    async def test_route_cannot_hide_size_error(self):
        _, _, send = await self.invoke([b'123456'], catches=True)
        self.assertEqual(send.call_args_list[0].args[0]['status'],413)
        self.assertNotEqual(send.call_args_list[-1].args[0]['body'], b'ok')
        self.assertEqual(send.await_count,2)

    async def test_forged_small_length_still_checks_actual_stream(self):
        _, _, send = await self.invoke([b'123456'], [(b'content-length',b'1')])
        self.assertEqual(send.call_args_list[0].args[0]['status'],413)

    async def test_exact_budget_passes(self):
        read, _, send = await self.invoke([b'12',b'345'])
        self.assertEqual(b''.join(read),b'12345')
        self.assertEqual(send.call_args_list[0].args[0]['status'],200)

    async def test_invalid_lengths_are_rejected(self):
        for headers in ([(b'content-length',b'-1')],[(b'content-length',b'x')],
                        [(b'content-length',b'9'*5000)],
                        [(b'content-length',b'1'),(b'content-length',b'1')]):
            _, receive, send = await self.invoke([b'x'],headers)
            receive.assert_not_awaited()
            self.assertEqual(send.call_args_list[0].args[0]['status'],400)
