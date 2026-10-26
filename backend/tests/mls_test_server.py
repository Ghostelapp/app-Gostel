"""Local-only integration harness. Never imported by the production server."""
import os
import uuid
from datetime import datetime, timezone, timedelta
from urllib.parse import urlparse
from fastapi import FastAPI, Request, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from backend.mls_delivery import MLSDelivery


def make_app():
    if os.environ.get('GHOSTEL_MLS_TEST_HARNESS') != '1':
        raise RuntimeError('Explicit local test harness activation required')
    uri = os.environ['GHOSTEL_MLS_TEST_MONGO']
    if urlparse(uri).hostname != '127.0.0.1':
        raise RuntimeError('The test harness accepts only loopback MongoDB')
    database = 'ghostel_mls_test_' + uuid.uuid4().hex
    client = AsyncIOMotorClient(uri)
    db = client[database]
    async def auth(request: Request):
        user = request.headers.get('authorization', '').removeprefix('Bearer ')
        if user not in ('alice', 'bob', 'carol', 'mallory'):
            raise HTTPException(401)
        await db.user_sessions.update_one({'id': user + '-session'}, {'$setOnInsert': {'user_id': user, 'revoked_at': None, 'expires_at': datetime.now(timezone.utc) + timedelta(days=1)}}, upsert=True)
        return {'id': user, '_auth_sid': user + '-session'}
    async def noop(*args, **kwargs):
        pass
    app = FastAPI()
    service = MLSDelivery(db, auth, noop, noop, noop, enabled=True)
    app.include_router(service.router, prefix='/api')
    @app.on_event('startup')
    async def startup():
        await service.startup()
    @app.on_event('shutdown')
    async def shutdown():
        await client.drop_database(database)
        client.close()
    @app.post('/test/legacy/{conversation}')
    async def legacy(conversation: str, request: Request):
        user = await auth(request)
        await service.conversation(conversation, user)
        await service.insert_legacy_message(conversation, {"id": str(uuid.uuid4()), "conversation_id": conversation, "content": "[encrypted message]"})
        return {"inserted": True}
    @app.post('/test/revoke-session')
    async def revoke_session(request: Request):
        user = await auth(request)
        await db.user_sessions.update_one({'id': user['_auth_sid']}, {'$set': {'revoked_at': datetime.now(timezone.utc)}})
        return {'revoked': True}
    @app.get('/ready')
    async def ready():
        return {'ready': True}
    @app.post('/test/room')
    async def room(request: Request):
        user = await auth(request)
        payload = await request.json()
        conversation = {'id': str(uuid.uuid4()), 'created_by': user['id'], 'member_ids': payload['members'], 'type': 'group' if len(payload['members']) > 2 else 'direct'}
        await db.conversations.insert_one(conversation.copy())
        return conversation
    @app.get('/test/events/{conversation}')
    async def raw_events(conversation: str):
        return await db.mls_events.find({'conversation_id': conversation}, {'_id': 0}).sort('seq', 1).to_list(1000)
    return app
