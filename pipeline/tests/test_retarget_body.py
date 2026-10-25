import numpy as np
import pytest

from clio_pipeline.episode import load_episode
from clio_pipeline.frames import HAND_JOINTS
from clio_pipeline.retarget.body import (
    TCP_IN_PALM,
    body_doc,
    load_g1,
    solve_body,
)
from clio_pipeline.retarget.kinematics import quat_to_matrix
from clio_pipeline.retarget.motion import runs
from clio_pipeline.schema import derived_problems
from conftest import hand

# The synthetic workspace sits at world (-0.4, 0.75, -0.5), unrotated: W y = world y - 0.75.
TABLE_Y = 0.75
STANDING_HEAD = 1.65  # world
FACING_FORWARD = [0.0, 0.0, 0.0, 1.0]  # WebXR looks down -z
FORWARD = np.array([0.0, 0.0, -1.0])  # W
# Palm frames in W (columns: along the fingers, y = z x x, toward the index finger).
LEFT_PALM_DOWN = np.stack([FORWARD, [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]], axis=1)
RIGHT_PALM_DOWN = np.stack([FORWARD, [0.0, -1.0, 0.0], [-1.0, 0.0, 0.0]], axis=1)
RIGHT_THUMB_UP = np.stack([FORWARD, [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], axis=1)


@pytest.fixture(scope="module")
def g1():
    return load_g1()


def head_at(x: float, height: float, z: float, quat=FACING_FORWARD) -> list[float]:
    return [x, height - TABLE_Y, z, *quat]


def palm_hand(palm, R, *, size: float = 1.0, pinch: float = 0.08) -> dict:
    """A HandSample whose palm point (halfway from the wrist to the middle knuckle) and palm
    frame are `palm` (W) and `R` (W, the G1 palm convention), `size` times an adult hand."""
    palm, R = np.asarray(palm, dtype=float), np.asarray(R, dtype=float)
    x, z = R[:, 0], R[:, 2]
    knuckle = palm + 0.045 * size * x
    side = {"thumb": 0.035, "index": 0.02, "middle": 0.0, "ring": -0.018, "pinky": -0.035}
    along = {"metacarpal": -0.04, "proximal": 0.0, "intermediate": 0.03, "distal": 0.055}
    joints = []
    for name in HAND_JOINTS:
        if name == "wrist":
            p = palm - 0.045 * size * x
        else:
            finger, part = name.split("-")[0], name.split("-")[-1]
            p = knuckle + size * (side[finger] * z + along.get(part, 0.075) * x)
        joints.extend([*np.round(p, 4), 0.0, 0.0, 0.0, 1.0, 0.01])
    return {"joints": [float(v) for v in joints], "pinch": pinch}


def build(new_episode, episode_id, frames, *, step_ms=100.0):
    """frames: [(head, left, right)] with left/right a HandSample or None."""
    b = new_episode(episode_id)
    for k, (head, left, right) in enumerate(frames):
        b.frame(k * step_ms, head=head, left=left, right=right)
    return load_episode(b.write())


def standing_episode(new_episode, episode_id="ep-stand", *, heights=None, xs=None, pinch=0.08):
    """A learner standing behind the table edge, both hands 35 cm in front at waist height."""
    frames = []
    for k in range(60):
        height = STANDING_HEAD if heights is None else heights[k]
        x = 0.4 if xs is None else xs[k]
        frames.append(
            (
                head_at(x, height, 0.5),
                hand((x - 0.15, height - TABLE_Y - 0.55, 0.15), pinch=pinch),
                hand((x + 0.15, height - TABLE_Y - 0.55, 0.15), pinch=pinch),
            )
        )
    return build(new_episode, episode_id, frames)


def column(g1, q, name):
    return q[:, g1.joint_names.index(name)]


def arm_q(g1, q, side):
    return q[:, [g1.joint_names.index(n) for n in g1.arms[side].joint_names]]


def drawn_palms(g1, body, side):
    """(M, 3) the G1's palm point as the viewer draws it (at 1 / scale), W."""
    names = g1.joint_names
    waist = slice(names.index("waist_yaw_joint"), names.index("waist_yaw_joint") + 3)
    out = np.full((len(body.t), 3), np.nan)
    for k in np.flatnonzero(~np.isnan(body.root).any(axis=1)):
        R_root = quat_to_matrix(body.root[k, 3:])
        R_t, p_t = g1.waist.tip(body.q[k, waist])
        R_a, p_a = g1.arms[side].tip(arm_q(g1, body.q[k : k + 1], side)[0])
        local = p_t + R_t @ (p_a + R_a @ TCP_IN_PALM)
        out[k] = body.root[k, :3] + (1 / body.scale) * R_root @ local
    return out


def in_human_range(g1, q, side):
    lim = g1.arm_models[side].limits
    has = ~np.isnan(q).any(axis=1)
    return np.all((q[has] >= lim[:, 0] - 1e-6) & (q[has] <= lim[:, 1] + 1e-6))


def test_a_standing_learner_gives_a_standing_g1_that_reaches_the_hands(new_episode, g1):
    episode = standing_episode(new_episode)

    body = solve_body(episode, g1, fps=10)

    assert body.q.shape == (len(body.t), len(g1.joint_names))
    assert body.scale == pytest.approx(g1.head_height / STANDING_HEAD, rel=0.01)
    # Drawn at the learner's size, the pelvis is the G1's standing pelvis grown by 1 / scale.
    pelvis_height = body.root[:, 1] + TABLE_Y
    assert np.allclose(pelvis_height, g1.pelvis_height / body.scale, atol=0.02)
    assert np.nanmax(body.hand_residual) < 0.002
    assert np.all(np.abs(column(g1, body.q, "left_knee_joint")) < 0.4)  # nearly straight


def test_the_drawn_g1_puts_its_palms_on_the_measured_hands(new_episode, g1):
    frames = []
    for k in range(40):
        reach = 0.1 * np.sin(k / 6)
        frames.append(
            (
                head_at(0.4, STANDING_HEAD, 0.5),
                palm_hand([0.2, 0.25 + reach, 0.2 - reach], LEFT_PALM_DOWN),
                palm_hand([0.6, 0.3, 0.15 + reach], RIGHT_PALM_DOWN),
            )
        )
    episode = build(new_episode, "ep-drawn", frames)

    body = solve_body(episode, g1, fps=10)

    for side in range(2):
        gap = np.linalg.norm(drawn_palms(g1, body, side) - body.hand_target[:, side], axis=1)
        assert np.nanmax(gap) < 0.002
        assert in_human_range(g1, arm_q(g1, body.q, side), side)


def test_the_palm_turns_the_way_the_hand_does(new_episode, g1):
    frames = [
        (head_at(0.4, STANDING_HEAD, 0.5), None, palm_hand([0.6, 0.3, 0.15], R))
        for R in [RIGHT_PALM_DOWN] * 20 + [RIGHT_THUMB_UP] * 20
    ]
    # A handshake is held at elbow height.
    for k in range(20, 40):
        frames[k] = (frames[k][0], None, palm_hand([0.6, 0.42, 0.15], RIGHT_THUMB_UP))
    episode = build(new_episode, "ep-turn", frames)

    body = solve_body(episode, g1, fps=10)

    names = g1.joint_names
    waist = slice(names.index("waist_yaw_joint"), names.index("waist_yaw_joint") + 3)
    for k, R_hand in [(15, RIGHT_PALM_DOWN), (38, RIGHT_THUMB_UP)]:
        R_root = quat_to_matrix(body.root[k, 3:])
        R_t, _ = g1.waist.tip(body.q[k, waist])
        R_a, _ = g1.arms[1].tip(arm_q(g1, body.q[k : k + 1], 1)[0])
        R_palm = R_root @ R_t @ R_a
        angle = np.degrees(np.arccos(np.clip((np.trace(R_palm.T @ R_hand) - 1) / 2, -1, 1)))
        assert angle < 6
    # Palm down to thumb up is the forearm turning out (supination; negative for the right arm).
    roll = arm_q(g1, body.q, 1)[:, 4]
    assert roll[38] > roll[15] + 0.8


def test_the_elbow_hangs_low_and_out_of_the_body(new_episode, g1):
    frames = [
        (head_at(0.4, STANDING_HEAD, 0.5), None, palm_hand([0.55, 0.25, 0.15], RIGHT_THUMB_UP))
    ] * 20
    episode = build(new_episode, "ep-elbow", frames)

    body = solve_body(episode, g1, fps=10)

    k = 15
    names = g1.joint_names
    waist = slice(names.index("waist_yaw_joint"), names.index("waist_yaw_joint") + 3)
    R_t, p_t = g1.waist.tip(body.q[k, waist])
    state = g1.arms[1].forward(arm_q(g1, body.q[k : k + 1], 1)[0])
    shoulder, elbow, wrist = (p_t + R_t @ state.origins[j] for j in (1, 3, 5))
    torso_elbow = R_t.T @ (elbow - p_t)
    assert elbow[2] < (shoulder[2] + wrist[2]) / 2 - 0.03  # below the shoulder-wrist line
    assert torso_elbow[1] < -0.11  # right of the torso, not inside it


def test_a_hand_beyond_the_arm_is_reached_by_leaning(new_episode, g1):
    frames = [
        (head_at(0.4, STANDING_HEAD, 0.5), None, palm_hand([0.55, 0.3, 0.5 - d], RIGHT_PALM_DOWN))
        for d in np.linspace(0.35, 0.7, 30)
    ]
    episode = build(new_episode, "ep-far", frames)

    body = solve_body(episode, g1, fps=10)

    assert not np.isnan(body.hand_residual[:, 1]).any()
    assert np.max(body.hand_residual[:, 1]) < 0.002
    names = g1.joint_names
    waist = slice(names.index("waist_yaw_joint"), names.index("waist_yaw_joint") + 3)

    def tilt(k):
        up = quat_to_matrix(body.root[k, 3:]) @ g1.waist.tip(body.q[k, waist])[0][:, 2]
        return np.degrees(np.arccos(up[1]))

    assert tilt(len(body.t) - 1) > tilt(0) + 10
    assert in_human_range(g1, arm_q(g1, body.q, 1), 1)


def test_a_glitch_and_a_hand_behind_the_eyes_are_not_followed(new_episode, g1):
    frames = []
    for k in range(40):
        palm = [0.6, 0.3, 0.15]
        if k == 20:
            palm = [0.6, 0.6, -0.3]  # a jump of 60 cm for one frame
        if k in (30, 31, 32, 33):
            palm = [0.6, 1.0, 0.9]  # 40 cm behind the eyes: the cameras cannot see there
        frames.append((head_at(0.4, STANDING_HEAD, 0.5), None, palm_hand(palm, RIGHT_PALM_DOWN)))
    episode = build(new_episode, "ep-glitch", frames, step_ms=33.3)

    body = solve_body(episode, g1, fps=30)

    k20 = int(np.argmin(np.abs(body.t - 20 * 33.3)))
    assert np.isnan(body.hand_residual[k20, 1])
    speed = np.abs(np.diff(arm_q(g1, body.q, 1), axis=0)) * 30
    assert np.nanmax(speed) < 3.0  # the arm never chased either


def test_an_arm_hangs_at_rest_through_a_long_dropout_and_comes_back(new_episode, g1):
    frames = []
    for k in range(90):
        tracked = k < 20 or k >= 70
        right = palm_hand([0.6, 0.3, 0.15], RIGHT_PALM_DOWN) if tracked else None
        frames.append((head_at(0.4, STANDING_HEAD, 0.5), None, right))
    episode = build(new_episode, "ep-drop", frames, step_ms=33.3)

    body = solve_body(episode, g1, fps=30)

    q = arm_q(g1, body.q, 1)
    middle = int(np.argmin(np.abs(body.t - 45 * 33.3)))
    assert np.allclose(q[middle], g1.arm_rest[1], atol=0.05)
    assert np.nanmax(np.abs(np.diff(q, axis=0))) * 30 < 6.0  # down and back up smoothly
    after = int(np.argmin(np.abs(body.t - 75 * 33.3)))
    assert body.hand_residual[after, 1] < 0.002


def test_a_taller_learner_moves_the_g1_the_same_way(new_episode, g1):
    def episode(size, episode_id):
        # Everything scaled about the floor under the head (world x -0.0, z 0.0 -> W (0.4, 0.5)).
        def at(p):
            floor = np.array([0.4, -TABLE_Y, 0.5])
            return floor + size * (np.asarray(p) - floor)

        frames = []
        for k in range(40):
            reach = 0.1 * np.sin(k / 6)
            head = at([0.4, STANDING_HEAD - TABLE_Y, 0.5])
            frames.append(
                (
                    [*head, *FACING_FORWARD],
                    palm_hand(at([0.25, 0.3 + reach, 0.15]), LEFT_PALM_DOWN, size=size),
                    palm_hand(at([0.6, 0.3, 0.15 + reach]), RIGHT_THUMB_UP, size=size),
                )
            )
        return build(new_episode, episode_id, frames)

    short = solve_body(episode(0.9, "ep-short"), g1, fps=10)
    tall = solve_body(episode(1.15, "ep-tall"), g1, fps=10)

    assert tall.scale == pytest.approx(short.scale * 0.9 / 1.15, rel=1e-3)
    assert np.allclose(short.q, tall.q, atol=2e-3)


def test_the_g1_crouches_when_the_head_drops(new_episode, g1):
    heights = [STANDING_HEAD] * 30 + [1.15] * 30
    episode = standing_episode(new_episode, "ep-crouch", heights=heights)

    body = solve_body(episode, g1, fps=10)

    pelvis_height = body.root[:, 1] + TABLE_Y
    assert pelvis_height[-1] < pelvis_height[0] - 0.15
    knee = column(g1, body.q, "left_knee_joint")
    assert knee[-1] > knee[0] + 0.5


def test_the_g1_bends_over_when_the_learner_looks_down(new_episode, g1):
    down = [np.sin(-0.35), 0.0, 0.0, np.cos(-0.35)]  # 40 degrees down about x
    frames = [(head_at(0.4, STANDING_HEAD, 0.5), None, None)] * 20
    frames += [(head_at(0.4, STANDING_HEAD - 0.15, 0.4, down), None, None)] * 30
    episode = build(new_episode, "ep-bend", frames)

    body = solve_body(episode, g1, fps=10)

    hip = column(g1, body.q, "left_hip_pitch_joint")
    knee = column(g1, body.q, "left_knee_joint")
    assert hip[-1] < hip[0] - 0.3  # flexed at the hips
    assert knee[-1] < 0.6  # rather than squatting


def test_feet_stay_planted_through_a_sway_and_walk_after_a_move(new_episode, g1):
    # A sway from side to side, then a walk of 1.2 m forward (-z) at 0.8 m/s.
    xs = [0.4 + 0.05 * np.sin(k / 4) for k in range(30)] + [0.4] * 75
    zs = [0.5] * 30 + list(np.linspace(0.5, -0.7, 45)) + [-0.7] * 30
    frames = [(head_at(x, STANDING_HEAD, z), None, None) for x, z in zip(xs, zs, strict=True)]
    episode = build(new_episode, "ep-walk", frames, step_ms=33.3)

    body = solve_body(episode, g1, fps=30)

    def ankle(k, side):
        q = body.q[k, 6 * side : 6 * side + 6]
        local = g1.legs[side].points(q)[-1]
        return body.root[k, :3] + (1 / body.scale) * quat_to_matrix(body.root[k, 3:]) @ local

    left = np.array([ankle(k, 0) for k in range(len(body.t))])
    right = np.array([ankle(k, 1) for k in range(len(body.t))])
    early = int(np.argmin(np.abs(body.t - 25 * 33.3)))
    assert np.ptp(left[:early, 0]) < 0.02  # the sway moved the pelvis, not the foot
    assert left[-1, 2] < left[0, 2] - 1.0 and right[-1, 2] < right[0, 2] - 1.0
    # Walking, not teleporting: each step takes several frames, and the foot lifts in it.
    for foot in (left, right):
        travel = np.linalg.norm(np.diff(foot, axis=0), axis=1)
        assert np.max(travel) < 0.15  # 4.5 m/s at the peak of a swing
        swings = runs(travel > 0.005)
        assert len(swings) >= 2 and all(b - a >= 6 for a, b in swings)
        assert np.max(foot[1:][travel > 0.01, 1]) > np.min(foot[:, 1]) + 0.03
    floor = -TABLE_Y
    sole = np.minimum(left[:, 1], right[:, 1]) - floor
    assert np.min(sole) > g1.ankle_height / body.scale - 0.01  # feet on, not in, the floor


def test_a_pinch_closes_the_fingers(new_episode, g1):
    open_hand = solve_body(standing_episode(new_episode, "ep-open", pinch=0.08), g1, fps=10)
    closed = solve_body(standing_episode(new_episode, "ep-closed", pinch=0.02), g1, fps=10)

    index = "left_hand_index_1_joint"
    assert np.allclose(column(g1, open_hand.q, index), 0.0, atol=1e-3)
    assert np.all(column(g1, closed.q, index) < -1.0)


def test_the_body_doc_matches_its_schema(new_episode, g1):
    episode = standing_episode(new_episode, "ep-doc")

    doc = body_doc(solve_body(episode, g1, fps=10), g1, episode, 10)

    assert derived_problems(doc, "body") == []
    assert doc["kind"] == "body" and len(doc["root"]) == len(doc["q"]) == len(doc["t"])
    assert doc["profile"]["version"] == 2
