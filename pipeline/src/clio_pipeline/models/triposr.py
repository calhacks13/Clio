"""The triposr backend: TripoSR makes a mesh from each object's best crop, and this package scales
and places it (docs/room-scene.md, "Object models").

TripoSR runs in its own environment (pipeline/tools/triposr, set up once with its setup.sh), so the
pipeline stays numpy-only. One process serves a whole build: it is started at the first object
that needs it (`clio_triposr.py --serve`, which loads the model once) and given one object at a
time: the best crop, the tracker's outline on it as the mask when the crop came from an
observation (TripoSR's rembg cuts the object out otherwise), and where to write the GLB. Its mesh
comes back in the model frame (+y up, the side the crop saw facing +z) at TripoSR's own scale and
is fitted to the measured box with its bottom center at the origin, like the command backend's
(command.fit_glb): each axis on its own for a shape box or an extent, since one photo says least
about depth, else uniformly to the height.

Settings (environment): CLIO_TRIPOSR_RESOLUTION, the marching cubes grid (default 128: fast, a
few seconds an object on a laptop); CLIO_TRIPOSR_DEVICE (auto: CUDA, else Apple's MPS, else the
CPU); CLIO_TRIPOSR_DIR, where the tool lives; CLIO_TRIPOSR_TIMEOUT, seconds per object.
"""

from __future__ import annotations

import json
import queue
import subprocess
import threading
from collections import deque
from pathlib import Path
from typing import IO, Any

import numpy as np
from PIL import Image, ImageDraw

from .command import fit_glb
from .settings import ModelSettings
from .views import View

STARTUP_TIMEOUT_S = 900.0  # loading the model; the first run without setup.sh also downloads it
STDERR_KEPT = 20  # lines of the tool's log kept for an error message


class TriposrError(RuntimeError):
    """TripoSR could not make a model."""


class TriposrWorker:
    """The TripoSR process of one build: started on the first `make`, stopped by `close`."""

    def __init__(self, settings: ModelSettings) -> None:
        self.settings = settings
        self.process: subprocess.Popen[str] | None = None
        self.answers: queue.Queue[str | None] = queue.Queue()
        self.log: deque[str] = deque(maxlen=STDERR_KEPT)
        self.device: str | None = None
        self.broken: str | None = None  # why it cannot be used for the rest of the build

    @property
    def generator(self) -> str:
        return f"TripoSR (grid {self.settings.triposr_resolution})"

    def make(self, image: Path, mask: Path | None, out: Path) -> dict[str, Any]:
        """One object: the GLB at `out`; TripoSR's answer (vertices, faces, seconds, device)."""
        if self.broken is not None:
            raise TriposrError(self.broken)
        if self.process is None:
            self._start()
        job = {"image": str(image), "mask": str(mask) if mask else None, "out": str(out)}
        answer = self._ask(json.dumps(job), self.settings.triposr_timeout_s)
        if not answer.get("ok"):
            raise TriposrError(str(answer.get("error") or "it failed without saying why"))
        return answer

    def close(self) -> None:
        process, self.process = self.process, None
        if process is None:
            return
        if process.stdin is not None:
            process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

    def _start(self) -> None:
        tool = self.settings.triposr_dir
        python = tool / ".venv" / "bin" / "python"
        if not python.is_file() or not (tool / ".vendor" / "TripoSR").is_dir():
            self.broken = f"TripoSR is not set up: run {tool / 'setup.sh'}"
            raise TriposrError(self.broken)
        args = [
            str(python),
            str(tool / "clio_triposr.py"),
            "--serve",
            "--mc-resolution",
            str(self.settings.triposr_resolution),
            "--device",
            self.settings.triposr_device,
        ]
        self.process = subprocess.Popen(
            args,
            cwd=tool,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        assert self.process.stdout is not None and self.process.stderr is not None
        threading.Thread(target=self._lines, args=(self.process.stdout,), daemon=True).start()
        threading.Thread(target=self._stderr, args=(self.process.stderr,), daemon=True).start()
        try:
            ready = self._wait(STARTUP_TIMEOUT_S)
        except TriposrError as e:
            self.broken = f"TripoSR did not start: {e}"
            self.close()
            raise TriposrError(self.broken) from e
        self.device = ready.get("device")

    def _ask(self, line: str, timeout_s: float) -> dict[str, Any]:
        process = self.process
        assert process is not None and process.stdin is not None
        try:
            process.stdin.write(line + "\n")
            process.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            self.broken = f"TripoSR stopped answering: it exited{self._tail()}"
            raise TriposrError(self.broken) from e
        try:
            return self._wait(timeout_s)
        except TriposrError as e:
            # A stuck or dead process cannot answer the next object either.
            self.broken = f"TripoSR stopped answering: {e}"
            self.close()
            raise TriposrError(self.broken) from e

    def _wait(self, timeout_s: float) -> dict[str, Any]:
        try:
            text = self.answers.get(timeout=timeout_s)
        except queue.Empty as e:
            raise TriposrError(f"no answer within {timeout_s:g} s") from e
        if text is None:
            raise TriposrError(f"it exited{self._tail()}")
        try:
            answer = json.loads(text)
        except json.JSONDecodeError as e:
            raise TriposrError(f"it answered something else: {text[:200]}") from e
        if not isinstance(answer, dict):
            raise TriposrError(f"it answered something else: {text[:200]}")
        return answer

    def _lines(self, stream: IO[str]) -> None:
        for line in stream:
            if line.strip():
                self.answers.put(line)
        self.answers.put(None)

    def _stderr(self, stream: IO[str]) -> None:
        for line in stream:
            if line.strip():
                self.log.append(line.strip())

    def _tail(self) -> str:
        """ ": <the tool's last log line>", or nothing without one."""
        return f": {self.log[-1]}" if self.log else ""


def make_triposr_model(
    worker: TriposrWorker,
    view: View,
    *,
    stem: str,
    out_dir: Path,
    size: np.ndarray,
    per_axis: bool,
) -> tuple[np.ndarray, np.ndarray]:
    """The model of the object `view` shows, from TripoSR, fitted to `size` (command.fit_glb) and
    written to model-<stem>.glb in `out_dir`; returns its fitted size and each axis's stretch."""
    if view.crop is None:
        raise TriposrError("no crop to give it")
    image = out_dir / f".{stem}.triposr-in.png"
    mask = out_dir / f".{stem}.triposr-mask.png" if view.outline is not None else None
    raw = out_dir / f".{stem}.triposr.glb"
    try:
        view.crop.convert("RGB").save(image)
        if mask is not None:
            outline_mask(view).save(mask)
        worker.make(image, mask, raw)
        if not raw.is_file():
            raise TriposrError("it wrote no GLB")
        data, fitted, stretch = fit_glb(raw.read_bytes(), size, per_axis=per_axis)
    finally:
        for path in (image, mask, raw):
            if path is not None:
                path.unlink(missing_ok=True)
    (out_dir / f"model-{stem}.glb").write_bytes(data)
    return fitted, stretch


def outline_mask(view: View) -> Image.Image:
    """The tracker's outline filled white on black, in the crop's pixels."""
    assert view.crop is not None and view.outline is not None
    points = view.box_in_crop(view.outline)
    mask = Image.new("L", view.crop.size, 0)
    ImageDraw.Draw(mask).polygon([tuple(p) for p in points.tolist()], fill=255)
    return mask
