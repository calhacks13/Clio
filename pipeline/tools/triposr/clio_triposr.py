"""TripoSR as Clio's object model generator (docs/room-scene.md): a crop of an object in, a GLB out.

It runs in this folder's own environment (pyproject.toml, set up by setup.sh) so the pipeline stays
numpy-only. `clio scene --models triposr` starts it once per build with --serve and writes one JSON
line per object to its stdin:

    {"image": "<crop.jpg>", "mask": "<mask.png>" or null, "out": "<model.glb>"}

and reads one JSON line back per job: {"ok": true, "vertices": n, "faces": n, "seconds": s,
"device": d} or {"ok": false, "error": "..."}. Logs go to stderr.

The model is TripoSR (VAST-AI-Research/TripoSR at the commit setup.sh pins, MIT; weights
stabilityai/TripoSR). The mask is the tracker's outline of the object in the crop; without one,
rembg (REMBG_MODEL) cuts the object out. The surface comes from marching cubes on a 128 grid by default
(--mc-resolution), through PyMCubes instead of torchmcubes, which needs a C++/CUDA build. The mesh
is turned from TripoSR's frame (z up, the input camera on +x) into Clio's model frame (y up, the
side the crop saw facing +z) and keeps TripoSR's vertex colors. Scaling it to the measured size
and placing it is the pipeline's job.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import types
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
VENDOR = HERE / ".vendor" / "TripoSR"
MODEL_ID = "stabilityai/TripoSR"
# Clio's model frame from TripoSR's: x <- y, y <- z (up), z <- x (toward the input camera).
CLIO_FROM_TRIPOSR = np.array([[0, 1, 0, 0], [0, 0, 1, 0], [1, 0, 0, 0], [0, 0, 0, 1]], float)
GRAY = 0.5  # the background TripoSR was trained with
# rembg's general model (about 170 MB). Its default became a 1 GB one; most crops come with the
# tracker's outline as their mask anyway.
REMBG_MODEL = "isnet-general-use"


def log(message: str) -> None:
    print(f"triposr: {message}", file=sys.stderr, flush=True)


def _stub_torchmcubes() -> None:
    """TripoSR imports torchmcubes.marching_cubes; this one answers the same with PyMCubes."""
    import mcubes
    import torch

    def marching_cubes(level: torch.Tensor, threshold: float):
        grid = level.detach().cpu().numpy().astype(np.float64)
        vertices, faces = mcubes.marching_cubes(grid, float(threshold))
        # torchmcubes gives (x, y, z) as (k, j, i); TripoSR's helper swaps them back.
        vertices = np.ascontiguousarray(vertices[:, ::-1], dtype=np.float32)
        return torch.from_numpy(vertices), torch.from_numpy(faces.astype(np.int64))

    module = types.ModuleType("torchmcubes")
    module.marching_cubes = marching_cubes  # type: ignore[attr-defined]
    sys.modules["torchmcubes"] = module


def pick_device(name: str) -> str:
    import torch

    if name != "auto":
        return name
    if torch.cuda.is_available():
        return "cuda:0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class Generator:
    def __init__(self, *, device: str, mc_resolution: int, chunk_size: int, ratio: float) -> None:
        if not (VENDOR / "tsr").is_dir():
            raise RuntimeError(f"TripoSR's source is missing from {VENDOR}: run setup.sh")
        sys.path.insert(0, str(VENDOR))
        _stub_torchmcubes()
        try:
            import rembg

            self.rembg: Any = rembg
        except ImportError:  # tsr.utils imports it; without it only masked crops work
            sys.modules["rembg"] = types.ModuleType("rembg")
            self.rembg = None
        from tsr.system import TSR

        started = time.perf_counter()
        self.device = pick_device(device)
        self.model = TSR.from_pretrained(MODEL_ID, config_name="config.yaml", weight_name="model.ckpt")
        self.model.renderer.set_chunk_size(chunk_size)
        self.model.to(self.device)
        self.mc_resolution = mc_resolution
        self.ratio = ratio
        self.session: Any = None
        log(f"{MODEL_ID} on {self.device} in {time.perf_counter() - started:.1f} s")

    def prepare(self, image_path: str, mask_path: str | None):
        from PIL import Image
        from tsr.utils import resize_foreground

        image = Image.open(image_path).convert("RGB")
        if mask_path:
            rgba = image.copy()
            rgba.putalpha(Image.open(mask_path).convert("L").resize(image.size))
        elif self.rembg is not None:
            if self.session is None:
                self.session = self.rembg.new_session(REMBG_MODEL)
            rgba = self.rembg.remove(image, session=self.session).convert("RGBA")
        else:
            raise RuntimeError("no mask and no rembg to cut the object out")
        if np.asarray(rgba)[..., 3].max() == 0:
            raise RuntimeError("nothing of the object is left after cutting it out")
        rgba = resize_foreground(rgba, self.ratio)
        pixels = np.asarray(rgba).astype(np.float32) / 255.0
        rgb = pixels[..., :3] * pixels[..., 3:4] + (1.0 - pixels[..., 3:4]) * GRAY
        return Image.fromarray((rgb * 255.0).round().astype(np.uint8))

    def mesh(self, image):
        import torch

        with torch.no_grad():
            codes = self.model([image], device=self.device)
            return self.model.extract_mesh(codes, True, resolution=self.mc_resolution)[0]

    def generate(self, job: dict[str, Any]) -> dict[str, Any]:
        started = time.perf_counter()
        image = self.prepare(job["image"], job.get("mask"))
        try:
            mesh = self.mesh(image)
        except (RuntimeError, NotImplementedError) as e:
            if self.device != "mps":
                raise
            # An operation MPS lacks: the rest of the build runs on the CPU.
            log(f"mps failed ({e}); using the cpu")
            self.device = "cpu"
            self.model.to(self.device)
            mesh = self.mesh(image)
        if len(mesh.faces) == 0:
            raise RuntimeError("TripoSR found no surface")
        mesh.apply_transform(CLIO_FROM_TRIPOSR)
        if mesh.volume < 0:  # outward faces, whatever the marching cubes' winding
            mesh.invert()
        Path(job["out"]).parent.mkdir(parents=True, exist_ok=True)
        mesh.export(job["out"], file_type="glb")
        return {
            "ok": True,
            "vertices": int(len(mesh.vertices)),
            "faces": int(len(mesh.faces)),
            "seconds": round(time.perf_counter() - started, 2),
            "device": self.device,
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--serve", action="store_true", help="answer JSON jobs on stdin")
    parser.add_argument("--warm", action="store_true", help="load the model once and exit")
    parser.add_argument("--image", help="one crop, with --out")
    parser.add_argument("--mask", help="its mask (white: the object), optional")
    parser.add_argument("--out", help="the GLB to write")
    parser.add_argument("--mc-resolution", type=int, default=128, help="marching cubes grid")
    parser.add_argument("--device", default="auto", help="auto, cuda:0, mps or cpu")
    parser.add_argument("--chunk-size", type=int, default=8192)
    parser.add_argument("--foreground-ratio", type=float, default=0.85)
    args = parser.parse_args(argv)
    if not (args.serve or args.warm or (args.image and args.out)):
        parser.error("give --serve, --warm, or --image and --out")

    generator = Generator(
        device=args.device,
        mc_resolution=args.mc_resolution,
        chunk_size=args.chunk_size,
        ratio=args.foreground_ratio,
    )
    if args.warm:
        if generator.rembg is not None:
            generator.rembg.new_session(REMBG_MODEL)  # downloads the background remover's weights
        print(json.dumps({"ok": True, "device": generator.device}), flush=True)
        return 0
    if not args.serve:
        print(json.dumps(generator.generate({"image": args.image, "mask": args.mask, "out": args.out})))
        return 0
    print(json.dumps({"ok": True, "ready": True, "device": generator.device}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            answer = generator.generate(json.loads(line))
        except Exception as e:  # one object's failure is its own; the next job still runs
            answer = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(answer), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
