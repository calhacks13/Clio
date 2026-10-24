"""The /track stream end to end (TRACK.md): through Starlette's test client, and through uvicorn
with the service's own WebSocket protocol on a real socket."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import socket
import struct
import threading
import time

import pytest
import uvicorn
from fastapi.testclient import TestClient
from PIL import Image
from starlette.websockets import WebSocketDisconnect

from jev_finder.app import create_app
from jev_finder.finder import Finder
from jev_finder.stream import Inbox
from jev_finder.tracker import FrameHeader, TargetBox
from jev_finder.websocket import WebSocketProtocol, accept_key


def frame(seq: int, size=(320, 240), noise: bool = False) -> bytes:
    buffer = io.BytesIO()
    if noise:
        Image.frombytes("RGB", size, os.urandom(size[0] * size[1] * 3)).save(buffer, "JPEG")
    else:
        Image.new("RGB", size, (90, 120, 160)).save(buffer, "JPEG")
    header = json.dumps(
        {"type": "frame", "seq": seq, "t": 500.0 + seq, "width": size[0], "height": size[1]}
    ).encode()
    return struct.pack(">I", len(header)) + header + buffer.getvalue()


TARGET = json.dumps(
    {"type": "target", "seq": 0, "box": [0.25, 0.25, 0.75, 0.75], "name": "blue card"}
)


@pytest.fixture
def app(fake_jev, fake_segmenter):
    finder = Finder(fake_jev.client(), fake_segmenter, "jev-1.14.0")
    yield create_app(finder, "cpu")
    finder.close()


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        yield client


def test_ready_then_one_mask_per_frame(client, fake_segmenter):
    with client.websocket_connect("/track") as ws:
        assert ws.receive_json() == {"type": "ready", "model": "fake-sam"}
        ws.send_bytes(frame(0))
        idle = ws.receive_json()
        assert idle["type"] == "mask" and idle["seq"] == 0 and idle["t"] == 500.0
        assert idle["found"] is False and idle["outline"] is None

        ws.send_text(TARGET)
        ws.send_bytes(frame(1))
        found = ws.receive_json()
        assert found["seq"] == 1 and found["found"] is True and found["name"] == "blue card"
        assert found["box"] == pytest.approx([0.25, 0.25, 0.75, 0.75], abs=0.01)
        assert found["contact"] == pytest.approx([0.5, 0.75], abs=0.01)
        assert found["model"] == "fake-sam"

        ws.send_bytes(frame(2))
        assert ws.receive_json()["found"] is True
        ws.send_text('{"type": "clear"}')
        ws.send_bytes(frame(3))
        assert ws.receive_json()["found"] is False
    assert fake_segmenter.prompts[0] == ([0.25, 0.25, 0.75, 0.75], None)
    assert fake_segmenter.prompts[1][1] == pytest.approx([0.5, 0.5], abs=0.01)


def test_bad_messages_are_skipped(client):
    with client.websocket_connect("/track") as ws:
        ws.receive_json()
        ws.send_bytes(b"\x00\x00\x00\x02{}")
        ws.send_text('{"type": "dance"}')
        ws.send_bytes(frame(7))
        assert ws.receive_json()["seq"] == 7


def test_only_the_newest_waiting_frame_is_segmented(client, fake_segmenter):
    fake_segmenter.hold = threading.Event()
    with client.websocket_connect("/track") as ws:
        ws.receive_json()
        ws.send_text(TARGET)
        ws.send_bytes(frame(1))
        assert fake_segmenter.segmenting.wait(5)
        for seq in (2, 3, 4):  # the page timed out waiting and sent more
            ws.send_bytes(frame(seq))
        time.sleep(0.3)  # let the reader take them in while frame 1 is still segmenting
        fake_segmenter.hold.set()
        assert ws.receive_json()["seq"] == 1
        assert ws.receive_json()["seq"] == 4
        ws.send_bytes(frame(5))
        assert ws.receive_json()["seq"] == 5
    assert len(fake_segmenter.prompts) == 3


def test_inbox_keeps_commands_in_order_and_the_newest_frame():
    async def run():
        inbox = Inbox()
        first = TargetBox(1, [0, 0, 0.5, 0.5], "a")
        inbox.put_command(first)
        for seq in range(3):
            inbox.put_frame((FrameHeader(seq, 0, 1, 1), b""))
        inbox.put_command(None)
        commands, newest = await inbox.take()
        assert commands == [first, None]
        assert newest[0].seq == 2 and inbox.dropped == 2
        inbox.close()
        assert await inbox.take() == ([], None)

    asyncio.run(run())


@pytest.mark.parametrize(
    "headers",
    [{"origin": "https://evil.example"}, {"host": "evil.example"}],
)
def test_foreign_pages_are_refused(client, headers):
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect("/track", headers=headers):
            pass
    assert refused.value.code == 1008


def test_local_page_origin_is_accepted(client):
    with client.websocket_connect("/track", headers={"origin": "http://localhost:5173"}) as ws:
        assert ws.receive_json()["type"] == "ready"


# The service's WebSocket protocol on a real socket


class Client:
    """A bare RFC 6455 client: masked frames out, unmasked frames in."""

    def __init__(self, port: int, path: str = "/track", origin: str | None = None):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        key = base64.b64encode(os.urandom(16))
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: 127.0.0.1:{port}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key.decode()}",
            "Sec-WebSocket-Version: 13",
        ]
        if origin:
            lines.append(f"Origin: {origin}")
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        self.buffer = b""
        while b"\r\n\r\n" not in self.buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            self.buffer += chunk
        head, _, self.buffer = self.buffer.partition(b"\r\n\r\n")
        self.status = int(head.split(b" ")[1])
        self.headers = {
            k.strip().lower(): v.strip()
            for k, _, v in (line.partition(b":") for line in head.split(b"\r\n")[1:])
        }
        self.key = key

    def send(self, opcode: int, payload: bytes, final: bool = True) -> None:
        mask = os.urandom(4)
        n = len(payload)
        head = bytes([(0x80 if final else 0) | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 1 << 16:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(head + mask + masked)

    def _read(self, n: int) -> bytes:
        while len(self.buffer) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            self.buffer += chunk
        data, self.buffer = self.buffer[:n], self.buffer[n:]
        return data

    def receive(self) -> tuple[int, bytes]:
        first, second = self._read(2)
        assert not second & 0x80, "server frames are unmasked"
        n = second & 0x7F
        if n == 126:
            (n,) = struct.unpack(">H", self._read(2))
        elif n == 127:
            (n,) = struct.unpack(">Q", self._read(8))
        return first & 0x0F, self._read(n)

    def receive_json(self) -> dict:
        opcode, payload = self.receive()
        assert opcode == 1
        return json.loads(payload)

    def close(self) -> None:
        self.sock.close()


@pytest.fixture
def served(app):
    config = uvicorn.Config(app, host="127.0.0.1", port=0, ws=WebSocketProtocol, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(500):
        if server.started:
            break
        time.sleep(0.01)
    yield server.servers[0].sockets[0].getsockname()[1]
    server.should_exit = True
    thread.join(5)


def test_websocket_protocol_serves_track(served):
    ws = Client(served, origin="http://localhost:5173")
    assert ws.status == 101
    assert ws.headers[b"sec-websocket-accept"] == accept_key(ws.key)
    assert ws.receive_json() == {"type": "ready", "model": "fake-sam"}

    # A target split into three fragments, a ping between frames, then a 16-bit-length frame.
    text = TARGET.encode()
    ws.send(0x1, text[:10], final=False)
    ws.send(0x0, text[10:30], final=False)
    ws.send(0x0, text[30:])
    ws.send(0x9, b"hi")
    assert ws.receive() == (0xA, b"hi")
    ws.send(0x2, frame(1))
    answer = ws.receive_json()
    assert answer["seq"] == 1 and answer["found"] is True and answer["name"] == "blue card"

    big = frame(2, size=(640, 480), noise=True)
    assert len(big) >= 1 << 16  # a 64-bit payload length
    ws.send(0x2, big)
    assert ws.receive_json()["seq"] == 2

    ws.send(0x8, struct.pack(">H", 1000))
    opcode, payload = ws.receive()
    assert opcode == 0x8 and payload[:2] == struct.pack(">H", 1000)
    ws.close()


def test_websocket_protocol_refuses_foreign_origins_and_bad_frames(served):
    refused = Client(served, origin="https://evil.example")
    assert refused.status == 403
    refused.close()

    missing = Client(served, path="/nowhere")
    assert missing.status == 403
    missing.close()

    ws = Client(served)
    ws.receive_json()
    ws.sock.sendall(bytes([0x82, 0x03]) + b"abc")  # unmasked client frame
    opcode, payload = ws.receive()
    assert opcode == 0x8 and struct.unpack(">H", payload[:2])[0] == 1002
    ws.close()


def test_a_segmenter_failure_closes_with_1011_and_is_logged(served, fake_segmenter, caplog):
    def fail(*args, **kwargs):
        raise RuntimeError("MPS backend out of memory")

    fake_segmenter.segment = fail
    ws = Client(served, origin="http://localhost:5173")
    ws.receive_json()
    ws.send(0x1, TARGET.encode())
    ws.send(0x2, frame(1))
    opcode, payload = ws.receive()
    assert opcode == 0x8 and struct.unpack(">H", payload[:2])[0] == 1011
    ws.close()
    assert "MPS backend out of memory" in caplog.text


def test_http_routes_still_work_beside_the_websocket_protocol(served):
    with socket.create_connection(("127.0.0.1", served), timeout=5) as sock:
        sock.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        response = b""
        while chunk := sock.recv(4096):
            response += chunk
    assert response.startswith(b"HTTP/1.1 200")
    assert b'"model":"jev-1.14.0+fake-sam"' in response
