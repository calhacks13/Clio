# Third-party code and models

Nothing below is committed here. `python -m jev_finder.setup_models` fetches the two models into
`models/` (gitignored), at pinned versions, and `uv sync` installs the packages.

| What                                                                       | Version                                             | License    |
| -------------------------------------------------------------------------- | --------------------------------------------------- | ---------- |
| [EdgeTAM](https://github.com/facebookresearch/EdgeTAM) code and checkpoint | commit `7711e012a30a2402c4eaab637bdb00a521302c91`   | Apache 2.0 |
| [SAM 2.1 Hiera Small](https://huggingface.co/facebook/sam2.1-hiera-small)  | revision `ee5bba1d82bb8749febdf90f45e84b687142ba03` | Apache 2.0 |

EdgeTAM segments and tracks by default; SAM 2.1 Small takes over when EdgeTAM can't load.

EdgeTAM's README states that its checkpoints and code are licensed under Apache 2.0 (its
`LICENSE` file); the checkpoint is `checkpoints/edgetam.pt` in the repository, SHA-256
`ed2d4850b8792c239689b043c47046ec239b6e808a3d9b6ae676c803fd8780df`. The SAM 2.1 model card on
Hugging Face lists Apache 2.0. The repository is put on the import path, not installed or
changed.

Python packages, from PyPI through `uv sync` (versions in `uv.lock`): PyTorch and torchvision
(BSD-3-Clause), transformers and huggingface_hub (Apache 2.0), FastAPI (MIT), Starlette
(BSD-3-Clause), uvicorn (BSD-3-Clause), httpx (BSD-3-Clause), Pillow (MIT-CMU), NumPy and SciPy
(BSD-3-Clause), python-dotenv (BSD-3-Clause), and EdgeTAM's dependencies hydra-core (MIT),
omegaconf (BSD-3-Clause), iopath (MIT), timm (Apache 2.0) and einops (MIT).

`jev_finder/bench.py` holds four small helpers copied from the Jev fun workbench (`jevbench`),
the author's own unpublished benchmark; see its header.

jev is TypeSafe's hosted model (api.typesafe.ai), called with your own key under TypeSafe's terms.
