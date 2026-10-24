import math
from dataclasses import replace

import numpy as np
import pytest
from numpy.testing import assert_allclose

from clio_pipeline.retarget import DEFAULT_PROFILE, load_profile
from clio_pipeline.retarget.ik import IkSettings, restart_seeds, solve_ik, solve_ik_restarts
from clio_pipeline.retarget.kinematics import quat_to_matrix, rotation_angle


@pytest.fixture(scope="module")
def profile():
    return load_profile(DEFAULT_PROFILE)


@pytest.fixture(scope="module")
def arm(profile):
    return profile.arms[0]


def _random_configurations(chain, count, seed):
    rng = np.random.default_rng(seed)
    return [chain.lower + (chain.upper - chain.lower) * rng.random(chain.dof) for _ in range(count)]


def _within_limits(chain, q):
    return bool(np.all(q >= chain.lower) and np.all(q <= chain.upper))


def test_full_pose_round_trip_converges_for_almost_every_random_in_limit_configuration(
    profile, arm
):
    chain = arm.chain
    settings = replace(profile.ik, mode="full")
    seeds = [arm.rest_pose, *restart_seeds(chain, 8)]
    solutions = []
    for q in _random_configurations(chain, 200, seed=1):
        R, p = chain.tip(q)
        solutions.append(solve_ik_restarts(chain, R, p, seeds, settings, arm.rest_pose))

    converged = [s for s in solutions if s.converged]
    assert len(converged) / len(solutions) >= 0.95  # 99% when measured
    for s in converged:
        assert s.residual_pos <= settings.tol_pos_m and s.residual_rot <= settings.tol_rot_rad


def test_joint_limits_hold_after_every_solve_even_from_outside_them(profile, arm):
    chain = arm.chain
    far_outside = chain.upper + 2.0
    for q in _random_configurations(chain, 40, seed=2):
        R, p = chain.tip(q)
        target_p = p + np.array([0.3, -0.2, 0.1])  # often unreachable: pushes against limits
        for q0 in (arm.rest_pose, far_outside):
            assert _within_limits(chain, solve_ik(chain, R, target_p, q0, profile.ik).q)


def test_an_unreachable_target_is_flagged_with_its_residual_not_forced(profile, arm):
    chain = arm.chain
    target_p = np.array([2.0, 0.0, 0.3])  # base frame: far beyond the 0.6 m reach

    s = solve_ik_restarts(
        chain,
        np.eye(3),
        target_p,
        [arm.rest_pose, *restart_seeds(chain, 8)],
        profile.ik,
        arm.rest_pose,
    )

    assert not s.converged
    assert s.residual_pos > 1.0
    assert_allclose(s.residual_pos, np.linalg.norm(target_p - chain.tip(s.q)[1]))
    assert _within_limits(chain, s.q)


def test_approach_axis_mode_aligns_one_tool_axis_and_leaves_the_roll_about_it_free(profile, arm):
    chain = arm.chain
    R, p = chain.tip(arm.rest_pose)
    roll = quat_to_matrix([0, 0, math.sin(0.6), math.cos(0.6)])  # 1.2 rad about tool z
    target_R = R @ roll
    settings = replace(profile.ik, mode="approach_axis", tol_rot_rad=0.01)

    s = solve_ik(chain, target_R, p, arm.rest_pose, settings)

    assert s.converged and s.iterations == 0  # the rest pose already points the right way
    assert_allclose(s.R[:, 2], target_R[:, 2], atol=1e-9)
    full = solve_ik(chain, target_R, p, arm.rest_pose, replace(settings, mode="full"))
    assert full.converged and full.iterations > 0
    assert rotation_angle(full.R.T @ target_R) <= 0.01


def test_position_only_mode_ignores_orientation_but_reports_how_far_off_it_is(profile, arm):
    chain = arm.chain
    _, p = chain.tip(arm.rest_pose)
    upside_down = quat_to_matrix([1.0, 0.0, 0.0, 0.0]) @ chain.tip(arm.rest_pose)[0]
    settings = replace(profile.ik, mode="position_only")

    s = solve_ik(chain, upside_down, p + [0.02, 0.03, -0.02], arm.rest_pose, settings)

    assert s.converged and s.residual_pos <= settings.tol_pos_m
    assert s.residual_rot > 2.5  # about pi: reported, not solved for


def test_warm_start_follows_a_smooth_path_without_joint_jumps(profile, arm):
    chain = arm.chain
    R0, p0 = chain.tip(arm.rest_pose)
    q = arm.rest_pose
    steps = []
    for k in range(240):
        a = 2 * math.pi * k / 240
        target_p = p0 + 0.1 * np.array([math.cos(a) - 1, math.sin(a), 0.5 * math.sin(2 * a)])
        tilt = quat_to_matrix([0.2 * math.sin(a), 0, 0, 1])
        s = solve_ik(chain, R0 @ tilt, target_p, q, profile.ik)
        assert s.converged
        steps.append(np.max(np.abs(s.q - q)))
        q = s.q

    assert max(steps) < 0.5


def test_restart_seeds_are_deterministic_and_inside_the_limits(arm):
    chain = arm.chain

    a, b = restart_seeds(chain, 5), restart_seeds(chain, 5)

    assert all(np.array_equal(x, y) for x, y in zip(a, b, strict=True))
    assert all(_within_limits(chain, x) for x in a)


def test_unknown_orientation_mode_is_rejected():
    with pytest.raises(ValueError, match="orientation mode"):
        IkSettings(mode="sideways")
