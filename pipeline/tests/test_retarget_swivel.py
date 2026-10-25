import numpy as np
import pytest

from clio_pipeline.retarget.body import load_g1
from clio_pipeline.retarget.human import comfort_cost, range_excess, roll_floor
from clio_pipeline.retarget.motion import (
    clean_tracking,
    fill_short_gaps,
    gaussian_smooth,
    min_jerk,
    runs,
)
from clio_pipeline.retarget.swivel import (
    choose_swivel,
    elbow_at,
    model_joints,
    swivel_costs,
)


@pytest.fixture(scope="module")
def g1():
    return load_g1()


def wrap(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


@pytest.mark.parametrize("side", [0, 1])
def test_the_arm_model_reads_the_g1s_own_joints(g1, side):
    arm, model = g1.arms[side], g1.arm_models[side]
    lim = model.limits
    rng = np.random.default_rng(side)
    errors = []
    for _ in range(200):
        q = lim[:, 0] + (lim[:, 1] - lim[:, 0]) * (0.15 + 0.7 * rng.random(7))
        q[1] = np.clip(q[1], -0.6, 0.6)  # away from the shoulder's gimbal (arm out sideways)
        state = arm.forward(q)
        o = state.origins
        errors.append(np.abs(wrap(model_joints(model, o[1], o[3], o[5], state.R) - q)))
    median = np.degrees(np.median(errors, axis=0))
    assert np.all(median < 6)  # the model has no link offsets; the solver takes it from there
    assert median[3] < 2  # elbow


@pytest.mark.parametrize("side", [0, 1])
def test_the_elbow_circle_keeps_the_arm_lengths(g1, side):
    model = g1.arm_models[side]
    S = model.shoulder
    W = S + np.array([0.25, 0.0, -0.1]) * (1 if side == 0 else np.array([1, -1, 1]))
    for phi in np.linspace(-np.pi, np.pi, 9):
        E = elbow_at(model, S, W, phi)
        assert np.linalg.norm(E - S) == pytest.approx(model.upper, abs=1e-6)
        assert np.linalg.norm(W - E) == pytest.approx(model.fore, abs=1e-6)


@pytest.mark.parametrize("side", [0, 1])
def test_a_hand_in_front_gets_a_low_elbow(g1, side):
    model = g1.arm_models[side]
    sign = 1 if side == 0 else -1
    S = model.shoulder[None]
    W = (model.shoulder + np.array([0.25, -0.02 * sign, -0.12]))[None]
    # Thumb up, fingers forward: x forward, z up, y = z x x.
    R = np.array([[[1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]]])
    phis = np.linspace(-np.pi, np.pi, 48, endpoint=False)
    cost, _ = swivel_costs(model, S, W, R, phis)
    best = phis[int(np.argmin(cost[0]))]
    E = elbow_at(model, S[0], W[0], best)
    mid = (S[0] + W[0]) / 2
    assert E[2] < mid[2]  # under the shoulder-wrist line
    assert sign * (E[1] - mid[1]) > -0.02  # not tucked across into the body


def test_the_chosen_swivel_does_not_jump_for_one_odd_frame():
    phis = np.linspace(-np.pi, np.pi, 48, endpoint=False)
    cost = np.tile((phis - 0.5) ** 2, (60, 1))
    cost[30] = (phis + 2.0) ** 2 * 50 + 100  # one frame wants the other side, badly
    swivel = choose_swivel(cost, np.ones(60, dtype=bool), phis)
    assert np.max(np.abs(wrap(swivel - 0.5))) < 0.1


def test_human_ranges_and_comfort():
    left = np.zeros(7)
    assert comfort_cost(left, 0) < 1.0
    bent_back = left.copy()
    bent_back[3] = np.pi / 2 + 0.5  # elbow 30 degrees past straight
    limits = np.array(
        [[-3, 1], [-1, 2.3], [-1.3, 1.4], [-1, 1.62], [-1.5, 1.4], [-0.35, 0.6], [-1.4, 1.2]]
    )
    assert range_excess(bent_back, 0, limits)[3] > 0.4
    assert roll_floor(np.array(-np.pi / 2), 0) < roll_floor(
        np.array(0.0), 0
    )  # raised: crosses more
    assert roll_floor(np.array(0.0), 1) == pytest.approx(-roll_floor(np.array(0.0), 0))


def test_glitches_blips_and_hands_behind_the_head_are_dropped():
    m = 60
    head = np.tile([0.0, 1.6, 0.0], (m, 1))
    forward = np.tile([0.0, 0.0, -1.0], (m, 1))
    p = np.tile([0.2, 1.1, -0.35], (m, 1)).astype(float)
    R = np.tile(np.eye(3), (m, 1, 1))
    tracked = np.ones(m, dtype=bool)
    p[10] += [0.0, 0.3, 0.0]  # a one-frame jump
    p[30:33] = [0.1, 1.3, 0.35]  # behind the eyes
    tracked[45:50] = False
    tracked[47] = True  # a blip inside a dropout
    good = clean_tracking(
        p,
        R,
        tracked,
        head,
        forward,
        dt=1 / 30,
        max_speed=6.0,
        max_turn=30.0,
        max_reach=1.0,
        max_behind=np.radians(100),
        spike=0.04,
        min_run=3,
    )
    assert not good[10] and not good[9] and not good[11]
    assert not good[30:33].any()
    assert not good[47]
    assert good[20] and good[40]


def test_a_short_dropout_is_bridged_smoothly_and_a_long_one_is_not():
    m = 40
    p = np.zeros((m, 3))
    p[:, 0] = np.linspace(0, 0.39, m)  # moving at 1 cm a frame
    R = np.tile(np.eye(3), (m, 1, 1))
    good = np.ones(m, dtype=bool)
    good[10:14] = False
    good[25:39] = False
    filled, _, have = fill_short_gaps(p, R, good, max_gap=6)
    assert have[10:14].all() and not have[25:39].any()
    assert np.allclose(filled[10:14, 0], p[10:14, 0], atol=1e-6)  # the same steady motion


def test_smoothing_keeps_runs_apart_and_min_jerk_ends_still():
    x = np.concatenate([np.zeros(10), np.full(10, np.nan), np.ones(10)])
    valid = ~np.isnan(x)
    out = gaussian_smooth(x, 3.0, valid)
    assert np.allclose(out[:10], 0.0) and np.allclose(out[20:], 1.0)
    assert runs(valid) == [(0, 10), (20, 30)]
    t = np.linspace(0, 1, 101)
    s = min_jerk(t)
    assert s[0] == 0 and s[-1] == 1 and np.all(np.diff(s) >= 0)
    assert abs(s[1] - s[0]) < 1e-4 and abs(s[-1] - s[-2]) < 1e-4
