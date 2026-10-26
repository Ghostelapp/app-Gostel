"""Opaque MLS delivery. Requires MongoDB transactions; no plaintext/key handling.

Each room has an immutable device roster in this initial integration. Changing
that roster requires a new room; legacy membership endpoints must not mutate it.
"""
import base64
import binascii
import hashlib
import json
from datetime import datetime, timezone, timedelta
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, validator
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

PROTOCOL = "mls-v1"


def b64(value, maximum=1048576):
    if not isinstance(value, str) or len(value) > 4 * ((maximum + 2) // 3):
        raise ValueError("Encoded payload exceeds limit")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("Invalid base64")
    if not raw or len(raw) > maximum or base64.b64encode(raw).decode() != value:
        raise ValueError("Invalid encoded size or representation")
    return value


class StrictModel(BaseModel):
    class Config:
        extra = "forbid"


class DeviceIn(StrictModel):
    device_id: str = Field(min_length=16, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    signature_key: str = Field(min_length=44, max_length=44)
    session_proof: str = Field(min_length=88, max_length=88)
    key_packages: List[str] = Field(min_length=0, max_length=32)

    @validator("signature_key")
    def valid_key(cls, value):
        b64(value, 32)
        if len(base64.b64decode(value)) != 32:
            raise ValueError("Ed25519 key must contain 32 bytes")
        return value

    @validator("key_packages", each_item=True)
    def valid_package(cls, value):
        return b64(value, 16384)


class EventIn(StrictModel):
    device_id: str = Field(min_length=16, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    request_id: str = Field(min_length=32, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    expected_seq: int = Field(ge=0, le=9007199254740990)
    epoch: int = Field(ge=0, le=9007199254740990)
    kind: Literal["bootstrap", "commit", "application"]
    message: str = Field(min_length=1, max_length=1400000)
    welcome: Optional[str] = Field(default=None, max_length=1400000)
    device_ids: Optional[List[str]] = Field(default=None, max_length=256)

    @validator("message", "welcome")
    def valid_wire(cls, value):
        return b64(value) if value is not None else value


def request_digest(payload):
    return hashlib.sha256(json.dumps(payload.dict(), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class MLSDelivery:
    def __init__(self, db, authenticate, rate_limit, blocked_check, broadcast, enabled=False, notify=None):
        self.db = db
        self.enabled = enabled
        self.notify = notify
        self.rate_limit = rate_limit
        self.blocked_check = blocked_check
        self.broadcast = broadcast
        self.router = APIRouter(prefix="/mls", tags=["MLS"])
        auth = Depends(authenticate)

        async def require_enabled():
            if not self.enabled:
                raise HTTPException(503, "MLS delivery is not enabled")

        gate = [Depends(require_enabled)]

        @self.router.get("/capabilities")
        async def capabilities(user=auth):
            return {"enabled": self.enabled, "protocol": PROTOCOL, "immutable_roster": True}

        @self.router.get("/session", dependencies=gate)
        async def binding(user=auth):
            if not user.get("_auth_sid"):
                raise HTTPException(401, "A current device session is required")
            return {"session_id": user["_auth_sid"]}

        @self.router.post("/devices", dependencies=gate)
        async def register(payload: DeviceIn, user=auth):
            sid = user.get("_auth_sid")
            if not sid:
                raise HTTPException(401, "A current device session is required")
            await rate_limit("mls-device-register", user["id"], limit=64, window_seconds=3600)
            try:
                proof = base64.b64decode(payload.session_proof, validate=True)
                message = json.dumps(["ghostel-device-session-v1", user["id"], payload.device_id, sid], separators=(",", ":")).encode()
                Ed25519PublicKey.from_public_bytes(base64.b64decode(payload.signature_key)).verify(proof, message)
            except (ValueError, binascii.Error, InvalidSignature):
                raise HTTPException(403, "Invalid device possession proof")
            device = {"_id": payload.device_id, "device_id": payload.device_id,
                      "user_id": user["id"], "session_id": sid,
                      "signature_key": payload.signature_key, "revoked": False}
            async def txn(session):
                await self.active_session(user, session)
                existing = await db.mls_devices.find_one({"_id": payload.device_id}, session=session)
                if existing:
                    if any(existing.get(k) != device[k] for k in ("user_id", "signature_key", "revoked")):
                        raise HTTPException(409, "Device identity is immutable; enroll a new device")
                    await db.mls_devices.update_one({"_id": payload.device_id}, {"$set": {"session_id": sid}}, session=session)
                else:
                    if await db.mls_devices.count_documents({"user_id": user["id"], "revoked": False}, session=session) >= 16:
                        raise HTTPException(409, "Device limit reached")
                    await db.mls_devices.insert_one(device, session=session)
                for package in payload.key_packages:
                    ref = hashlib.sha256(base64.b64decode(package)).hexdigest()
                    # Retain consumed package tombstones. Republishing cannot resurrect one-time keys.
                    await db.mls_key_packages.update_one({"_id": ref}, {"$setOnInsert": {
                        "device_id": payload.device_id, "package": package, "claimed": False, "published_at": datetime.now(timezone.utc),
                    }}, upsert=True, session=session)
                if await db.mls_key_packages.count_documents({"device_id": payload.device_id, "claimed": False, "published_at": {"$gt": datetime.now(timezone.utc) - timedelta(days=7)}}, session=session) > 64:
                    raise HTTPException(409, "KeyPackage queue is full")
                return {"device_id": payload.device_id, "available": await db.mls_key_packages.count_documents({"device_id": payload.device_id, "claimed": False, "published_at": {"$gt": datetime.now(timezone.utc) - timedelta(days=7)}}, session=session)}
            return await self.transaction(txn)

        @self.router.get("/conversations/{conversation_id}/devices", dependencies=gate)
        async def directory(conversation_id: str, user=auth):
            conv = await self.conversation(conversation_id, user)
            devices = await db.mls_devices.find({"user_id": {"$in": conv["member_ids"]}, "revoked": False},
                {"_id": 0, "device_id": 1, "user_id": 1, "signature_key": 1}).to_list(257)
            return {"devices": devices, "protocol": conv.get("e2ee_protocol"),
                    "seq": conv.get("mls_seq", 0), "epoch": conv.get("mls_epoch", 0),
                    "device_ids": conv.get("mls_device_ids", [])}

        @self.router.post("/conversations/{conversation_id}/packages/{target_device}/{request_id}", dependencies=gate)
        async def claim(conversation_id: str, target_device: str, request_id: str, device_id: str, user=auth):
            if len(request_id) != 36:
                raise HTTPException(400, "Invalid claim identifier")
            await rate_limit("mls-package-claim", user["id"], limit=64, window_seconds=3600)
            claim_id = f"{conversation_id}:{device_id}:{target_device}:{request_id}"
            async def txn(session):
                conv = await self.conversation(conversation_id, user, session)
                await self.device(device_id, user, session)
                if conv.get("e2ee_protocol") == PROTOCOL:
                    raise HTTPException(409, "This room already has an immutable MLS roster")
                target = await db.mls_devices.find_one({"_id": target_device, "user_id": {"$in": conv["member_ids"]}, "revoked": False}, session=session)
                if not target:
                    raise HTTPException(404, "Device not found")
                existing = await db.mls_claims.find_one({"_id": claim_id}, session=session)
                if existing:
                    return {"package": existing["package"]}
                package = await db.mls_key_packages.find_one_and_update(
                    {"device_id": target_device, "claimed": False, "published_at": {"$gt": datetime.now(timezone.utc) - timedelta(days=7)}}, {"$set": {"claimed": True}},
                    return_document=ReturnDocument.BEFORE, session=session)
                if not package:
                    raise HTTPException(409, "No one-time KeyPackage available")
                await db.mls_claims.insert_one({"_id": claim_id, "package": package["package"]}, session=session)
                return {"package": package["package"]}
            return await self.transaction(txn)

        @self.router.post("/conversations/{conversation_id}/events", dependencies=gate)
        async def append(conversation_id: str, payload: EventIn, user=auth):
            await rate_limit("mls-event", user["id"], limit=240, window_seconds=60)
            digest = request_digest(payload)
            event_id = f"{conversation_id}:{payload.request_id}"
            async def txn(session):
                conv = await self.conversation(conversation_id, user, session)
                await self.device(payload.device_id, user, session)
                previous = await db.mls_events.find_one({"_id": event_id}, session=session)
                if previous:
                    if previous["digest"] != digest or previous["sender_device_id"] != payload.device_id:
                        raise HTTPException(409, "Idempotency identifier reused with different content")
                    return self.public_event(previous)
                seq, epoch = conv.get("mls_seq", 0), conv.get("mls_epoch", 0)
                if payload.expected_seq != seq or payload.epoch != epoch:
                    raise HTTPException(409, "MLS sequence or epoch conflict; synchronize first")
                roster = conv.get("mls_device_ids", [])
                updates = {}
                if payload.kind == "bootstrap":
                    if conv.get("e2ee_protocol") == PROTOCOL or seq != 0 or not payload.welcome:
                        raise HTTPException(409, "Room already initialized or Welcome missing")
                    if conv.get("disappear_seconds"):
                        raise HTTPException(409, "Disable legacy disappearing messages before activating MLS")
                    if user["id"] != conv.get("created_by"):
                        raise HTTPException(403, "Only the room creator may initialize MLS")
                    roster = payload.device_ids or []
                    if len(roster) < 2 or len(set(roster)) != len(roster) or payload.device_id not in roster:
                        raise HTTPException(400, "Invalid device roster")
                    members = await db.mls_devices.find({"_id": {"$in": roster}, "revoked": False}, session=session).to_list(257)
                    if len(members) != len(roster) or {d["user_id"] for d in members} != set(conv["member_ids"]):
                        raise HTTPException(400, "Roster must cover exactly the room members")
                    updates.update(e2ee_protocol=PROTOCOL, mls_device_ids=roster, mls_started_at=datetime.now(timezone.utc).isoformat())
                else:
                    if conv.get("e2ee_protocol") != PROTOCOL or payload.device_id not in roster:
                        raise HTTPException(403, "Device is not in this MLS room")
                    if payload.welcome is not None or payload.device_ids is not None:
                        raise HTTPException(400, "MLS room membership is immutable")
                    if await db.mls_devices.count_documents({"_id": {"$in": roster}, "revoked": False}, session=session) != len(roster):
                        raise HTTPException(409, "A room device was revoked; create a new room")
                member_devices = await db.mls_devices.find({"_id": {"$in": roster}, "revoked": False}, session=session).to_list(257)
                if len(member_devices) != len(roster) or {d["user_id"] for d in member_devices} != set(conv["member_ids"]):
                    raise HTTPException(409, "MLS membership changed; create a new room")
                await db.mls_devices.update_many({"_id": {"$in": roster}}, {"$inc": {"delivery_fence": 1}}, session=session)
                next_epoch = epoch + (payload.kind != "application")
                updates.update(mls_seq=seq + 1, mls_epoch=next_epoch)
                await db.conversations.update_one({"id": conversation_id}, {"$set": updates}, session=session)
                event = {"_id": event_id, "id": payload.request_id, "conversation_id": conversation_id,
                         "seq": seq + 1, "epoch": next_epoch, "kind": payload.kind,
                         "sender_id": user["id"], "sender_device_id": payload.device_id,
                         "message": payload.message, "welcome": payload.welcome,
                         "device_ids": roster if payload.kind == "bootstrap" else None,
                         "digest": digest, "created_at": datetime.now(timezone.utc).isoformat()}
                await db.mls_events.insert_one(event, session=session)
                return self.public_event(event)
            result = await self.transaction(txn)
            conv = await self.conversation(conversation_id, user)
            await broadcast(conv["member_ids"], {"type": "mls:event", "data": {"conversation_id": conversation_id, "seq": result["seq"]}})
            if payload.kind == "application" and self.notify:
                await self.notify(conv, result)
            return result

        @self.router.get("/conversations/{conversation_id}/events", dependencies=gate)
        async def events(conversation_id: str, device_id: str, after: int = Query(0, ge=0), user=auth):
            conv = await self.conversation(conversation_id, user)
            await self.device(device_id, user)
            if device_id not in conv.get("mls_device_ids", []):
                raise HTTPException(403, "Device is not in this MLS room")
            cursor = db.mls_events.find({"conversation_id": conversation_id, "seq": {"$gt": after}}).sort("seq", 1).limit(100)
            return {"events": [self.public_event(e) async for e in cursor], "head": conv.get("mls_seq", 0)}

        @self.router.post("/conversations/{conversation_id}/attachments/{attachment_id}", dependencies=gate)
        async def share_attachment(conversation_id: str, attachment_id: str, user=auth):
            conv = await self.conversation(conversation_id, user)
            if conv.get("e2ee_protocol") != PROTOCOL:
                raise HTTPException(409, "MLS room required")
            result = await db.attachments.update_one({"id": attachment_id, "owner_id": user["id"],
                "$or": [{"mls_conversation_id": {"$exists": False}}, {"mls_conversation_id": conversation_id}]},
                {"$set": {"mls_conversation_id": conversation_id}})
            if not result.matched_count:
                raise HTTPException(403, "Attachment not owned or already bound to another room")
            return {"bound": True}

        @self.router.delete("/devices/{device_id}", dependencies=gate)
        async def revoke(device_id: str, user=auth):
            async def txn(session):
                await self.active_session(user, session)
                result = await db.mls_devices.update_one({"_id": device_id, "user_id": user["id"]}, {"$set": {"revoked": True}}, session=session)
                if not result.matched_count:
                    raise HTTPException(404, "Device not found")
                return {"revoked": True}
            return await self.transaction(txn)

    async def insert_legacy_message(self, conversation_id, message):
        if not self.enabled:
            # Enabling MLS requires draining old workers before the cluster-wide
            # feature switch. A disabled deployment never initializes MLS rooms.
            await self.db.messages.insert_one(message.copy())
            return
        async def insert(session):
            result = await self.db.conversations.update_one(
                {"id": conversation_id, "e2ee_protocol": {"$ne": PROTOCOL}},
                {"$inc": {"legacy_delivery_fence": 1}}, session=session,
            )
            if not result.matched_count:
                raise HTTPException(409, "MLS downgrade is forbidden")
            await self.db.messages.insert_one(message.copy(), session=session)
        await self.transaction(insert)

    async def transaction(self, callback):
        async with await self.db.client.start_session() as session:
            return await session.with_transaction(callback, read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"))

    async def active_session(self, user, session=None):
        query = {"id": user.get("_auth_sid"), "user_id": user["id"], "revoked_at": None,
                 "expires_at": {"$gt": datetime.now(timezone.utc)}}
        if session is not None:
            active = await self.db.user_sessions.find_one_and_update(query, {"$inc": {"mls_fence": 1}}, session=session)
        else:
            active = await self.db.user_sessions.find_one(query)
        if not user.get("_auth_sid") or not active:
            raise HTTPException(401, "MLS requires an active, unexpired session")

    async def device(self, device_id, user, session=None):
        await self.active_session(user, session)
        record = await self.db.mls_devices.find_one({"_id": device_id, "user_id": user["id"],
            "session_id": user.get("_auth_sid"), "revoked": False}, session=session)
        if not record or not user.get("_auth_sid"):
            raise HTTPException(403, "Device is not bound to this authenticated session")
        return record

    async def conversation(self, conversation_id, user, session=None):
        conv = await self.db.conversations.find_one({"id": conversation_id, "member_ids": user["id"]}, session=session)
        if not conv:
            raise HTTPException(404, "Conversation not found")
        await self.blocked_check(conv, user, action="exchange encrypted messages with")
        return conv

    @staticmethod
    def public_event(event):
        return {k: v for k, v in event.items() if k not in ("_id", "digest")}

    async def startup(self):
        if not self.enabled:
            return
        hello = await self.db.command("hello")
        if not hello.get("setName") and hello.get("msg") != "isdbgrid":
            raise RuntimeError("MLS requires a MongoDB replica set or sharded cluster for transactions")
        # Required correctness indexes: never swallow errors here.
        await self.db.user_sessions.create_index("id", unique=True)
        await self.db.mls_events.create_index([("conversation_id", 1), ("seq", 1)], unique=True)
        await self.db.mls_devices.create_index([("user_id", 1), ("revoked", 1)])
        await self.db.mls_key_packages.create_index([("device_id", 1), ("claimed", 1)])
