"""Writes every jev call to a folder, for looking at what jev was asked and what it answered.

On with CLIO_TRACKER_JEV_DUMP=<folder>. Each call leaves `<time>-<n>.jpg`, the frame exactly as
jev saw it with jev's boxes drawn on it (green: present, with its id and Noul probability), and
`<time>-<n>.json` with the Noul and Box instructions sent per object and the answers. Off by
default: a lesson makes a call a second per object.
"""

from __future__ import annotations

import io
import json
import logging
import time
from dataclasses import asdict
from pathlib import Path

from PIL import Image, ImageDraw

from .jev import Answer, Target, instructions

log = logging.getLogger("clio_tracker")


class JevDump:
    def __init__(self, folder: Path):
        self.folder = folder
        self.folder.mkdir(parents=True, exist_ok=True)
        self.count = 0

    def write(
        self,
        jpeg: bytes,
        targets: list[Target],
        answers: list[Answer] | None,
        error: str | None,
        took_s: float,
    ) -> None:
        self.count += 1
        stem = f"{time.strftime('%H%M%S')}-{self.count:04d}"
        record = {
            "took_s": round(took_s, 3),
            "error": error,
            "objects": [],
        }
        for i, target in enumerate(targets):
            present, box = instructions(target)
            answer = answers[i] if answers is not None and i < len(answers) else None
            record["objects"].append(
                {
                    "id": target.id,
                    "phrase": target.phrase,
                    "query": target.query,
                    "asked_present": present,
                    "asked_box": box,
                    "answer": asdict(answer) if answer is not None else None,
                }
            )
        try:
            (self.folder / f"{stem}.json").write_text(json.dumps(record, indent=1))
            with Image.open(io.BytesIO(jpeg)) as im:
                im = im.convert("RGB")
                draw = ImageDraw.Draw(im)
                w, h = im.size
                for i, target in enumerate(targets):
                    answer = answers[i] if answers is not None and i < len(answers) else None
                    label = (
                        f"{target.id} {answer.presence:.2f}"
                        if answer and answer.presence is not None
                        else f"{target.id} ?"
                    )
                    if answer is not None and answer.box:
                        x0, y0, x1, y1 = answer.box
                        rect = (x0 * w, y0 * h, x1 * w, y1 * h)
                        draw.rectangle(rect, outline=(0, 255, 0), width=3)
                        draw.text((rect[0] + 4, max(0, rect[1] - 14)), label, fill=(0, 255, 0))
                    else:
                        why = f": {answer.problem}" if answer and answer.problem else ""
                        draw.text((6, 6 + 14 * i), f"{label} (no box{why})", fill=(255, 80, 80))
                im.save(self.folder / f"{stem}.jpg", quality=85)
        except OSError as e:
            log.warning("jev dump: %s", e)
