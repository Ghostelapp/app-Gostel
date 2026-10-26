"""ASGI byte budget enforced before JSON/multipart parsing, including chunked bodies."""
import json


class RequestTooLarge(Exception):
    pass


class RequestBodyLimit:
    def __init__(self, app, max_bytes=16 * 1024 * 1024):
        if max_bytes <= 0:
            raise ValueError('max_bytes must be positive')
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)

        async def deny(status, detail):
            body = json.dumps({'detail': detail}).encode()
            await send({'type':'http.response.start', 'status':status, 'headers':[
                (b'content-type', b'application/json'),
                (b'content-length', str(len(body)).encode()),
                (b'cache-control', b'no-store'),
            ]})
            await send({'type':'http.response.body', 'body':body})

        lengths = [v for k,v in scope.get('headers', ()) if k.lower() == b'content-length']
        if lengths:
            if len(lengths) != 1 or not lengths[0].isdigit() or len(lengths[0]) > 20:
                return await deny(400, 'Invalid Content-Length')
            if int(lengths[0]) > self.max_bytes:
                return await deny(413, 'Request body too large')
        consumed = 0
        exceeded = False
        started = False
        denied = False

        async def bounded_receive():
            nonlocal consumed, exceeded
            if exceeded:
                raise RequestTooLarge()
            event = await receive()
            if event['type'] == 'http.request':
                consumed += len(event.get('body', b''))
                if consumed > self.max_bytes:
                    exceeded = True
                    raise RequestTooLarge()
            return event

        async def bounded_send(event):
            nonlocal started, denied
            if exceeded:
                # A route may catch a parser exception and return 400/500.
                # Preserve the actual failure and never send a partial success.
                if not started and not denied:
                    denied = True
                    await deny(413, 'Request body too large')
                return
            if event['type'] == 'http.response.start':
                started = True
            await send(event)

        try:
            await self.app(scope, bounded_receive, bounded_send)
        except RequestTooLarge:
            if not started and not denied:
                await deny(413, 'Request body too large')
