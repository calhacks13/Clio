"""One /track connection: read messages as they come, track only the newest frame.

From the jev finder, unchanged but for what it drives: track.py's Modes, which follow one target
or, in objects mode, the objects the page names.

The page sends a frame only after the answer to the previous one (or after 500 ms), so normally
one frame waits at a time. When tracking falls behind, a newer frame replaces the waiting
one, which gets no answer. Targets and objects apply in order before the next frame is tracked.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field

from fastapi import WebSocket
from fastapi.concurrency import run_in_threadpool
from starlette.websockets import WebSocketDisconnect, WebSocketDisconnected

from .track import BadMessage, Command, FrameHeader, Modes, parse_command, parse_frame

log = logging.getLogger("clio_tracker")


@dataclass
class Inbox:
    """What the reader has received and the segmenting loop hasn't taken yet."""

    frame: tuple[FrameHeader, bytes] | None = None
    commands: list[Command] = field(default_factory=list)
    dropped: int = 0
    closed: bool = False
    ready: asyncio.Event = field(default_factory=asyncio.Event)

    def put_frame(self, frame: tuple[FrameHeader, bytes]) -> None:
        if self.frame is not None:
            self.dropped += 1
        self.frame = frame
        self.ready.set()

    def put_command(self, command: Command) -> None:
        self.commands.append(command)
        self.ready.set()

    def close(self) -> None:
        self.closed = True
        self.ready.set()

    async def take(self) -> tuple[list[Command], tuple[FrameHeader, bytes] | None]:
        """Waits for anything new, then takes all commands and the newest frame."""
        await self.ready.wait()
        self.ready.clear()
        commands, self.commands = self.commands, []
        frame, self.frame = self.frame, None
        return commands, frame


async def run_stream(websocket: WebSocket, tracker: Modes) -> None:
    await websocket.send_text(json.dumps({"type": "ready", "model": tracker.label}))
    inbox = Inbox()
    reader = asyncio.create_task(read(websocket, inbox))
    answered = 0
    try:
        while not inbox.closed:
            commands, frame = await inbox.take()
            for command in commands:
                tracker.command(command)
            if frame is None:
                continue
            answer = await run_in_threadpool(tracker.step, *frame)
            await websocket.send_text(json.dumps(answer))
            answered += 1
    except (WebSocketDisconnect, WebSocketDisconnected, OSError):
        pass  # the page went away while a frame was being tracked; other errors reach the server
    finally:
        reader.cancel()
        log.info("Track stream closed: %d frames answered, %d dropped", answered, inbox.dropped)


async def read(websocket: WebSocket, inbox: Inbox) -> None:
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            try:
                if message.get("bytes") is not None:
                    inbox.put_frame(parse_frame(message["bytes"]))
                elif message.get("text") is not None:
                    inbox.put_command(parse_command(message["text"]))
            except BadMessage as e:
                log.warning("Track stream: %s", e)
    except (WebSocketDisconnect, WebSocketDisconnected, OSError):
        pass
    finally:
        inbox.close()
