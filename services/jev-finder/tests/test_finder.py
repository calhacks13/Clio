from __future__ import annotations

import httpx
import pytest

from jev_finder.finder import Finder
from jev_finder.jev import JevError, Target


@pytest.fixture
def finder(fake_jev, fake_segmenter):
    finder = Finder(fake_jev.client(), fake_segmenter, "jev-1.14.0")
    yield finder
    finder.close()


def test_one_jev_request_one_encode_one_decode_for_all_objects(
    finder, fake_jev, fake_segmenter, image_b64
):
    fake_jev.present("cap", 0.9, (0.1, 0.1, 0.3, 0.4))
    fake_jev.present("mug", 0.7, (0.5, 0.5, 0.9, 0.9))
    answer, timings = finder.locate(
        "image/jpeg", image_b64(), [Target("cap", "blue cap"), Target("mug", "red mug")]
    )

    assert len(fake_jev.requests) == 1
    assert fake_segmenter.encoded == [(960, 720)]
    assert fake_segmenter.boxes == [[[0.1, 0.1, 0.3, 0.4], [0.5, 0.5, 0.9, 0.9]]]
    assert answer["model"] == "jev-1.14.0+fake-sam"
    cap, mug = answer["detections"]
    assert cap["id"] == "cap" and cap["found"] and cap["confidence"] == 0.9
    assert mug["id"] == "mug" and mug["confidence"] == 0.7
    # The fake mask is the ellipse inscribed in the box: the outline fills it.
    assert cap["box"] == pytest.approx([0.1, 0.1, 0.3, 0.4], abs=0.01)
    assert cap["point"] == pytest.approx([0.2, 0.25], abs=0.01)
    assert 3 <= len(cap["outline"]) <= 64
    assert all(0 <= v <= 1 for xy in cap["outline"] for v in xy)
    assert timings.total_ms >= timings.jev_ms > 0
    assert "jev;dur=" in timings.header() and "total;dur=" in timings.header()


def test_absent_objects_skip_sam(finder, fake_jev, fake_segmenter, image_b64):
    fake_jev.present("cap", 0.04)
    answer, timings = finder.locate("image/jpeg", image_b64(), [Target("cap", "blue cap")])
    assert answer["detections"] == [
        {
            "id": "cap",
            "found": False,
            "point": None,
            "box": None,
            "outline": None,
            "confidence": 0.04,
        }
    ]
    assert fake_segmenter.boxes == []
    assert timings.segment_ms == 0


def test_present_object_with_invalid_box_is_not_found(finder, fake_jev, image_b64):
    fake_jev.present("cap", 0.9, (0.6, 0.2, 0.6, 0.5))  # zero width
    fake_jev.present("mug", 0.9)
    answer, _ = finder.locate(
        "image/jpeg", image_b64(), [Target("cap", "cap"), Target("mug", "mug")]
    )
    cap, mug = answer["detections"]
    assert not cap["found"] and cap["outline"] is None
    assert mug["found"]


def test_empty_mask_falls_back_to_jevs_box(finder, fake_jev, fake_segmenter, image_b64):
    fake_segmenter.empty = True
    fake_jev.present("cap", 0.8, (0.12345, 0.2, 0.4, 0.6))
    (cap,) = finder.locate("image/jpeg", image_b64(), [Target("cap", "cap")])[0]["detections"]
    assert cap == {
        "id": "cap",
        "found": True,
        "point": None,
        "box": [0.1235, 0.2, 0.4, 0.6],
        "outline": None,
        "confidence": 0.8,
    }


def test_padded_frame_boxes_reach_sam_in_picture_coordinates(
    finder, fake_jev, fake_segmenter, image_b64
):
    # 200 x 100 is padded to 280 x 280 for jev; SAM sees the 200 x 100 picture.
    fake_jev.present("cap", 0.9, (40 / 280, 90 / 280, 140 / 280, 190 / 280))
    answer, _ = finder.locate("image/png", image_b64((200, 100), "PNG"), [Target("cap", "cap")])
    (cap,) = answer["detections"]
    assert fake_segmenter.encoded == [(200, 100)]
    assert fake_segmenter.boxes[0][0] == pytest.approx([0, 0, 0.5, 1])
    assert cap["box"] == pytest.approx([0, 0, 0.5, 1], abs=0.02)


def test_jev_failure_fails_the_request_once(finder, fake_jev, image_b64):
    fake_jev.error = httpx.ReadTimeout("slow")
    with pytest.raises(JevError) as raised:
        finder.locate("image/jpeg", image_b64(), [Target("cap", "cap")])
    assert raised.value.status == 504
    assert len(fake_jev.requests) == 1
