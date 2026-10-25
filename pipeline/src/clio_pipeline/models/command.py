"""The command backend: an external image-to-3D command makes the mesh from the object's best crop
($CLIO_MODEL_COMMAND, docs/room-scene.md), and this package scales and places it.

The template is split like a shell would (shlex) but run without one, `{image}`, `{out}` and
`{label}` substituted inside each argument, so a label with spaces or quotes stays one argument
and nothing in it runs. The command must write a GLB at `{out}` within the timeout
(CLIO_MODEL_COMMAND_TIMEOUT, default 900 s) and exit 0. Its GLB is then scaled to the measured
box, each axis on its own when the box was measured (a shape box or an extent), else uniformly to
the height, and moved so its bottom center is the origin, under one new root node: meshes,
materials and textures stay as the command wrote them (`fit_glb`, which the triposr backend
shares). It is assumed to be +y up, as glTF is.
"""

from __future__ import annotations

import shlex
import subprocess
from pathlib import Path

import numpy as np

from ..glb import glb_bounds, transform_glb

MIN_HEIGHT_M = 1e-6
MAX_STRETCH = 20.0  # most an axis is stretched or squeezed against the uniform fit


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
    size: np.ndarray,
    per_axis: bool,
    timeout_s: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Run the command on `image`, fit its GLB to `size` (fit_glb) and write it to `model_path`;
    returns the fitted model's size and each axis's stretch."""
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
        fitted, fitted_size, stretch = fit_glb(data, size, per_axis=per_axis)
    except ValueError as e:
        raise ModelCommandError(str(e)) from e
    model_path.write_bytes(fitted)
    return fitted_size, stretch


def fit_glb(
    data: bytes, size: np.ndarray, *, per_axis: bool
) -> tuple[bytes, np.ndarray, np.ndarray]:
    """`data` (a generator's GLB) fitted to `size`, the measured box, with its bottom center moved
    to the origin: each axis scaled to it (`per_axis`, for a measured box: a single photo is
    weakest about depth), or uniformly to its height. Returns the GLB, the fitted size and each
    axis's stretch against the uniform fit (1 where none). ValueError when it cannot be fitted."""
    try:
        # Accelerate's matmul raises spurious floating point flags; the bounds are checked below.
        with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
            bounds = glb_bounds(data)
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise ValueError(f"its output is not a GLB that can be read ({e})") from e
    if bounds is None:
        raise ValueError("its GLB has no triangles")
    low, high = bounds
    if not (np.isfinite(low).all() and np.isfinite(high).all()):
        raise ValueError("its GLB has positions that are not numbers")
    span = high - low
    if span[1] < MIN_HEIGHT_M:
        raise ValueError("its GLB is flat")
    target = np.asarray(size, dtype=np.float64)
    uniform = float(target[1]) / float(span[1])
    scale = np.full(3, uniform)
    if per_axis:
        # A sliver along one axis is left at the uniform scale rather than blown up.
        sized = (span > MIN_HEIGHT_M) & (target > 0)
        scale[sized] = np.clip(
            target[sized] / span[sized], uniform / MAX_STRETCH, uniform * MAX_STRETCH
        )
    bottom = np.array([(low[0] + high[0]) / 2.0, low[1], (low[2] + high[2]) / 2.0])
    fitted = transform_glb(data, scale=scale.tolist(), translation=(-scale * bottom).tolist())
    return fitted, span * scale, scale / uniform
