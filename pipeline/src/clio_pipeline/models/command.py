"""The command backend: an external image-to-3D command makes the mesh from the object's best crop
($CLIO_MODEL_COMMAND, docs/room-scene.md), and this package scales and places it.

The template is split like a shell would (shlex) but run without one, `{image}`, `{out}` and
`{label}` substituted inside each argument, so a label with spaces or quotes stays one argument
and nothing in it runs. The command must write a GLB at `{out}` within the timeout
(CLIO_MODEL_COMMAND_TIMEOUT, default 900 s) and exit 0. Its GLB is then scaled uniformly so its
bounds are the measured height and moved so their bottom center is the origin, under one new root
node: meshes, materials and textures stay as the command wrote them (glb.transform_glb). It is
assumed to be +y up, as glTF is.
"""

from __future__ import annotations

import shlex
import subprocess
from pathlib import Path

import numpy as np

from ..glb import glb_bounds, transform_glb

MIN_HEIGHT_M = 1e-6


class ModelCommandError(RuntimeError):
    """The command did not leave a usable GLB."""


def command_args(template: str, *, image: Path, out: Path, label: str) -> list[str]:
    try:
        args = shlex.split(template)
    except ValueError as e:
        raise ModelCommandError(f"CLIO_MODEL_COMMAND cannot be split: {e}") from e
    if not args:
        raise ModelCommandError("CLIO_MODEL_COMMAND is empty")
    values = {"{image}": str(image), "{out}": str(out), "{label}": label}
    out_args = []
    for arg in args:
        for key, value in values.items():
            arg = arg.replace(key, value)
        out_args.append(arg)
    return out_args


def make_command_model(
    template: str,
    *,
    image: Path,
    label: str,
    model_path: Path,
    height: float,
    timeout_s: float,
) -> np.ndarray:
    """Run the command on `image`, fit its GLB to `height` and write it to `model_path`; returns
    the fitted model's size."""
    scratch = model_path.with_name(f".{model_path.stem}.command.glb")
    scratch.unlink(missing_ok=True)
    args = command_args(template, image=image.resolve(), out=scratch.resolve(), label=label)
    try:
        # In the caller's working directory, so a relative command path in the template works.
        run = subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout_s,
            check=False,
        )
    except FileNotFoundError as e:
        raise ModelCommandError(f"{args[0]} was not found") from e
    except subprocess.TimeoutExpired as e:
        scratch.unlink(missing_ok=True)
        raise ModelCommandError(f"no GLB within {timeout_s:g} s") from e
    try:
        if run.returncode != 0:
            tail = " ".join(run.stderr.decode("utf-8", "replace").split())[-300:]
            raise ModelCommandError(
                f"it exited with {run.returncode}" + (f": {tail}" if tail else "")
            )
        if not scratch.is_file():
            raise ModelCommandError("it wrote no GLB at {out}")
        data = scratch.read_bytes()
    finally:
        scratch.unlink(missing_ok=True)
    try:
        # Accelerate's matmul raises spurious floating point flags; the bounds are checked below.
        with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
            bounds = glb_bounds(data)
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise ModelCommandError(f"its output is not a GLB that can be read ({e})") from e
    if bounds is None:
        raise ModelCommandError("its GLB has no triangles")
    low, high = bounds
    if not (np.isfinite(low).all() and np.isfinite(high).all()):
        raise ModelCommandError("its GLB has positions that are not numbers")
    span = high - low
    if span[1] < MIN_HEIGHT_M:
        raise ModelCommandError("its GLB is flat")
    scale = float(height) / float(span[1])
    bottom = np.array([(low[0] + high[0]) / 2.0, low[1], (low[2] + high[2]) / 2.0])
    model_path.write_bytes(transform_glb(data, scale=scale, translation=(-scale * bottom).tolist()))
    return span * scale
