"""RegionFollower: a mask carried to every frame by its own pixels' motion, or the camera's."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from clio_tracker.follow import FollowParams, RegionFollower
from clio_tracker.geometry import iou
from clio_tracker.vision import MaskCrop

W, H = 480, 360
PATCH_W, PATCH_H = 120, 80
MARGIN = 256  # the background is this much larger than the view on every side, for pans
Path = tuple[float, float] | list[tuple[float, float]]


def texture(rows: int, cols: int, seed: int) -> np.ndarray:
    noise = np.random.default_rng(seed).integers(0, 255, (rows, cols), dtype=np.uint8)
    return cv2.blur(noise, (3, 3))


BACKGROUND = texture(H + 2 * MARGIN, W + 2 * MARGIN, 0)
PATCH = texture(PATCH_H, PATCH_W, 1)


def offsets(path: Path, frames: int) -> list[tuple[float, float]]:
    """Each frame's offset from the first: `path` itself when it is a list, else `path` a frame."""
    return path if isinstance(path, list) else [(k * path[0], k * path[1]) for k in range(frames)]


def scene(
    frames: int,
    move: Path = (0, 0),
    grow: tuple[float, float] = (1, 1),
    pan: Path = (0, 0),
    start: tuple[float, float] = (100, 80),
    flat: bool = False,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Gray frames and the patch's true box on each. The whole picture pans by `pan` (still by
    default); the patch, its top left at `start` on the first frame, moves by `move` on top of the
    pan and grows by `grow` (width, height) a frame about its centre. `pan` and `move` are steps a
    frame, or each frame's offset from the first. A flat patch has no texture."""
    patch = np.full_like(PATCH, 128) if flat else PATCH
    pans, moves = offsets(pan, frames), offsets(move, frames)
    out = []
    for k in range(frames):
        dx, dy = pans[k]
        view = cv2.warpAffine(
            BACKGROUND, np.array([[1.0, 0, dx - MARGIN], [0, 1.0, dy - MARGIN]]), (W, H)
        )
        sx, sy = grow[0] ** k, grow[1] ** k
        cx = start[0] + PATCH_W / 2 + moves[k][0] + dx
        cy = start[1] + PATCH_H / 2 + moves[k][1] + dy
        x1, y1 = cx - sx * PATCH_W / 2, cy - sy * PATCH_H / 2
        # patch pixel centres to frame pixel centres
        a = np.array([[sx, 0, x1 + 0.5 * sx - 0.5], [0, sy, y1 + 0.5 * sy - 0.5]])
        pasted = cv2.warpAffine(patch, a, (W, H))
        inside = cv2.warpAffine(np.ones(patch.shape, np.float32), a, (W, H)) > 0.5
        frame = np.where(inside, pasted, view)
        truth = np.array([x1, y1, x1 + sx * PATCH_W, y1 + sy * PATCH_H], np.float32)
        out.append((frame, truth))
    return out


def filled(box: np.ndarray) -> MaskCrop:
    """A mask filling `box` at one frame pixel per crop pixel, like the fake segmenter's."""
    x1, y1, x2, y2 = (round(float(v)) for v in box)
    return MaskCrop(np.full((y2 - y1, x2 - x1), 10.0, np.float32), (float(x1), float(y1)), 1.0)


def mask_box(crop: MaskCrop) -> np.ndarray:
    """The frame-pixel bounds of a crop's mask (logits > 0)."""
    ys, xs = np.nonzero(crop.logits > 0)
    x0, y0 = crop.origin
    return np.array(
        [
            x0 + xs.min() * crop.scale,
            y0 + ys.min() * crop.scale,
            x0 + (xs.max() + 1) * crop.scale,
            y0 + (ys.max() + 1) * crop.scale,
        ],
        np.float32,
    )


def in_view(box: np.ndarray) -> float:
    w = max(0.0, min(box[2], W) - max(box[0], 0))
    h = max(0.0, min(box[3], H) - max(box[1], 0))
    return w * h / ((box[2] - box[0]) * (box[3] - box[1]))


def area(box: np.ndarray) -> float:
    return float((box[2] - box[0]) * (box[3] - box[1]))


def test_follows_translating_patch_at_iou_above_09():
    frames = scene(30, move=(4, 2))
    f = RegionFollower()
    f.set_reference(0, filled(frames[0][1]))
    outs = [f.step(seq, gray, None, seq / 25) for seq, (gray, _) in enumerate(frames)]
    for out, (_, truth) in zip(outs[10:], frames[10:], strict=True):
        assert out.confident
        assert out.inliers >= FollowParams().min_inliers and out.ratio >= 0.5
        assert iou(out.box, truth)[0, 0] > 0.9
        assert iou(mask_box(out.crop), truth)[0, 0] > 0.9  # the crop's mask is where the box is
        assert max(out.crop.logits.shape) <= 256


def test_camera_motion_alone_carries_when_patch_is_textureless():
    frames = scene(12, pan=(3, 0), flat=True)
    camera = np.array([[1.0, 0, 3], [0, 1.0, 0]])
    f = RegionFollower()
    f.set_reference(0, filled(frames[0][1]))
    for seq, (gray, truth) in enumerate(frames):
        out = f.step(seq, gray, camera, seq / 25)
        assert out is not None and not out.confident
        # 3 px a frame from frame 0, where the mask was measured (no motion applied there)
        np.testing.assert_allclose(out.box, truth, atol=1e-3)


@pytest.mark.parametrize("carried_by", ["camera", "own motion"])
def test_reference_on_older_frame_is_carried_to_now(carried_by):
    if carried_by == "camera":  # no reference until frame 10: only the camera's pan is logged
        frames, camera = scene(11, pan=(4, 2)), np.array([[1.0, 0, 4], [0, 1.0, 2]])
    else:  # following the patch's left half since frame 0, by the patch's own motion
        frames, camera = scene(11, move=(4, 2)), None
    f = RegionFollower()
    if carried_by == "own motion":
        x1, y1, x2, y2 = frames[0][1]
        f.set_reference(0, filled(np.array([x1, y1, (x1 + x2) / 2, y2])))
    for seq in range(10):
        f.step(seq, frames[seq][0], camera, seq / 25)
    f.set_reference(4, filled(frames[4][1]))
    out = f.step(10, frames[10][0], camera, 10 / 25)
    assert f.reference_seq == 4
    assert out.confident
    assert iou(out.box, frames[10][1])[0, 0] > 0.85


def test_reference_older_than_current_is_ignored():
    frames = scene(12)
    x1, y1, x2, y2 = frames[0][1]
    half = filled(np.array([x1, y1, (x1 + x2) / 2, y2]))
    f = RegionFollower()
    for seq in range(10):
        f.step(seq, frames[seq][0], None, seq / 25)
    f.set_reference(8, filled(frames[8][1]))
    f.set_reference(5, half)  # before the newer one was applied
    assert f.reference_seq == 8
    out = f.step(10, frames[10][0], None, 10 / 25)
    assert iou(out.box, frames[10][1])[0, 0] > 0.95
    f.set_reference(5, half)  # after it was applied
    assert f.reference_seq == 8
    out = f.step(11, frames[11][0], None, 11 / 25)
    assert iou(out.box, frames[11][1])[0, 0] > 0.95


def leave(speed: float, frames: int) -> tuple[list, list]:
    """The patch moving `speed` px a frame off the right edge, followed from frame 0."""
    shots = scene(frames, move=(speed, 0), start=(240, 140))
    f = RegionFollower()
    f.set_reference(0, filled(shots[0][1]))
    outs = [f.step(seq, gray, None, seq / 25) for seq, (gray, _) in enumerate(shots)]
    for out in outs:
        assert np.isfinite(out.box).all()
        assert np.isfinite(out.crop.logits).all() and np.isfinite(out.crop.origin).all()
    return outs, [truth for _, truth in shots]


def test_region_leaving_view_is_not_confident():
    outs, truths = leave(40, 12)
    gone = [out for out, truth in zip(outs, truths, strict=True) if in_view(truth) < 0.25]
    assert len(gone) >= 5
    assert not any(out.confident for out in gone)


def test_region_followed_off_the_edge_never_settles_on_the_background():
    # slow enough to follow: confident in view, then never confident about what is left behind
    outs, truths = leave(12, 30)
    pairs = list(zip(outs, truths, strict=True))
    assert all(out.confident for out, truth in pairs[1:] if in_view(truth) == 1.0)
    gone = [out for out, truth in pairs if in_view(truth) < 0.25]
    assert len(gone) >= 10
    assert not any(out.confident for out in gone)
    for out, truth in pairs:
        if out.confident:
            assert iou(out.box, truth)[0, 0] > 0.8


def test_frame_size_change_resets():
    frames = scene(3, move=(4, 2))
    f = RegionFollower()
    f.set_reference(0, filled(frames[0][1]))
    for seq, (gray, _) in enumerate(frames):
        assert f.step(seq, gray, None, seq / 25) is not None
    assert f.active
    big = cv2.resize(frames[2][0], (640, 480))
    assert f.step(3, big, None, 3 / 25) is None
    assert not f.active
    assert f.reference_seq is None
    # and it starts over cleanly at the new size
    f.set_reference(3, filled(np.array([100, 100, 260, 200])))
    out = f.step(4, big, None, 4 / 25)
    assert out is not None and iou(out.box, np.array([100, 100, 260, 200]))[0, 0] > 0.95


def test_scale_change_is_followed():
    frames = scene(16, grow=(1.02, 1.02), start=(150, 120))
    f = RegionFollower()
    f.set_reference(0, filled(frames[0][1]))
    for seq, (gray, truth) in enumerate(frames):
        out = f.step(seq, gray, None, seq / 25)
        assert 0.85 <= area(out.box) / area(truth) <= 1.15
    assert out.confident
    assert iou(out.box, frames[-1][1])[0, 0] > 0.85


def test_foreshortening_is_followed_by_the_full_affine():
    # a door turning away: narrower by 3% a frame, as tall as before
    frames = scene(16, grow=(0.97, 1.0), start=(150, 120))
    f = RegionFollower()
    f.set_reference(0, filled(frames[0][1]))
    for seq, (gray, _) in enumerate(frames):
        out = f.step(seq, gray, None, seq / 25)
    truth = frames[-1][1]
    assert out.confident
    assert 0.9 <= (out.box[2] - out.box[0]) / (truth[2] - truth[0]) <= 1.1
    assert 0.9 <= (out.box[3] - out.box[1]) / (truth[3] - truth[1]) <= 1.1


def test_points_lost_are_replaced_when_reseeded():
    # a flat bar hides the patch's right quarter on frames 2 to 4, so its points are lost; they
    # come back when points are seeded inside the mask again, every `redetect_every` frames
    frames = scene(14, move=(4, 2))
    for gray, truth in frames[2:5]:
        x1, y1, x2, y2 = (round(float(v)) for v in truth)
        gray[y1:y2, x2 - PATCH_W // 4 : x2] = 128
    f = RegionFollower(FollowParams(redetect_every=10))
    f.set_reference(0, filled(frames[0][1]))
    outs = [f.step(seq, gray, None, seq / 25) for seq, (gray, _) in enumerate(frames)]
    assert all(out.confident for out in outs[1:])
    assert outs[9].inliers < 0.85 * outs[1].inliers
    assert outs[11].inliers > 0.95 * outs[1].inliers


def disc() -> MaskCrop:
    """A disc 280 frame pixels across in a 400x300 crop at two frame pixels per crop pixel, as
    the segmenter returns for a large object."""
    ys, xs = np.mgrid[0:150, 0:200]
    inside = (xs + 0.5 - 100) ** 2 + (ys + 0.5 - 75) ** 2 < 70**2
    return MaskCrop(np.where(inside, 10.0, -10.0).astype(np.float32), (40.0, 30.0), 2.0)


def centroid(crop: MaskCrop) -> np.ndarray:
    """The mask's centre of mass in frame pixels."""
    ys, xs = np.nonzero(crop.logits > 0)
    return np.array(crop.origin) + crop.scale * (np.array([xs.mean(), ys.mean()]) + 0.5)


def test_warped_crop_is_where_the_mask_was_carried():
    flat = np.full((H, W), 128, np.uint8)  # nothing to track: the camera alone carries the mask
    camera = np.array([[1.0, 0, 2.5], [0, 1.0, -1.5]])
    ref = disc()
    f = RegionFollower()
    f.set_reference(0, ref)
    for seq in range(3):
        out = f.step(seq, flat, camera, seq / 25)
    crop = out.crop
    assert crop.scale > 1 and max(crop.logits.shape) <= 256
    np.testing.assert_allclose(centroid(crop), centroid(ref) + [5.0, -3.0], atol=0.3)
    area_ref = (ref.logits > 0).sum() * ref.scale**2
    assert (crop.logits > 0).sum() * crop.scale**2 == pytest.approx(area_ref, rel=0.03)
    np.testing.assert_allclose(out.box, [105, 37, 385, 317], atol=1.0)  # disc bounds, carried


# A glance: the whole picture 60 px a frame, there and back, as motion.py measures it.
GLANCE = [(x, 0.0) for x in (0, 60, 120, 180, 240, 180, 120, 60, 0, 60)]


def glance_camera(seq: int) -> np.ndarray | None:
    """What CameraMotion hands the tracker on frame `seq` of the glance (None on the first)."""
    if seq == 0:
        return None
    (x0, y0), (x1, y1) = GLANCE[seq - 1], GLANCE[seq]
    return np.array([[1.0, 0, x1 - x0], [0, 1.0, y1 - y0]])


def follow_glance(move: Path) -> list:
    frames = scene(len(GLANCE), move=move, pan=GLANCE, start=(80, 140))
    f = RegionFollower()
    f.set_reference(0, filled(frames[0][1]))
    outs = [f.step(seq, gray, glance_camera(seq), seq / 25) for seq, (gray, _) in enumerate(frames)]
    return list(zip(outs, [truth for _, truth in frames], strict=True))


def test_glance_is_followed_by_seeding_the_flow_with_the_camera():
    for out, truth in follow_glance((0, 0))[1:]:
        assert out.confident
        assert iou(out.box, truth)[0, 0] > 0.9


def test_part_sliding_during_a_glance_is_followed():
    for out, truth in follow_glance((6, 0))[1:]:
        assert out.confident
        assert iou(out.box, truth)[0, 0] > 0.85


def test_accelerating_part_is_followed_by_its_own_last_motion():
    # 8 px a frame faster every frame, up to 40: beyond the flow's reach unless each frame starts
    # from the part's motion on the frame before
    frames = scene(6, move=[(x, 0.0) for x in (0, 8, 24, 48, 80, 120)], start=(40, 140))
    f = RegionFollower()
    f.set_reference(0, filled(frames[0][1]))
    for seq, (gray, truth) in enumerate(frames):
        out = f.step(seq, gray, None, seq / 25)
        if seq:
            assert out.confident
            assert iou(out.box, truth)[0, 0] > 0.9


def test_mostly_out_of_view_is_doubted_while_its_points_still_agree():
    # a frame-wide mask whose only texture is at its left end, all moving 25 px a frame: the
    # points stay in view and agree while the box slides out, so only its in-view share tells
    frames = []
    for k in range(16):
        gray = np.full((H, W), 128, np.uint8)
        gray[140:220, 25 * k : 25 * k + 60] = PATCH[:, :60]
        frames.append(gray)
    camera = np.array([[1.0, 0, 25], [0, 1.0, 0]])
    f = RegionFollower()
    f.set_reference(0, filled(np.array([0, 140, W, 220])))
    outs = [f.step(seq, gray, camera if seq else None, seq / 25) for seq, gray in enumerate(frames)]
    assert in_view(outs[14].box) > 0.26 and outs[14].confident
    first_out = outs[15]  # 22% in view
    assert in_view(first_out.box) < 0.24
    assert first_out.inliers >= FollowParams().min_inliers and first_out.ratio >= 0.9
    assert not first_out.confident
