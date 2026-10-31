"""A2A v0.3 client surface: paths, JSON-RPC envelope, error mapping."""

from __future__ import annotations

import json

import pytest

from pal.errors import PalApiError
from tests.test_client import _client, _last, _MockTransport

TASK = {"kind": "task", "id": "t1", "contextId": "c1", "status": {"state": "completed"}}


async def test_get_card():
    t = _MockTransport(body={"protocolVersion": "0.3.0", "name": "bot"})
    card = await _client(t).a2a.get_card("bot")
    req = _last(t)
    assert req.method == "GET"
    assert req.url.path == "/v1/agents/bot/a2a/.well-known/agent-card.json"
    assert card["protocolVersion"] == "0.3.0"


async def test_send_message_blocking():
    t = _MockTransport(body={"jsonrpc": "2.0", "id": "1", "result": TASK})
    task = await _client(t).a2a.send_message("bot", "hi", blocking=True)
    req = _last(t)
    body = json.loads(req.content)
    assert req.method == "POST" and req.url.path == "/v1/agents/bot/a2a"
    assert body["method"] == "message/send"
    assert body["params"]["message"]["parts"] == [{"kind": "text", "text": "hi"}]
    assert body["params"]["configuration"] == {"blocking": True}
    assert req.headers["authorization"] == "Bearer test-key"
    assert task["id"] == "t1"


@pytest.mark.parametrize(("call", "method"), [("get_task", "tasks/get"), ("cancel_task", "tasks/cancel")])
async def test_task_methods(call, method):
    t = _MockTransport(body={"result": TASK})
    await getattr(_client(t).a2a, call)("bot", "t1")
    body = json.loads(_last(t).content)
    assert body["method"] == method and body["params"] == {"id": "t1"}


async def test_rpc_error_raises_with_code():
    t = _MockTransport(body={"error": {"code": -32001, "message": "task not found"}})
    with pytest.raises(PalApiError) as ei:
        await _client(t).a2a.get_task("bot", "zz")
    assert ei.value.code == -32001
    assert ei.value.body == "task not found"
