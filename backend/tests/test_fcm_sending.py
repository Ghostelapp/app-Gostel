from unittest.mock import Mock

import pytest

from backend import fcm


class FakeResponse:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self._body = body
        self.text = str(body)

    def json(self):
        return self._body


@pytest.mark.asyncio
async def test_send_fcm_refreshes_oauth_token_and_retries_once(monkeypatch):
    client = Mock()
    client.post = Mock(
        side_effect=[
            FakeResponse(
                401,
                {
                    "error": {
                        "status": "UNAUTHENTICATED",
                        "message": "Invalid authentication credentials",
                    }
                },
            ),
            FakeResponse(200, {"name": "projects/test/messages/123"}),
        ]
    )

    async def post(*args, **kwargs):
        return client.post(*args, **kwargs)

    monkeypatch.setattr(fcm, "is_configured", lambda: True)
    monkeypatch.setattr(fcm, "get_project_id", lambda: "test-project")
    get_token = Mock(side_effect=["stale-token", "fresh-token"])
    monkeypatch.setattr(fcm, "_get_access_token", get_token)

    result = await fcm.send_fcm(
        type("Client", (), {"post": post})(),
        token="device-token",
        title="Incoming call",
        body="Caller is calling",
        data={"type": "incoming_call", "call_id": "call-123"},
        is_call=True,
    )

    assert result["ok"] is True
    assert result["message_name"] == "projects/test/messages/123"
    assert client.post.call_count == 2
    assert client.post.call_args_list[0].kwargs["headers"]["Authorization"] == "Bearer stale-token"
    assert client.post.call_args_list[1].kwargs["headers"]["Authorization"] == "Bearer fresh-token"
    assert get_token.call_args_list[1].kwargs == {"force_refresh": True}


@pytest.mark.asyncio
async def test_send_fcm_does_not_retry_apple_authentication_error(monkeypatch):
    response = FakeResponse(
        401,
        {
            "error": {
                "status": "UNAUTHENTICATED",
                "message": "APNs authentication error",
                "details": [
                    {
                        "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                        "errorCode": "THIRD_PARTY_AUTH_ERROR",
                    }
                ],
            }
        },
    )

    async def post(*args, **kwargs):
        return response

    monkeypatch.setattr(fcm, "is_configured", lambda: True)
    monkeypatch.setattr(fcm, "get_project_id", lambda: "test-project")
    get_token = Mock(return_value="valid-google-token")
    monkeypatch.setattr(fcm, "_get_access_token", get_token)

    result = await fcm.send_fcm(
        type("Client", (), {"post": post})(),
        token="ios-device-token",
        title="Incoming call",
        body="Caller is calling",
        is_call=True,
    )

    assert result["ok"] is False
    assert result["fcm_error_code"] == "THIRD_PARTY_AUTH_ERROR"
    assert get_token.call_count == 1
