"""Choosing the segmenter: EdgeTAM when it loads, else SAM 2.1 Small."""

from __future__ import annotations

import pytest

import jev_finder.edgetam
import jev_finder.segmenter
from jev_finder.segmenter import load_segmenter


class Loaded:
    def __init__(self, device="auto", track=None):
        self.device, self.track = device, track


@pytest.fixture
def no_edgetam(monkeypatch):
    def missing(*args, **kwargs):
        raise FileNotFoundError("No EdgeTAM checkpoint.")

    monkeypatch.setattr(jev_finder.edgetam, "EdgeTam", missing)
    monkeypatch.setattr(jev_finder.segmenter, "Segmenter", Loaded)


def test_auto_falls_back_to_sam_when_edgetam_cannot_load(no_edgetam):
    assert isinstance(load_segmenter("auto", "mps"), Loaded)


def test_asking_for_edgetam_fails_loudly(no_edgetam):
    with pytest.raises(FileNotFoundError):
        load_segmenter("edgetam")


def test_edgetam_is_preferred(monkeypatch):
    monkeypatch.setattr(jev_finder.edgetam, "EdgeTam", Loaded)
    loaded = load_segmenter("auto", "mps", "box")
    assert (loaded.device, loaded.track) == ("mps", "box")


def test_unknown_segmenter():
    with pytest.raises(ValueError):
        load_segmenter("sam3")
