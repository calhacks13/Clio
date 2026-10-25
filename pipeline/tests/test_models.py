"""Object models (clio_pipeline.models) over a small synthetic scene: which objects get one, the
keyframe views and crops they are made from, their size and placement, the primitive backend,
per-object failures, and the returned list inside a SceneDoc against scene.schema.json.

The scene (`build_scene`): a red cup (container, "cup A") tracked at CUP, halfway up its seen
face, and a blue wooden block with a fused shape box, in a recorded episode with a plan. Six
keyframes look at the cup and two at the block; each JPEG is a gray checkerboard with every
object that has a position then drawn as a filled rectangle where it projects.

    t      looks at  what happens
    300    cup       front; the tracker's box on a frame captured 10 ms later -> observation
    900    cup       60 degrees toward +x; the nearest observation is 100 ms off -> projection
    1200   block     the cup has no position then (lost), so only the block counts
    1350   block     from the block's -x side
    1600   cup       the cup is held -> refused
    2200   cup       the camera looks away -> refused
    2500   cup       6 m away: the box is too small -> refused
    2800   cup       from 110 degrees toward -x -> projection
"""

import copy
import io
import json
import math
from pathlib import Path

import jsonschema
import numpy as np
import pytest
from PIL import Image, ImageDraw

import clio_pipeline.models as models
from clio_pipeline.episode import load_episode
from clio_pipeline.glb import glb_bounds, read_glb
from clio_pipeline.keyframes import load_keyframes
from clio_pipeline.models import ModelSettings, build_object_models, drawable_objects, file_stems
from clio_pipeline.models.cad import srgb_to_linear
from clio_pipeline.models.describe import object_words
from clio_pipeline.models.fit import Measured, measure, place, yaw_of, yaw_quat
from clio_pipeline.models.primitive import footprint_is_round, head_noun, looks_round
from clio_pipeline.models.views import (
    Images,
    Observations,
    candidate,
    laplacian_variance,
    select_views,
)
from conftest import EpisodeBuilder

# glb.apply_matrix's matmul goes through Accelerate on macOS, which raises spurious floating point
# flags on exact zeros (inputs and results are finite); they are not this package's to fix.
pytestmark = pytest.mark.filterwarnings("ignore:.*encountered in matmul:RuntimeWarning")

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "packages" / "protocol" / "schema"
W, H, F = 320, 240, 260.0
FPS = 30
GRID = [round(k * 1000.0 / FPS, 2) for k in range(91)]  # 0 .. 3000 ms
CUP = np.array([0.30, 0.05, -0.30])
CUP_RADIUS, CUP_HEIGHT = 0.04, 0.10
CUP_LOST = (1100.0, 1400.0)
CUP_HELD = (1500.0, 2000.0)
BLOCK = np.array([-0.60, 0.03, -0.30])
BLOCK_SEEN = (1100.0, 1400.0)
BLOCK_YAW = math.radians(30.0)
BLOCK_BOX = {
    "center": [0.01, 0.0, -0.005],
    "rotation": yaw_quat(BLOCK_YAW).round(6).tolist(),
    "size": [0.12, 0.06, 0.08],
}
RED, BLUE = (200, 40, 40), (40, 60, 200)
NO_KEY = {"PATH": "/usr/bin:/bin"}


def orbit(center, degrees, *, up=0.25, out=0.45):
    """A camera position `out` from `center` horizontally, `degrees` round from +z toward +x."""
    a = math.radians(degrees)
    return np.asarray(center) + [out * math.sin(a), up, out * math.cos(a)]


KEYFRAMES = [
    (300.0, orbit(CUP, 0), CUP),
    (900.0, orbit(CUP, 60), CUP),
    (1200.0, orbit(BLOCK, 20), BLOCK),
    (1350.0, orbit(BLOCK, -80), BLOCK),
    (1600.0, orbit(CUP, 0), CUP),
    (2200.0, orbit(CUP, 0), CUP + [0.0, 0.25, 1.2]),
    (2500.0, orbit(CUP, 0, up=1.0, out=6.0), CUP),
    (2800.0, orbit(CUP, -110), CUP),
]


def look_at(eye, target) -> list[float]:
    """Camera pose [px, py, pz, qx, qy, qz, qw] at `eye` looking at `target`, +y up (WebXR
    camera axes: x right, y up, looking down -z)."""
    eye, target = np.asarray(eye, float), np.asarray(target, float)
    back = eye - target
    back /= np.linalg.norm(back)
    right = np.cross([0.0, 1.0, 0.0], back)
    right /= np.linalg.norm(right)
    up = np.cross(back, right)
    return [*eye.tolist(), *matrix_quat(np.stack([right, up, back], axis=1))]


def matrix_quat(m) -> list[float]:
    """[x, y, z, w] of a rotation matrix, from its largest diagonal term (stable at half turns)."""
    trace = m[0, 0] + m[1, 1] + m[2, 2]
    if trace > 0:
        s = 2 * math.sqrt(1 + trace)
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4]
    else:
        i = int(np.argmax(np.diag(m)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = 2 * math.sqrt(1 + m[i, i] - m[j, j] - m[k, k])
        q = [0.0, 0.0, 0.0, (m[k, j] - m[j, k]) / s]
        q[i], q[j], q[k] = s / 4, (m[j, i] + m[i, j]) / s, (m[k, i] + m[i, k]) / s
    return q


def _in(t, span):
    return span[0] <= t <= span[1]


def cup_silhouette(kf) -> np.ndarray:
    """[x0, y0, x1, y1] pixels of the cup (a cylinder standing on y = 0) in a keyframe."""
    a = np.linspace(0, 2 * np.pi, 48, endpoint=False)
    ring = np.stack([np.cos(a) * CUP_RADIUS, np.zeros_like(a), np.sin(a) * CUP_RADIUS], 1)
    base = CUP - [0.0, CUP_HEIGHT / 2, 0.0]
    points = np.concatenate([base + ring, base + ring + [0.0, CUP_HEIGHT, 0.0]])
    uv, _ = kf.project(points)
    return np.array([*uv.min(axis=0), *uv.max(axis=0)])


def block_silhouette(kf) -> np.ndarray:
    measured = measure({"extent": None, "radius": 0.05}, {"box": BLOCK_BOX})
    corners = models.fit.box_corners(BLOCK, measured, None)
    uv, _ = kf.project(corners)
    return np.array([*uv.min(axis=0), *uv.max(axis=0)])


def keyframe_image(kf) -> bytes:
    image = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(image)
    for y in range(0, H, 8):
        for x in range(0, W, 8):
            g = 90 if (x // 8 + y // 8) % 2 else 160
            draw.rectangle([x, y, x + 7, y + 7], fill=(g, g, g))
    t = kf.captured_t
    drawn = []
    if not _in(t, CUP_LOST):
        _, depth = kf.project(CUP[None])
        if depth[0] > 0:
            drawn.append((depth[0], cup_silhouette(kf), RED))
    if _in(t, BLOCK_SEEN):
        _, depth = kf.project(BLOCK[None])
        if depth[0] > 0:
            drawn.append((depth[0], block_silhouette(kf), BLUE))
    for _, box, color in sorted(drawn, key=lambda d: -d[0]):  # far first
        draw.rectangle(box.tolist(), fill=color)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=95)
    return buffer.getvalue()


PLAN = {
    "schema": "clio.procedure/1",
    "id": "cup-demo",
    "version": 1,
    "title": "Fill cup A",
    "summary": "A cup, its lid and a block.",
    "workspace": {"size": [1.2, 0.8]},
    "objects": [
        {
            "id": "cup",
            "label": "cup A",
            "kind": "container",
            "radius": 0.04,
            "hidden": False,
            "placement": {"method": "detect"},
            "tracking": {"query": "white paper cup with a big letter A", "moves": True},
        },
        {
            "id": "lid",
            "label": "cup lid",
            "kind": "item",
            "radius": 0.04,
            "hidden": False,
            "placement": {"method": "detect"},
            "partOf": "cup",
        },
        {
            "id": "block",
            "label": "wooden block",
            "kind": "item",
            "radius": 0.05,
            "hidden": False,
            "placement": {"method": "detect"},
        },
        {
            "id": "dot",
            "label": "start dot",
            "kind": "point",
            "radius": 0.02,
            "hidden": False,
            "placement": {"method": "layout", "position": [0.1, 0.0, -0.1]},
        },
        {
            "id": "zone",
            "label": "spill zone",
            "kind": "region",
            "radius": 0.2,
            "hidden": True,
            "placement": {"method": "layout", "position": [0.6, 0.0, -0.4]},
        },
    ],
    "steps": [
        {
            "id": "fill",
            "instruction": "Fill cup A.",
            "targets": ["cup"],
            "hand": "either",
            "show": [
                {
                    "object": "cup",
                    "phrase": "white paper cup",
                    "description": "White paper cup with a big black letter A, front left",
                }
            ],
            "success": {"type": "confirm", "by": "either"},
            "mistakes": [],
        }
    ],
    "coach": {},
}


def _keyframe_event(index, t, eye, target):
    return {
        "type": "scene.keyframe",
        "t": t + 20.0,
        "media": f"keyframe-{index:04d}.jpg",
        "capturedT": t,
        "pose": [round(v, 6) for v in look_at(eye, target)],
        "width": W,
        "height": H,
        "intrinsics": {"fx": F, "fy": F, "cx": W / 2, "cy": H / 2},
    }


def build_scene(root: Path, episode_id: str = "ep-models"):
    """(episode, keyframes, tracks, shapes) of the scene in the module docstring."""
    b = EpisodeBuilder(root, episode_id)
    b.meta["plan"] = copy.deepcopy(PLAN)
    b.features("object.flags", "object.observations", "scene.keyframes")
    for t in (0.0, 1000.0, 2000.0, 3000.0):
        b.frame(t)
    events = [_keyframe_event(i + 1, *kf) for i, kf in enumerate(KEYFRAMES)]
    for event in events:
        b.event(
            event["t"], event["type"], **{k: v for k, v in event.items() if k not in ("t", "type")}
        )
    path = b.write()
    episode = load_episode(path)
    # Images need the keyframes' poses, so they are drawn once the episode can be read.
    for kf in load_keyframes(episode, include_missing=True):
        (path / "media").mkdir(exist_ok=True)
        (path / "media" / kf.media).write_bytes(keyframe_image(kf))
    first = load_keyframes(load_episode(path))[0]
    x0, y0, x1, y1 = (cup_silhouette(first) / [W, H, W, H]).round(4).tolist()
    outline = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    lines = [
        _observation(320.0, "cup", 310.0, [x0, y0, x1, y1], outline, 0.9),
        _observation(1010.0, "cup", 1000.0, [0.1, 0.1, 0.2, 0.2], None, 0.9),
    ]
    (path / "observations.ndjson").write_text("".join(json.dumps(line) + "\n" for line in lines))
    episode = load_episode(path)
    return episode, load_keyframes(episode), tracks_doc(episode_id), shapes_doc(episode_id)


def _observation(t, obj_id, observed_t, box, outline, score):
    return {
        "t": t,
        "observedT": observed_t,
        "objectId": obj_id,
        "status": "measured",
        "role": "tracker",
        "source": "yoloe-26l-seg",
        "box": box,
        "outline": outline,
        "point": None,
        "contact": None,
        "score": score,
        "frame": None,
        "trackId": "7",
    }


def track(
    obj_id,
    label,
    kind,
    position,
    *,
    valid=None,
    held=None,
    radius=0.04,
    hidden=False,
    part_of=None,
    extent=None,
    source="detector",
):
    n = len(GRID)
    valid = valid or (lambda t: True)
    held = held or (lambda t: False)
    return {
        "id": obj_id,
        "label": label,
        "kind": kind,
        "radius": radius,
        "hidden": hidden,
        "partOf": part_of,
        "extent": extent,
        "position": [list(map(float, position)) if valid(t) else None for t in GRID],
        "orientation": [None] * n,
        "tracked": [valid(t) for t in GRID],
        "interpolated": [False] * n,
        "held": [held(t) for t in GRID],
        "heldBy": ["right" if held(t) else None for t in GRID],
        "confidence": [0.9 if valid(t) else None for t in GRID],
        "source": [source if valid(t) else None for t in GRID],
        "heldSpans": [
            {
                "hand": "right",
                "startT": CUP_HELD[0],
                "endT": CUP_HELD[1],
                "origin": "recorded",
                "grip": "pinch",
            }
        ]
        if obj_id == "cup"
        else [],
    }


def tracks_doc(episode_id: str) -> dict:
    n = len(GRID)
    cup_extent = {"width": 2 * CUP_RADIUS, "height": CUP_HEIGHT, "samples": 5}
    return {
        "schema": "clio.derived/1",
        "episodeId": episode_id,
        "frame": "workspace",
        "fps": FPS,
        "t": GRID,
        "kind": "tracks",
        "policy": {"maxInterpolateGapMs": 250.0, "staleMs": 100.0, "maxFrameGapMs": 100.0},
        "head": [None] * n,
        "hands": [],
        "objects": [
            track(
                "cup",
                "cup A",
                "container",
                CUP,
                valid=lambda t: not _in(t, CUP_LOST),
                held=lambda t: _in(t, CUP_HELD),
                extent=cup_extent,
            ),
            track("lid", "cup lid", "item", CUP + [0, 0.05, 0], part_of="cup"),
            track(
                "block",
                "wooden block",
                "item",
                BLOCK,
                valid=lambda t: _in(t, BLOCK_SEEN),
                radius=0.05,
            ),
            track("dot", "start dot", "point", [0.1, 0.0, -0.1], source="layout"),
            track("zone", "spill zone", "region", [0.6, 0.0, -0.4], hidden=True, source="layout"),
        ],
    }


def shapes_doc(episode_id: str) -> dict:
    return {
        "schema": "clio.derived/1",
        "episodeId": episode_id,
        "frame": "workspace",
        "fps": FPS,
        "t": GRID,
        "kind": "shapes",
        "policy": {"voxelM": 0.01, "minHits": 2, "reachM": 0.3},
        "objects": [
            {
                "id": "block",
                "points": [[0.0, 0.0, 0.0]] * 4,
                "box": BLOCK_BOX,
                "samples": 40,
                "frames": 2,
                "firstT": 1200.0,
                "lastT": 1350.0,
            }
        ],
    }


@pytest.fixture
def scene(tmp_path):
    return build_scene(tmp_path)


def _errors(doc, schema_file):
    schema = json.loads((SCHEMA_DIR / schema_file).read_text())
    return [
        f"{list(e.absolute_path)}: {e.message[:200]}"
        for e in jsonschema.Draft202012Validator(schema).iter_errors(doc)
    ]


def test_the_synthetic_compile_follows_the_contract(scene):
    _, keyframes, tracks, shapes = scene
    assert _errors(tracks, "derived-tracks.schema.json") == []
    assert _errors(shapes, "derived-shapes.schema.json") == []
    assert len(keyframes) == len(KEYFRAMES)


# --- which objects --------------------------------------------------------------------------------


def test_items_containers_and_tools_get_models_and_parts_of_a_modelled_whole_do_not(scene):
    _, _, tracks, shapes = scene
    drawn, skipped = drawable_objects(tracks, {s["id"]: s for s in shapes["objects"]})
    assert [o["id"] for o in drawn] == ["cup", "block"]
    assert skipped == {
        "lid": "part of cup, which is modelled whole",
        "dot": "a point",
        "zone": "hidden",
    }


def test_a_part_whose_whole_is_not_modelled_gets_its_own_and_unplanned_needs_a_measurement():
    lid = track("lid", "lid", "item", CUP, part_of="cup")
    cup = track("cup", "cup", "container", CUP, valid=lambda t: False)  # never had a position
    knob = track("knob", "knob", "item", CUP, part_of="lid")
    seen = track("thing", "thing", None, CUP, extent={"width": 0.1, "height": 0.1, "samples": 3})
    unseen = track("mark", "mark", None, CUP)
    loop = track("a", "a", "item", CUP, part_of="b")
    loop_b = track("b", "b", "region", CUP, part_of="a")
    drawn, skipped = drawable_objects({"objects": [lid, cup, knob, seen, unseen, loop, loop_b]})
    assert [o["id"] for o in drawn] == ["lid", "thing", "a"]
    assert skipped["knob"] == "part of lid, which is modelled whole"
    assert skipped["cup"] == "it never had a position"
    assert skipped["mark"] == "not declared and never measured"


def test_file_stems_are_the_id_when_it_is_a_slug_and_never_collide():
    stems = file_stems(["cup", "Cup A", "cup-a", "cup a!", "cup\n"])
    assert stems["cup"] == "cup" and stems["cup-a"] == "cup-a"
    assert stems["Cup A"].startswith("cup-a-") and stems["cup a!"].startswith("cup-a-")
    assert stems["cup\n"].startswith("cup-")
    assert len(set(stems.values())) == 5


# --- views ----------------------------------------------------------------------------------------


def _cup(scene):
    episode, keyframes, tracks, _ = scene
    cup = tracks["objects"][0]
    return episode, keyframes, cup, measure(cup, None, round_=True)


def test_a_keyframe_takes_the_trackers_box_on_the_same_frame_else_the_projection(scene):
    episode, keyframes, cup, measured = _cup(scene)
    grid, obs = np.asarray(GRID), Observations(episode.observations)
    front = candidate(cup, grid, measured, keyframes[0], obs)
    assert front.source == "observation" and front.observation_score == 0.9
    expected = (cup_silhouette(keyframes[0]) / [W, H, W, H]).round(4)
    np.testing.assert_allclose(front.box, expected)
    side = candidate(cup, grid, measured, keyframes[1], obs)  # its observation is 100 ms off
    assert side.source == "projection" and side.outline is None
    truth = cup_silhouette(keyframes[1]) / [W, H, W, H]
    assert _iou(side.box, truth) > 0.6


def _iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def test_held_lost_away_and_tiny_views_are_refused(scene):
    episode, keyframes, cup, measured = _cup(scene)
    grid, obs = np.asarray(GRID), Observations(episode.observations)
    by_t = {kf.captured_t: kf for kf in keyframes}
    for t in (1200.0, 1600.0, 2200.0, 2500.0):  # lost, held, looking away, 6 m off
        assert candidate(cup, grid, measured, by_t[t], obs) is None, t


def test_up_to_three_views_from_different_directions_best_first(scene):
    episode, keyframes, cup, measured = _cup(scene)
    views = select_views(
        cup, np.asarray(GRID), measured, keyframes, Observations(episode.observations), Images()
    )
    assert [v.keyframe.captured_t for v in views][0] == 300.0  # the tracker's own box wins
    assert sorted(v.keyframe.captured_t for v in views) == [300.0, 900.0, 2800.0]
    assert [v.source for v in views] == ["observation", "projection", "projection"]
    assert views[0].score >= views[1].score >= views[2].score
    for a in views:
        for b in views:
            if a is not b:
                assert np.degrees(np.arccos(a.toward_camera @ b.toward_camera)) >= 30


def test_two_views_from_nearly_the_same_place_count_once(scene):
    episode, keyframes, cup, measured = _cup(scene)
    twin = copy.copy(keyframes[0])
    object.__setattr__(twin, "captured_t", 2900.0)
    object.__setattr__(twin, "pose", np.asarray(look_at(orbit(CUP, 10), CUP)))
    views = select_views(
        cup,
        np.asarray(GRID),
        measured,
        [*keyframes, twin],
        Observations(episode.observations),
        Images(),
    )
    assert len(views) == 3 and 2900.0 not in [v.keyframe.captured_t for v in views]


def test_sharpness_prefers_the_sharper_image():
    rng = np.random.default_rng(1)
    sharp = rng.integers(0, 255, (64, 64)).astype(float)
    blurred = (sharp + np.roll(sharp, 1, 0) + np.roll(sharp, 1, 1) + np.roll(sharp, 1, (0, 1))) / 4
    assert laplacian_variance(sharp) > 4 * laplacian_variance(blurred)
    assert laplacian_variance(np.full((10, 10), 7.0)) == 0.0


# --- fit and placement ----------------------------------------------------------------------------


def test_a_shape_box_sizes_and_turns_the_model_from_its_bottom_center():
    measured = measure({"extent": None, "radius": 0.05}, {"box": BLOCK_BOX})
    assert measured.source == "shape" and measured.notes == ()
    np.testing.assert_allclose(measured.bottom, [0.01, -0.03, -0.005])
    assert yaw_of(BLOCK_BOX["rotation"]) == pytest.approx(BLOCK_YAW)
    # A camera straight along the box's own +z: no quarter turn, the box's yaw as it is.
    toward = np.array([math.sin(BLOCK_YAW), 0.3, math.cos(BLOCK_YAW)])
    placement = place(measured, toward)
    assert placement.rotation_source == "shape"
    assert placement.yaw == pytest.approx(BLOCK_YAW)
    np.testing.assert_allclose(placement.size, [0.12, 0.06, 0.08])
    np.testing.assert_allclose(placement.offset, [0.01, -0.03, -0.005])
    # From the box's +x side the model turns a quarter so its front faces the camera; its x and
    # z sizes swap, so it is still the same box.
    side = place(measured, np.array([math.cos(BLOCK_YAW), 0.0, -math.sin(BLOCK_YAW)]))
    assert side.yaw == pytest.approx(BLOCK_YAW + math.pi / 2)
    np.testing.assert_allclose(side.size, [0.08, 0.06, 0.12])
    np.testing.assert_allclose(side.offset, placement.offset)


def test_an_extent_centers_the_model_on_the_tracked_point_and_faces_the_camera():
    obj = {"extent": {"width": 0.08, "height": 0.1, "samples": 4}, "radius": 0.03}
    measured = measure(obj, None)
    assert measured.source == "extent"
    np.testing.assert_allclose(measured.size, [0.08, 0.1, 0.08])
    np.testing.assert_allclose(measured.bottom, [0.0, -0.05, 0.0])
    placement = place(measured, np.array([1.0, 0.5, 1.0]) / math.sqrt(2.25))
    assert placement.rotation_source == "view"
    assert placement.yaw == pytest.approx(math.pi / 4)  # +z turned toward the camera
    unseen = place(measured, None)
    assert unseen.rotation_source == "none" and unseen.yaw == 0.0
    np.testing.assert_allclose(unseen.rotation, [0, 0, 0, 1])


def test_a_radius_is_a_guess_and_a_layout_placement_stands_on_its_point():
    laid = {"radius": 0.05, "source": ["layout"], "position": [[0, 0, 0]]}
    pinched = {"radius": 0.05, "source": ["pinch"], "position": [[0, 0, 0]]}
    np.testing.assert_allclose(measure(laid, None).size, [0.1, 0.1, 0.1])
    np.testing.assert_allclose(measure(laid, None).bottom, [0, 0, 0])
    np.testing.assert_allclose(measure(pinched, None).bottom, [0, -0.05, 0])
    unsized = measure({"radius": None}, None)
    assert unsized.source == "radius" and "default radius" in unsized.notes[0]


def test_thin_shape_axes_come_from_the_extent_and_a_round_thing_is_as_deep_as_wide():
    flat = {"center": [0, 0.04, 0], "rotation": [0, 0, 0, 1], "size": [0.08, 0.002, 0.08]}
    extent = {"width": 0.07, "height": 0.09, "samples": 3}
    top_only = measure({"extent": extent}, {"box": flat})
    assert top_only.size[1] == pytest.approx(0.09) and "flat" in top_only.notes[0]
    # It keeps the measured top (0.041) and grows down toward the table.
    assert top_only.bottom[1] == pytest.approx(0.041 - 0.09)
    arc = {"center": [0, 0, 0.02], "rotation": [0, 0, 0, 1], "size": [0.08, 0.1, 0.03]}
    cup = measure({"extent": extent}, {"box": arc}, round_=True)
    np.testing.assert_allclose(cup.size, [0.08, 0.1, 0.08])
    assert "as deep as it is wide" in cup.notes[-1]
    # The samples were on the near side: the 5 cm it grew goes away from the camera at +z.
    seen_from_front = place(cup, np.array([0.0, 0.0, 1.0]))
    np.testing.assert_allclose(seen_from_front.offset, [0.0, -0.05, 0.02 - 0.025])


# --- the primitive backend ------------------------------------------------------------------------


def test_round_things_by_name_or_by_their_depth_samples():
    def words(label, query=None, phrases=()):
        plan = {"objects": [{"id": "o", "label": label, "tracking": {"query": query}}]}
        plan["steps"] = [
            {"show": [{"object": "o", "phrase": p, "description": ""}]} for p in phrases
        ]
        return object_words(plan, "o", label)

    assert head_noun("white paper cup with a big letter A") == "cup"
    assert head_noun("cup B") == "cup" and head_noun("the small glass vials") == "vial"
    assert head_noun("bottle opener") == "opener" and head_noun("glasses") == "glass"
    assert looks_round(words("cup A"), None)[0]
    assert looks_round(words("thing 3", query="tall green bottle"), None)[0]
    assert not looks_round(words("bottle opener"), None)[0]
    assert not looks_round(words("wooden block"), None)[0]
    pen = {"box": {"size": [0.14, 0.012, 0.012]}, "points": []}
    assert looks_round(words("red pen"), pen) == (False, "a pen lying down")
    a = np.linspace(-1.2, 1.2, 40)
    arc = np.stack([0.04 * np.sin(a), np.linspace(0, 0.1, 40), 0.04 * np.cos(a)], 1)
    assert footprint_is_round(arc.tolist(), [0.075, 0.1, 0.03])
    face = np.stack([np.linspace(-0.04, 0.04, 40), np.zeros(40), np.zeros(40)], 1)
    assert not footprint_is_round(face.tolist(), [0.08, 0.1, 0.01])
    corner = np.concatenate(
        [
            np.stack([np.linspace(0, 0.06, 20), np.zeros(20), np.zeros(20)], 1),
            np.stack([np.zeros(20), np.zeros(20), np.linspace(0, 0.06, 20)], 1),
        ]
    )
    assert not footprint_is_round(corner.tolist(), [0.06, 0.1, 0.06])


def _settings(**env):
    return ModelSettings(env={**NO_KEY, **env}, sleep=lambda s: None)


def test_primitive_models_have_the_measured_size_and_the_crops_color(scene, tmp_path):
    episode, keyframes, tracks, shapes = scene
    out = tmp_path / "scene"
    log: list[str] = []
    results = build_object_models(
        episode, keyframes, tracks, shapes, out, log=log.append, settings=_settings()
    )
    cup, block = results
    assert (cup["id"], cup["backend"], cup["generator"], cup["cad"]) == (
        "cup",
        "primitive",
        None,
        None,
    )
    assert cup["sizeSource"] == "extent" and cup["size"] == pytest.approx([0.08, 0.1, 0.08])
    assert cup["placement"]["offset"] == pytest.approx([0.0, -0.05, 0.0])
    assert cup["placement"]["rotationSource"] == "view"
    cup_node = read_glb(out / cup["model"])[0]
    assert cup_node.name == "cylinder"
    np.testing.assert_allclose(
        cup_node.base_color[:3], srgb_to_linear(np.array(RED) / 255), atol=0.03
    )
    low, high = glb_bounds(out / cup["model"])
    np.testing.assert_allclose(low, [-0.04, 0.0, -0.04], atol=1e-6)
    np.testing.assert_allclose(high, [0.04, 0.1, 0.04], atol=1e-6)

    assert block["sizeSource"] == "shape" and block["placement"]["rotationSource"] == "shape"
    assert sorted(block["size"]) == pytest.approx([0.06, 0.08, 0.12])
    block_node = read_glb(out / block["model"])[0]
    assert block_node.name == "box"
    np.testing.assert_allclose(
        block_node.base_color[:3], srgb_to_linear(np.array(BLUE) / 255), atol=0.03
    )
    assert [c["keyframe"] for c in block["crops"]] == [
        "keyframe-0003.jpg",
        "keyframe-0004.jpg",
    ] or [c["keyframe"] for c in block["crops"]] == ["keyframe-0004.jpg", "keyframe-0003.jpg"]

    assert [c["file"] for c in cup["crops"]] == [
        "crop-cup-1.jpg",
        "crop-cup-2.jpg",
        "crop-cup-3.jpg",
    ]
    assert cup["crops"][0] == {
        "file": "crop-cup-1.jpg",
        "keyframe": "keyframe-0001.jpg",
        "box": pytest.approx((cup_silhouette(keyframes[0]) / [W, H, W, H]).round(4).tolist()),
        "from": "observation",
    }
    with Image.open(out / "crop-cup-1.jpg") as crop:  # the box and a 15% margin
        box = cup_silhouette(keyframes[0])
        assert crop.width == pytest.approx((box[2] - box[0]) * 1.3, abs=3)
    assert sorted(p.name for p in out.iterdir()) == sorted(
        ["model-cup.glb", "model-block.glb"] + [c["file"] for c in cup["crops"] + block["crops"]]
    )
    assert any("primitive cylinder (a cup)" in line for line in log)
    assert any("lid: no model (part of cup" in line for line in log)


def test_an_object_no_keyframe_saw_is_a_gray_primitive_with_a_note(scene, tmp_path):
    episode, _, tracks, shapes = scene
    [cup, block] = build_object_models(
        episode, [], tracks, shapes, tmp_path / "s", settings=_settings()
    )
    assert cup["crops"] == [] and cup["placement"]["rotationSource"] == "none"
    assert cup["note"] == "No keyframe showed it; gray: no crop to take its color from."
    node = read_glb(tmp_path / "s" / cup["model"])[0]
    np.testing.assert_allclose(node.base_color[:3], srgb_to_linear(np.full(3, 0.6)))


def test_a_rebuild_leaves_no_stale_files(scene, tmp_path):
    episode, keyframes, tracks, shapes = scene
    out = tmp_path / "s"
    build_object_models(episode, keyframes, tracks, shapes, out, settings=_settings())
    (out / "cad-cup.json").write_text("{}")
    (out / "crop-cup-a-1.jpg").write_bytes(b"another object's")
    build_object_models(episode, keyframes[:1], tracks, shapes, out, settings=_settings())
    assert sorted(p.name for p in out.iterdir()) == [
        "crop-cup-1.jpg",
        "crop-cup-a-1.jpg",
        "model-block.glb",
        "model-cup.glb",
    ]


# --- errors and the contract ----------------------------------------------------------------------


def test_one_objects_failure_does_not_stop_the_others(scene, tmp_path, monkeypatch):
    episode, keyframes, tracks, shapes = scene
    real = models.write_primitive

    def broken(path, *args, **kwargs):
        if kwargs["object_id"] == "cup":
            raise OSError("disk full")
        return real(path, *args, **kwargs)

    monkeypatch.setattr(models, "write_primitive", broken)
    cup, block = build_object_models(
        episode, keyframes, tracks, shapes, tmp_path / "s", settings=_settings()
    )
    assert cup["model"] is None and cup["crops"] == [] and "disk full" in cup["note"]
    assert block["model"] == "model-block.glb"
    assert not (tmp_path / "s" / "crop-cup-1.jpg").exists()
    monkeypatch.setattr(
        models, "write_primitive", lambda *a, **k: (_ for _ in ()).throw(OSError("no"))
    )
    with pytest.raises(RuntimeError, match="no object model could be made"):
        build_object_models(
            episode, keyframes, tracks, shapes, tmp_path / "t", settings=_settings()
        )


def test_nothing_to_model_is_not_an_error(tmp_path):
    episode, keyframes, tracks, shapes = build_scene(tmp_path)
    tracks["objects"] = [o for o in tracks["objects"] if o["kind"] in ("point", "region")]
    assert (
        build_object_models(episode, keyframes, tracks, None, tmp_path / "s", settings=_settings())
        == []
    )
    with pytest.raises(ValueError, match="unknown model backend"):
        build_object_models(episode, keyframes, tracks, None, tmp_path / "s", backend="nerf")


def scene_doc(episode_id: str, objects: list[dict], backend: str = "primitive") -> dict:
    return {
        "schema": "clio.scene/1",
        "episodeId": episode_id,
        "builtAt": "2026-10-25T12:00:00.000Z",
        "builder": {"name": "clio_pipeline", "version": "0.0.0-test"},
        "frame": "workspace",
        "compiledAt": "2026-10-25T11:59:00.000Z",
        "inputs": [],
        "options": {"models": backend},
        "stages": [{"name": "models", "status": "ok"}],
        "keyframes": len(KEYFRAMES),
        "objects": objects,
    }


def test_the_returned_models_are_valid_in_a_scene_doc(scene, tmp_path, monkeypatch):
    episode, keyframes, tracks, shapes = scene
    results = build_object_models(
        episode, keyframes, tracks, shapes, tmp_path / "s", settings=_settings()
    )
    assert _errors(scene_doc(episode.episode_id, results), "scene.schema.json") == []
    json.dumps(results, allow_nan=False)  # plain JSON, no numpy values
    assert all(type(v) is float for r in results for v in r["size"] + r["placement"]["offset"])
    # A command that cannot run, and an object whose model could not be made at all.
    real = models.write_primitive

    def broken(path, *args, **kwargs):
        if kwargs["object_id"] == "block":
            raise OSError("disk full")
        return real(path, *args, **kwargs)

    monkeypatch.setattr(models, "write_primitive", broken)
    failed = build_object_models(
        episode, keyframes, tracks, shapes, tmp_path / "t", backend="command", settings=_settings()
    )
    assert failed[0]["note"].startswith(
        "The command backend failed (CLIO_MODEL_COMMAND is not set)"
    )
    assert failed[1]["model"] is None
    assert _errors(scene_doc(episode.episode_id, failed, "command"), "scene.schema.json") == []


def test_measured_box_defaults_are_inert():
    m = Measured(np.ones(3), np.zeros(3), None, "radius")
    assert m.grown.tolist() == [0.0, 0.0, 0.0] and m.notes == ()
