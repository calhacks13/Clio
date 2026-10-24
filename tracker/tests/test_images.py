"""Fitting frames to jev's size rules (from the jev finder, unchanged)."""

from __future__ import annotations

import base64
import io

import pytest
from PIL import Image

from clio_tracker.images import BadImage, decode_frame, fit_frame


def jev_image(frame) -> Image.Image:
    image = Image.open(io.BytesIO(frame.jpeg))
    assert image.format == "JPEG"
    return image


def test_quest_frame_is_sent_to_jev_as_is(image_b64):
    data = image_b64((1280, 960))
    frame = decode_frame("image/jpeg", data)
    assert frame.jpeg == base64.b64decode(data)
    assert frame.image.size == frame.jev_size == (1280, 960)
    assert frame.scale == 1 and frame.pad == (0, 0)
    assert frame.from_jev([0.1, 0.2, 0.5, 0.6]) == pytest.approx([0.1, 0.2, 0.5, 0.6])


def test_large_frame_shrinks_to_1568(image_b64):
    frame = decode_frame("image/jpeg", image_b64((4000, 3000)))
    assert frame.image.size == frame.jev_size == (1568, 1176)
    assert jev_image(frame).size == (1568, 1176)
    assert frame.scale == pytest.approx(1568 / 4000)
    assert frame.pad == (0, 0)


def test_small_frame_is_padded_to_280_and_boxes_map_back(image_b64):
    frame = decode_frame("image/png", image_b64((200, 100), "PNG"))
    assert frame.image.size == (200, 100)
    assert frame.jev_size == (280, 280) and frame.pad == (40, 90)
    assert jev_image(frame).size == (280, 280)
    # jev's box around exactly the picture is the whole picture for SAM.
    assert frame.from_jev([40 / 280, 90 / 280, 240 / 280, 190 / 280]) == pytest.approx([0, 0, 1, 1])
    # A box reaching into the padding is clamped to the picture.
    assert frame.from_jev([0, 0, 0.5, 0.5]) == pytest.approx([0, 0, 0.5, 0.5])


def test_every_side_ends_up_between_256_and_1568(image_b64):
    for size in [(3000, 200), (100, 2400), (300, 255), (1568, 1568), (10000, 50)]:
        frame = decode_frame("image/png", image_b64(size, "PNG"))
        width, height = jev_image(frame).size
        assert 256 <= width <= 1568 and 256 <= height <= 1568, size
        assert width * height >= 78_400


def test_webp_and_png_are_converted_to_jpeg(image_b64):
    for mime, fmt in [("image/webp", "WEBP"), ("image/png", "PNG")]:
        frame = decode_frame(mime, image_b64((640, 480), fmt))
        assert jev_image(frame).size == (640, 480)


def test_exif_rotation_is_applied():
    buffer = io.BytesIO()
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees clockwise to display
    Image.new("RGB", (640, 480), (10, 20, 30)).save(buffer, "JPEG", exif=exif)
    frame = fit_frame(Image.open(io.BytesIO(buffer.getvalue())), buffer.getvalue())
    assert frame.image.size == (480, 640)
    assert jev_image(frame).size == (480, 640)
    assert frame.jpeg != buffer.getvalue()


@pytest.mark.parametrize(
    ("mime", "data", "message"),
    [
        ("image/gif", "R0lGOD", "Unsupported image type"),
        ("image/jpeg", "not base64!", "not valid base64"),
        ("image/jpeg", base64.b64encode(b"hello").decode(), "not a readable"),
    ],
)
def test_unusable_images_are_refused(mime, data, message):
    with pytest.raises(BadImage, match=message) as raised:
        decode_frame(mime, data)
    assert raised.value.status == 422


def test_declared_type_must_match(image_b64):
    with pytest.raises(BadImage, match="is PNG, not image/jpeg"):
        decode_frame("image/jpeg", image_b64((300, 300), "PNG"))
