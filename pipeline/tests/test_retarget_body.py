import numpy as np
import pytest

from clio_pipeline.episode import load_episode
from clio_pipeline.retarget.body import body_doc, load_g1, solve_body
from clio_pipeline.retarget.kinematics import quat_to_matrix
from clio_pipeline.schema import derived_problems
from conftest import hand

# The synthetic workspace sits at world (-0.4, 0.75, -0.5), unrotated: W y = world y - 0.75.
TABLE_Y = 0.75
STANDING_HEAD = 1.65  # world
FACING_FORWARD = [0.0, 0.0, 0.0, 1.0]  # WebXR looks down -z


@pytest.fixture(scope="module")
def g1():
    return load_g1()


def head_at(x: float, height: float, z: float) -> list[float]:
    return [x, height - TABLE_Y, z, *FACING_FORWARD]


def standing_episode(new_episode, episode_id="ep-stand", *, heights=None, xs=None, pinch=0.08):
    """A learner standing behind the table edge, both hands 40 cm in front at waist height."""
    b = new_episode(episode_id)
    for k in range(60):
        height = STANDING_HEAD if heights is None else heights[k]
        x = 0.4 if xs is None else xs[k]
        head = head_at(x, height, 0.5)
        b.frame(
            k * 100.0,
            head=head,
            left=hand((x - 0.15, height - TABLE_Y - 0.55, 0.15), pinch=pinch),
            right=hand((x + 0.15, height - TABLE_Y - 0.55, 0.15), pinch=pinch),
        )
    return load_episode(b.write())


def column(g1, q, name):
    return q[:, g1.joint_names.index(name)]


def test_a_standing_learner_gives_a_standing_g1_that_reaches_the_hands(new_episode, g1):
    episode = standing_episode(new_episode)

    body = solve_body(episode, g1, fps=10)

    assert body.q.shape == (len(body.t), len(g1.joint_names))
    assert body.scale == pytest.approx(g1.head_height / STANDING_HEAD, rel=0.01)
    pelvis_height = body.root[:, 1] + TABLE_Y
    assert np.allclose(pelvis_height, g1.pelvis_height, atol=0.01)
    assert np.nanmax(body.hand_residual) < 0.03
    assert np.all(np.abs(column(g1, body.q, "left_knee_joint")) < 0.2)  # nearly straight


def test_the_g1_crouches_when_the_head_drops(new_episode, g1):
    heights = [STANDING_HEAD] * 30 + [1.15] * 30
    episode = standing_episode(new_episode, "ep-crouch", heights=heights)

    body = solve_body(episode, g1, fps=10)

    pelvis_height = body.root[:, 1] + TABLE_Y
    assert pelvis_height[-1] < pelvis_height[0] - 0.15
    knee = column(g1, body.q, "left_knee_joint")
    assert knee[-1] > knee[0] + 0.5


def test_feet_stay_planted_through_a_sway_and_step_after_a_walk(new_episode, g1):
    xs = [0.4 + 0.05 * np.sin(k / 4) for k in range(30)] + [1.2] * 30
    episode = standing_episode(new_episode, "ep-walk", xs=xs)

    body = solve_body(episode, g1, fps=10)

    def left_ankle(k):
        q = body.q[k, :6]
        return body.root[k, :3] + quat_to_matrix(body.root[k, 3:]) @ g1.legs[0].points(q)[-1]

    early = np.array([left_ankle(k) for k in range(25)])
    assert np.ptp(early[:, 0]) < 0.02  # the sway moved the pelvis, not the foot
    assert left_ankle(len(body.t) - 1)[0] > early[0, 0] + 0.6


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
