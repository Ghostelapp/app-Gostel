from backend.fcm import build_message


def test_call_push_is_android_data_only_for_lock_screen_handler():
    payload = build_message(
        token="TEST_TOKEN",
        title="Caller is calling",
        body="Incoming audio call",
        channel_id="calls",
        sound="ringtone",
        ttl_seconds=30,
        data={
            "type": "incoming_call",
            "kind": "call",
            "push_kind": "call",
            "screen": "call",
            "call_id": "call-123",
            "conversation_id": "conv-123",
            "caller_id": "user-123",
            "caller_name": "Caller",
        },
        is_call=True,
    )

    message = payload["message"]
    assert message["data"]["type"] == "incoming_call"
    assert message["data"]["kind"] == "call"
    assert message["data"]["push_kind"] == "call"
    assert message["data"]["call_id"] == "call-123"
    assert message["android"]["priority"] == "high"
    assert message["android"]["ttl"] == "30s"
    assert "notification" not in message["android"]


def test_regular_message_push_keeps_android_notification_block():
    payload = build_message(
        token="TEST_TOKEN",
        title="New message",
        body="Hello",
        channel_id="messages",
        sound="message",
        data={"type": "message"},
        is_call=False,
    )

    message = payload["message"]
    assert message["android"]["notification"]["channel_id"] == "messages"
    assert message["android"]["notification"]["sound"] == "message"


def test_call_control_push_is_silent_data_only():
    payload = build_message(
        token="TEST_TOKEN",
        title="ghostel.app call",
        body="",
        channel_id="calls",
        data={
            "type": "call_control",
            "call_control_action": "accepted",
            "call_id": "call-123",
            "accepted_by": "user-123",
        },
        data_only=True,
    )

    message = payload["message"]
    assert message["data"]["type"] == "call_control"
    assert message["data"]["call_control_action"] == "accepted"
    assert message["android"]["priority"] == "high"
    assert "notification" not in message["android"]
    assert message["apns"]["headers"]["apns-push-type"] == "background"
    assert message["apns"]["payload"]["aps"] == {"content-available": 1}
