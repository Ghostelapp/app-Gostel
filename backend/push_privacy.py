"""Minimize provider-visible push data. Never accept arbitrary profile fields.

Opaque routing IDs remain for the current clients. This is not sealed sender.
"""
ROUTING_FIELDS = frozenset({
    "type", "screen", "kind", "push_kind", "call_id", "message_id",
    "conversation_id", "caller_id", "mode", "call_control_action",
    "actor_id", "accepted_by", "ended_by", "status",
})


def private_push(data=None, *, is_call=False):
    raw = data if isinstance(data, dict) else {}
    # Callers supply protocol values; never forward nested arbitrary content.
    clean = {key: value for key, value in raw.items()
             if key in ROUTING_FIELDS and isinstance(value, (str, int, bool))}
    call = is_call or clean.get("type") in {"incoming_call", "call", "call_control"}
    if call:
        clean["caller_name"] = "ghostel.app call"
        clean["sender_name"] = "ghostel.app call"
    return (
        "ghostel.app call" if call else "ghostel.app",
        "Incoming encrypted call" if call and clean.get("type") != "call_control"
        else "New activity" if not call else "",
        clean,
    )
