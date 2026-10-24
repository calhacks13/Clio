"""The camera frame as jev and YOLOE see it (from the jev finder).

jev takes JPEG or PNG with each side 256 to 1568 px and at least 78,400 px in area, at most
16 MiB, and rejects anything else instead of resizing it. Frames are fitted the way
`jevbench.core.prepare_image` does it: shrunk to fit 1568 px, short sides padded to 280 px.
YOLOE runs on the fitted frame without the padding, so its outline is in 0..1 of the original
frame.
"""

from __future__ import annotations

import base64
import binascii
import io
import sys
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_SIDE = 1568
# 280 x 280 = 78,400 px, so padding the short side to 280 also meets the area rule.
PAD_SIDE = 280
PAD_COLOR = (245, 245, 245)
MAX_BYTES = 16 * 1024 * 1024
JPEG_QUALITY = 95

FORMATS = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}
EXIF_ORIENTATION = 0x0112


class BadImage(ValueError):
    """The request's image can't be used. `status` is the HTTP status to answer with."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Frame:
    image: Image.Image
    """RGB, fitted within 1568 px, no padding. YOLOE runs on this."""
    jpeg: bytes
    """What jev gets: the original JPEG when it already fits, else the padded frame re-encoded."""
    scale: float
    """Fitted size over original size."""
    pad: tuple[int, int]
    """Left and top padding around `image` in the frame jev sees."""
    jev_size: tuple[int, int]

    def from_jev(self, box: list[float]) -> list[float]:
        """A box in 0..1 of the frame jev saw, in 0..1 of `image`, clamped to it."""
        jw, jh = self.jev_size
        w, h = self.image.size
        (px, py) = self.pad
        x0, y0, x1, y1 = box
        return [
            min(1.0, max(0.0, (x0 * jw - px) / w)),
            min(1.0, max(0.0, (y0 * jh - py) / h)),
            min(1.0, max(0.0, (x1 * jw - px) / w)),
            min(1.0, max(0.0, (y1 * jh - py) / h)),
        ]


def plain_pil() -> None:
    """Undo Ultralytics' PIL patch: on an image Pillow can't identify, it tries to install and
    load a HEIF plugin instead of raising UnidentifiedImageError. Frames are JPEG, PNG or WebP."""
    patches = sys.modules.get("ultralytics.utils.patches")
    if patches is not None:
        patches._pil_plugins_registered = True


def decode_frame(mime_type: str, data: str) -> Frame:
    """Decodes a base64 image from a locate request and fits it to jev's size rules."""
    plain_pil()
    expected = FORMATS.get(mime_type)
    if expected is None:
        raise BadImage(f"Unsupported image type {mime_type}: send image/jpeg, png or webp.")
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as e:
        raise BadImage(f"image.data is not valid base64: {e}") from e
    try:
        source = Image.open(io.BytesIO(raw))
        source.load()
    except Image.DecompressionBombError as e:
        raise BadImage(f"image.data is too large to decode: {e}", 413) from e
    except (UnidentifiedImageError, OSError) as e:
        raise BadImage(f"image.data is not a readable {mime_type} image.") from e
    if source.format != expected:
        raise BadImage(f"image.data is {source.format}, not {mime_type}.")
    return fit_frame(source, raw)


def fit_frame(source: Image.Image, raw: bytes | None = None) -> Frame:
    rotated = source.getexif().get(EXIF_ORIENTATION, 1) != 1
    image = ImageOps.exif_transpose(source).convert("RGB")
    width, height = image.size
    scale = min(1.0, MAX_SIDE / max(width, height))
    if scale < 1:
        size = (max(1, round(width * scale)), max(1, round(height * scale)))
        image = image.resize(size, Image.Resampling.LANCZOS)
    w, h = image.size
    jev_size = (max(PAD_SIDE, w), max(PAD_SIDE, h))
    pad = ((jev_size[0] - w) // 2, (jev_size[1] - h) // 2)

    untouched = scale == 1 and not rotated and image.size == jev_size
    if raw is not None and source.format == "JPEG" and untouched:
        jpeg = raw
    else:
        framed = image
        if jev_size != image.size:
            framed = Image.new("RGB", jev_size, PAD_COLOR)
            framed.paste(image, pad)
        buffer = io.BytesIO()
        framed.save(buffer, "JPEG", quality=JPEG_QUALITY)
        jpeg = buffer.getvalue()
    if len(jpeg) > MAX_BYTES:
        raise BadImage(f"The frame is {len(jpeg)} bytes as JPEG; jev takes at most 16 MiB.", 413)
    return Frame(image=image, jpeg=jpeg, scale=w / width, pad=pad, jev_size=jev_size)
