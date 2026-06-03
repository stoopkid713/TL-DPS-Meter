"""Regression test: _h_client_debug must not crash when fields contains 'event'.

Root cause: if the frontend sends {"command": "client_debug", "event": "room.open",
"fields": {"event": "ws.open", ...}}, the dict-splat **fields passes an 'event'
keyword argument that collides with trace()'s positional parameter
``def trace(event: str, **fields)``, raising:
    TypeError: trace() got multiple values for argument 'event'

Fix (dps_meter_server.py _h_client_debug): strip the key "event" from fields
before splatting — it is the only name in trace()'s explicit signature besides
**fields. All other fields are forwarded unchanged.

Two layers:
  * Unit — call _h_client_debug directly with a stub server and spy on trace().
  * Key-strip — verify the "event" key is silently dropped, all others forwarded.
"""
from __future__ import annotations

import importlib
from unittest.mock import patch, call

import pytest

import dps_meter_server as srv


# ---------------------------------------------------------------------------
# Minimal server stub (handler only touches debug.* — no real server needed)
# ---------------------------------------------------------------------------
class _Stub:
    """_h_client_debug only accesses debug module globals; stub is empty."""


# ---------------------------------------------------------------------------
# Unit: colliding 'event' key in fields must not raise TypeError
# ---------------------------------------------------------------------------
def test_client_debug_event_key_no_crash():
    """fields dict containing 'event' must not raise TypeError."""
    msg = {
        "command": "client_debug",
        "event": "room.open",
        "fields": {
            "event": "ws.open",   # the colliding key — this was the crash trigger
            "latency_ms": 42,
        },
    }
    calls = []
    import debug as debug_mod

    def _spy_trace(event, **fields):
        calls.append((event, fields))

    with patch.object(debug_mod, "enabled", return_value=True), \
         patch.object(debug_mod, "trace", side_effect=_spy_trace):
        # Must not raise
        result = srv._h_client_debug(_Stub(), msg)

    assert result is None, "_h_client_debug should always return None"
    assert len(calls) == 1, "trace() should be called exactly once"

    traced_event, traced_fields = calls[0]
    assert traced_event == "client.room.open"

    # The colliding key is stripped from fields
    assert "event" not in traced_fields, (
        "REGRESSION: 'event' key in fields must be stripped before splatting"
    )
    # All other fields are forwarded
    assert traced_fields.get("latency_ms") == 42


def test_client_debug_non_event_fields_forwarded():
    """All non-colliding fields are forwarded to trace unchanged."""
    msg = {
        "command": "client_debug",
        "event": "ws.message",
        "fields": {
            "event": "redundant",
            "seq": 7,
            "payload": "hello",
        },
    }
    calls = []
    import debug as debug_mod

    def _spy_trace(event, **fields):
        calls.append((event, fields))

    with patch.object(debug_mod, "enabled", return_value=True), \
         patch.object(debug_mod, "trace", side_effect=_spy_trace):
        srv._h_client_debug(_Stub(), msg)

    _, traced_fields = calls[0]
    assert traced_fields == {"seq": 7, "payload": "hello"}, (
        "Only 'event' should be stripped — seq and payload must pass through"
    )


def test_client_debug_no_event_key_in_fields_unchanged():
    """Normal fields dict (no 'event' key) still forwards correctly."""
    msg = {
        "command": "client_debug",
        "event": "ws.close",
        "fields": {"code": 1000, "reason": "normal"},
    }
    calls = []
    import debug as debug_mod

    def _spy_trace(event, **fields):
        calls.append((event, fields))

    with patch.object(debug_mod, "enabled", return_value=True), \
         patch.object(debug_mod, "trace", side_effect=_spy_trace):
        srv._h_client_debug(_Stub(), msg)

    traced_event, traced_fields = calls[0]
    assert traced_event == "client.ws.close"
    assert traced_fields == {"code": 1000, "reason": "normal"}


def test_client_debug_non_dict_fields_uses_value_branch():
    """Non-dict fields take the value= branch (existing behavior preserved)."""
    msg = {
        "command": "client_debug",
        "event": "raw_event",
        "fields": "some plain string",
    }
    calls = []
    import debug as debug_mod

    def _spy_trace(event, **fields):
        calls.append((event, fields))

    with patch.object(debug_mod, "enabled", return_value=True), \
         patch.object(debug_mod, "trace", side_effect=_spy_trace):
        srv._h_client_debug(_Stub(), msg)

    traced_event, traced_fields = calls[0]
    assert traced_event == "client.raw_event"
    assert traced_fields == {"value": "some plain string"}


def test_client_debug_noop_when_tracing_disabled():
    """When debug.enabled() is False, trace is never called."""
    msg = {
        "command": "client_debug",
        "event": "anything",
        "fields": {"event": "collide"},
    }
    import debug as debug_mod

    with patch.object(debug_mod, "enabled", return_value=False), \
         patch.object(debug_mod, "trace") as mock_trace:
        result = srv._h_client_debug(_Stub(), msg)

    assert result is None
    mock_trace.assert_not_called()
