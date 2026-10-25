# TripoSR for Clio's object models

`clio scene --models triposr` (the default) turns each object's best camera crop into a 3D mesh
with [TripoSR](https://github.com/VAST-AI-Research/TripoSR) (MIT; weights
`stabilityai/TripoSR`). It runs here, in its own environment, so the pipeline stays numpy-only.
The design is in [docs/room-scene.md](../../../docs/room-scene.md).

```bash
pipeline/tools/triposr/setup.sh   # once: TripoSR's source, this environment, the weights (~1.9 GB)
```

`setup.sh` fetches TripoSR at the commit it pins into `.vendor/`, creates `.venv/` with uv, and
loads the model once, which downloads its weights into the Hugging Face cache and rembg's
background remover into `~/.rembg`. Run it again after changing the commit.

`clio_triposr.py` is what the pipeline starts, once per scene build (`--serve`: one JSON job per
line on stdin, one JSON answer per line on stdout). By hand:

```bash
cd pipeline/tools/triposr
.venv/bin/python clio_triposr.py --image crop.jpg --out model.glb          # rembg cuts it out
.venv/bin/python clio_triposr.py --image crop.jpg --mask mask.png --out model.glb
```

- Marching cubes on a 128 grid by default (`--mc-resolution`, or `CLIO_TRIPOSR_RESOLUTION` for
  scene builds): about 5 s an object on an Apple silicon GPU, plus about 10 s to load the model.
- `--device auto` picks CUDA, then Apple's MPS, then the CPU (`CLIO_TRIPOSR_DEVICE`). An operation
  MPS lacks moves the rest of the run to the CPU.
- TripoSR asks for `torchmcubes`, a C++/CUDA build; this tool answers its calls with PyMCubes,
  which has wheels.
- The mesh comes out in Clio's model frame: +y up, the side the crop saw facing +z, at TripoSR's
  own scale with its vertex colors. The pipeline fits it to the object's measured box.
