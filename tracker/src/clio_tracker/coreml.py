"""The vision graph on the Apple Neural Engine.

`CoreMLGraph.load_or_export` converts the PyTorch graph to an ML Program once and caches it next
to the weights (`models/<model>.mlpackage`). The cache is redone when Ultralytics or the export
format changes. Measured on an M5 (24 GB): YOLOE-26L 25 ms a frame on CPU_AND_NE, YOLOE-26S
20 ms. The CPU_AND_GPU path aborted inside MPSGraph when compiling this graph, so it is not used.
"""

from __future__ import annotations

import json
import platform
import shutil
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn

from .vision import INPUT_SIZE, OUTPUT_NAMES, VisionGraph

# Bump when VisionGraph's inputs or outputs change, so cached packages are re-exported.
EXPORT_VERSION = 1


def coreml_available() -> bool:
    if sys.platform != "darwin" or platform.machine() != "arm64":
        return False
    try:
        import coremltools  # noqa: F401
    except ImportError:
        return False
    return True


class CoreMLGraph:
    def __init__(self, path: Path):
        import coremltools as ct

        self.path = path
        self.model = ct.models.MLModel(str(path), compute_units=ct.ComputeUnit.CPU_AND_NE)
        self.name = "coreml-ane"

    def run(self, image: np.ndarray) -> dict[str, np.ndarray]:
        out = self.model.predict({"image": image})
        return {n: np.asarray(out[n], dtype=np.float32) for n in OUTPUT_NAMES}

    @classmethod
    def load_or_export(cls, net: nn.Module, stem: Path) -> CoreMLGraph:
        path = stem.with_suffix(".mlpackage")
        meta = stem.with_suffix(".mlpackage.json")
        want = _stamp()
        if not path.exists() or not meta.exists() or json.loads(meta.read_text()) != want:
            print(f"clio-tracker: exporting {stem.name} to Core ML (once, about a minute)...")
            export(net, path)
            meta.write_text(json.dumps(want))
        return cls(path)


def export(net: nn.Module, path: Path, size: int = INPUT_SIZE) -> None:
    """Trace the vision graph on the CPU in float32 and convert it to a float16 ML Program."""
    import coremltools as ct

    _patch_scalar_cast()
    graph = VisionGraph(net, size).eval().requires_grad_(False)
    example = torch.rand(1, 3, size, size)
    with torch.no_grad():
        traced = torch.jit.trace(graph, example)
    model = ct.convert(
        traced,
        inputs=[ct.TensorType(name="image", shape=(1, 3, size, size))],
        outputs=[ct.TensorType(name=n) for n in OUTPUT_NAMES],
        convert_to="mlprogram",
        compute_precision=ct.precision.FLOAT16,
        minimum_deployment_target=ct.target.macOS15,
    )
    tmp = path.with_suffix(".tmp.mlpackage")
    shutil.rmtree(tmp, ignore_errors=True)
    model.save(str(tmp))
    shutil.rmtree(path, ignore_errors=True)
    tmp.rename(path)


def _stamp() -> dict[str, object]:
    import coremltools as ct
    import ultralytics

    return {
        "export": EXPORT_VERSION,
        "ultralytics": ultralytics.__version__,
        "coremltools": ct.__version__,
    }


def _patch_scalar_cast() -> None:
    """coremltools 9.0 casts a folded one-element tensor with int(array), which NumPy 2 rejects.

    YOLO26's attention blocks trace a few such casts (shape arithmetic); fold them to a scalar.
    """
    import coremltools.converters.mil.frontend.torch.ops as ops

    if getattr(ops._cast, "_clio_patched", False):
        return
    original = ops._cast

    def _cast(context, node, dtype, dtype_name):
        x = ops._get_inputs(context, node, expected=1)[0]
        if x.can_be_folded_to_const() and np.ndim(x.val) > 0 and np.size(x.val) == 1:
            context.add(ops.mb.const(val=dtype(np.asarray(x.val).reshape(-1)[0]), name=node.name))
            return
        original(context, node, dtype, dtype_name)

    _cast._clio_patched = True
    ops._cast = _cast
