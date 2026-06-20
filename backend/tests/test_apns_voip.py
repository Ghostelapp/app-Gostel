from apns import build_voip_payload


def test_build_voip_payload_contains_callkit_fields():
    payload = build_voip_payload(
        {
            "call_id": "38acdbd6-17fe-45f5-9a76-720d07fbf275",
            "conversation_id": "conversation-1",
            "caller_id": "caller-1",
            "caller_name": "Patryk",
            "mode": "audio",
        }
    )

    assert payload["aps"] == {"content-available": 1}
    assert payload["uuid"] == "38acdbd6-17fe-45f5-9a76-720d07fbf275"
    assert payload["call_id"] == payload["uuid"]
    assert payload["type"] == "incoming_call"
    assert payload["screen"] == "call"
    assert payload["caller_id"] == "caller-1"
    assert payload["caller_name"] == "Patryk"
    assert payload["conversation_id"] == "conversation-1"
    assert payload["mode"] == "audio"
    assert isinstance(payload["sent_at"], int)
