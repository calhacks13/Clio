"""WebSockets for uvicorn without the `websockets` or `wsproto` packages (written when the
service ran on an env that had neither; it still needs neither). uvicorn takes any asyncio
protocol class as `ws` and hands it the upgrade request; this one speaks enough RFC 6455 for
/track on localhost: text and binary messages, fragments, ping and pong, and the closing
handshake. No extensions (so no compression), no keepalive pings: the page streams frames
continuously.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import struct
from typing import Any
from urllib.parse import unquote

from uvicorn.config import Config
from uvicorn.protocols.utils import ClientDisconnected, get_local_addr, get_remote_addr
from uvicorn.server import ServerState

log = logging.getLogger("uvicorn.error")

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_REQUEST_BYTES = 64 * 1024
CLOSE_TIMEOUT_S = 2.0

CONTINUATION, TEXT, BINARY, CLOSE, PING, PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


def accept_key(key: bytes) -> bytes:
    return base64.b64encode(hashlib.sha1(key + GUID).digest())


def encode_frame(opcode: int, payload: bytes) -> bytes:
    """One unmasked, final frame, as a server sends it."""
    length = len(payload)
    if length < 126:
        head = struct.pack(">BB", 0x80 | opcode, length)
    elif length < 1 << 16:
        head = struct.pack(">BBH", 0x80 | opcode, 126, length)
    else:
        head = struct.pack(">BBQ", 0x80 | opcode, 127, length)
    return head + payload


def unmask(payload: bytes, mask: bytes) -> bytes:
    if not payload:
        return b""
    n = len(payload)
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


def close_payload(code: int, reason: str = "") -> bytes:
    return struct.pack(">H", code) + reason.encode()[:120]


class ProtocolError(Exception):
    def __init__(self, code: int, reason: str):
        super().__init__(reason)
        self.code = code
        self.reason = reason


class WebSocketProtocol(asyncio.Protocol):
    def __init__(
        self,
        config: Config,
        server_state: ServerState,
        app_state: dict[str, Any],
        _loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        if not config.loaded:
            config.load()
        self.config = config
        self.app = config.loaded_app
        self.loop = _loop or asyncio.get_event_loop()
        self.app_state = app_state
        self.connections = server_state.connections
        self.tasks = server_state.tasks
        self.default_headers = server_state.default_headers

        self.transport: asyncio.Transport = None  # type: ignore[assignment]
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.buffer = bytearray()
        self.key: bytes | None = None
        self.path = ""
        self.accepted = False
        self.close_sent = False
        self.disconnected = False
        self.fragments = bytearray()
        self.fragments_opcode: int | None = None
        self.writable = asyncio.Event()
        self.writable.set()

    # asyncio protocol

    def connection_made(self, transport: asyncio.Transport) -> None:  # type: ignore[override]
        self.connections.add(self)
        self.transport = transport

    def connection_lost(self, exc: Exception | None) -> None:
        self.connections.discard(self)
        if not self.disconnected:
            self.disconnected = True
            self.queue.put_nowait({"type": "websocket.disconnect", "code": 1006})
        self.writable.set()

    def eof_received(self) -> None:
        pass

    def pause_writing(self) -> None:
        self.writable.clear()

    def resume_writing(self) -> None:
        self.writable.set()

    def data_received(self, data: bytes) -> None:
        self.buffer += data
        if self.key is None:
            end = self.buffer.find(b"\r\n\r\n")
            if end < 0:
                if len(self.buffer) > MAX_REQUEST_BYTES:
                    self.reject(431, "Request headers too large")
                return
            request = bytes(self.buffer[:end])
            del self.buffer[: end + 4]
            self.handle_request(request)
        elif self.accepted:
            self.read_frames()

    def shutdown(self) -> None:
        """uvicorn is stopping."""
        if self.accepted and not self.close_sent and not self.disconnected:
            self.send_close(1012)
            self.disconnected = True
            self.queue.put_nowait({"type": "websocket.disconnect", "code": 1012})
        self.transport.close()

    # Handshake

    def handle_request(self, request: bytes) -> None:
        lines = request.decode("latin-1").split("\r\n")
        try:
            method, target, _ = lines[0].split(" ", 2)
        except ValueError:
            self.reject(400, "Bad request line")
            return
        headers = []
        for line in lines[1:]:
            name, _, value = line.partition(":")
            headers.append(
                (name.strip().lower().encode("latin-1"), value.strip().encode("latin-1"))
            )
        values = dict(headers)
        upgrade = values.get(b"upgrade", b"").lower()
        key = values.get(b"sec-websocket-key", b"")
        if method != "GET" or upgrade != b"websocket" or not key:
            self.reject(400, "Not a WebSocket upgrade")
            return
        if values.get(b"sec-websocket-version") != b"13":
            self.reject(426, "Use WebSocket version 13")
            return
        self.key = key
        raw_path, _, query = target.partition("?")
        self.path = unquote(raw_path)
        subprotocols = values.get(b"sec-websocket-protocol", b"").decode("latin-1")
        scope = {
            "type": "websocket",
            "asgi": {"version": self.config.asgi_version, "spec_version": "2.4"},
            "http_version": "1.1",
            "scheme": "ws",
            "server": get_local_addr(self.transport),
            "client": get_remote_addr(self.transport),
            "root_path": self.config.root_path,
            "path": self.config.root_path + self.path,
            "raw_path": (self.config.root_path + raw_path).encode("ascii", "replace"),
            "query_string": query.encode("ascii", "replace"),
            "headers": headers,
            "subprotocols": [p.strip() for p in subprotocols.split(",") if p.strip()],
            "state": self.app_state.copy(),
        }
        self.queue.put_nowait({"type": "websocket.connect"})
        task = self.loop.create_task(self.run_asgi(scope))
        task.add_done_callback(self.tasks.discard)
        self.tasks.add(task)

    def reject(self, status: int, reason: str) -> None:
        body = reason.encode()
        self.transport.write(
            f"HTTP/1.1 {status} {reason}\r\ncontent-type: text/plain; charset=utf-8\r\n"
            f"content-length: {len(body)}\r\nconnection: close\r\n\r\n".encode()
            + body
        )
        self.transport.close()

    # ASGI

    async def run_asgi(self, scope: dict[str, Any]) -> None:
        code = 1000
        try:
            await self.app(scope, self.receive, self.send)
        except ClientDisconnected:
            pass
        except BaseException:
            log.exception("Exception in ASGI application\n")
            code = 1011
        if not self.accepted:
            if not self.transport.is_closing():
                log.error("ASGI callable returned without completing handshake.")
                self.reject(500, "Internal Server Error")
        elif not self.close_sent and not self.disconnected:
            self.send_close(code)

    async def receive(self) -> dict[str, Any]:
        return await self.queue.get()

    async def send(self, message: dict[str, Any]) -> None:
        await self.writable.wait()
        if self.disconnected:
            raise ClientDisconnected()
        kind = message["type"]
        if not self.accepted:
            if kind == "websocket.accept":
                self.accept(message)
            elif kind == "websocket.close":
                log.info('"WebSocket %s" 403', self.path)
                self.disconnected = True
                self.queue.put_nowait({"type": "websocket.disconnect", "code": 1006})
                self.reject(403, "Forbidden")
            else:
                raise RuntimeError(
                    f"Expected 'websocket.accept' or 'websocket.close', got {kind!r}."
                )
        elif self.close_sent:
            raise RuntimeError(f"Unexpected ASGI message {kind!r} after sending 'websocket.close'.")
        elif kind == "websocket.send":
            data = message.get("bytes")
            if data is None:
                self.transport.write(encode_frame(TEXT, message["text"].encode()))
            else:
                self.transport.write(encode_frame(BINARY, data))
        elif kind == "websocket.close":
            code = message.get("code", 1000)
            self.send_close(code, message.get("reason") or "")
            self.disconnected = True
            self.queue.put_nowait({"type": "websocket.disconnect", "code": code})
        else:
            raise RuntimeError(f"Expected 'websocket.send' or 'websocket.close', got {kind!r}.")

    def accept(self, message: dict[str, Any]) -> None:
        assert self.key is not None
        log.info('"WebSocket %s" [accepted]', self.path)
        headers = [
            (b"upgrade", b"websocket"),
            (b"connection", b"Upgrade"),
            (b"sec-websocket-accept", accept_key(self.key)),
        ]
        if message.get("subprotocol"):
            headers.append((b"sec-websocket-protocol", message["subprotocol"].encode()))
        headers += self.default_headers + list(message.get("headers", []))
        lines = [b"HTTP/1.1 101 Switching Protocols"] + [
            name + b": " + value for name, value in headers
        ]
        self.transport.write(b"\r\n".join(lines) + b"\r\n\r\n")
        self.accepted = True
        if self.buffer:
            self.read_frames()

    def send_close(self, code: int, reason: str = "") -> None:
        if self.close_sent or self.transport.is_closing():
            return
        self.close_sent = True
        self.transport.write(encode_frame(CLOSE, close_payload(code, reason)))
        # Wait briefly for the page to answer the close, then drop the connection anyway.
        self.loop.call_later(CLOSE_TIMEOUT_S, self.transport.close)

    # Frames

    def read_frames(self) -> None:
        try:
            while not self.transport.is_closing():
                frame = self.next_frame()
                if frame is None:
                    return
                self.handle_frame(*frame)
        except ProtocolError as e:
            self.fail(e.code, e.reason)

    def next_frame(self) -> tuple[bool, int, bytes] | None:
        """(final, opcode, payload) of the first whole frame in the buffer, removed from it."""
        buffer = self.buffer
        if len(buffer) < 2:
            return None
        first, second = buffer[0], buffer[1]
        final, opcode, length = bool(first & 0x80), first & 0x0F, second & 0x7F
        if first & 0x70:
            raise ProtocolError(1002, "Reserved bits are set")
        if not second & 0x80:
            raise ProtocolError(1002, "Client frames must be masked")
        offset = 2
        if length == 126:
            if len(buffer) < 4:
                return None
            (length,) = struct.unpack_from(">H", buffer, 2)
            offset = 4
        elif length == 127:
            if len(buffer) < 10:
                return None
            (length,) = struct.unpack_from(">Q", buffer, 2)
            offset = 10
        if opcode >= CLOSE and (length > 125 or not final):
            raise ProtocolError(1002, "Control frames must be final and short")
        if length + len(self.fragments) > self.config.ws_max_size:
            raise ProtocolError(1009, "Message too large")
        end = offset + 4 + length
        if len(buffer) < end:
            return None
        payload = unmask(bytes(buffer[offset + 4 : end]), bytes(buffer[offset : offset + 4]))
        del buffer[:end]
        return final, opcode, payload

    def handle_frame(self, final: bool, opcode: int, payload: bytes) -> None:
        if opcode in (TEXT, BINARY):
            if self.fragments_opcode is not None:
                raise ProtocolError(1002, "A new message started inside a fragmented one")
            self.fragments_opcode = opcode
            self.fragments += payload
        elif opcode == CONTINUATION:
            if self.fragments_opcode is None:
                raise ProtocolError(1002, "Continuation frame without a message")
            self.fragments += payload
        elif opcode == PING:
            self.transport.write(encode_frame(PONG, payload))
            return
        elif opcode == PONG:
            return
        elif opcode == CLOSE:
            self.handle_close(payload)
            return
        else:
            raise ProtocolError(1002, f"Unknown opcode {opcode}")
        if final:
            data, kind = bytes(self.fragments), self.fragments_opcode
            self.fragments.clear()
            self.fragments_opcode = None
            if kind == TEXT:
                try:
                    text = data.decode()
                except UnicodeDecodeError as e:
                    raise ProtocolError(1007, "Text message is not UTF-8") from e
                self.queue.put_nowait({"type": "websocket.receive", "text": text})
            else:
                self.queue.put_nowait({"type": "websocket.receive", "bytes": data})

    def handle_close(self, payload: bytes) -> None:
        code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else 1005
        reason = payload[2:].decode(errors="replace")
        if not self.close_sent:
            self.transport.write(encode_frame(CLOSE, payload[:2]))
            self.close_sent = True
        if not self.disconnected:
            self.disconnected = True
            self.queue.put_nowait({"type": "websocket.disconnect", "code": code, "reason": reason})
        self.transport.close()

    def fail(self, code: int, reason: str) -> None:
        log.warning("WebSocket %s: %s", self.path, reason)
        self.send_close(code, reason)
        if not self.disconnected:
            self.disconnected = True
            self.queue.put_nowait({"type": "websocket.disconnect", "code": code, "reason": reason})
        self.transport.close()
