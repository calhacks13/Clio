import math
import time

import numpy as np
import pytest

from clio_pipeline.retarget.body import load_g1
from clio_pipeline.retarget.gait import GaitSettings, plan_footsteps

SETTINGS = GaitSettings()
# No teleports: an ankle moves at most this fast between two frames. The swing's peak speed is
# capped at max_foot_speed_m_s (4.5); the lift and the bow around the support foot add a little.
MAX_ANKLE_SPEED_M_S = 4.8


@pytest.fixture(scope="module")
def g1():
    return load_g1()


def plan(g1, t, pelvis, yaw, **kwargs):
    stance = np.array([p[:2] for p in g1.stance])
    leg = float(-g1.stance[0][2])  # the pelvis-height hip to the ankle, straight
    return plan_footsteps(
        t, pelvis, yaw, stance=stance, ankle_height=g1.ankle_height, leg_length=leg, **kwargs
    )


def smoothstep(u):
    u = np.clip(u, 0.0, 1.0)
    return u * u * (3.0 - 2.0 * u)


def track(g1, seconds, fps=30):
    """A time grid and a pelvis standing at the G1's height at the origin, facing yaw 0."""
    t = np.arange(round(seconds * fps)) / fps
    pelvis = np.zeros((len(t), 3))
    pelvis[:, 1] = g1.pelvis_height
    return t, pelvis, np.zeros(len(t))


def walk(g1, *, speed=0.8, distance=2.0, ramp=0.6, before=1.0, after=2.0, heading=0.0, fps=30):
    """Stand, speed up to `speed`, cruise, slow down over `ramp` seconds and stand again."""
    cruise = (distance - speed * ramp) / speed
    t, pelvis, _ = track(g1, before + 2 * ramp + cruise + after, fps)
    u = t - before
    v = speed * np.where(
        u < ramp,
        smoothstep(u / ramp),
        np.where(u < ramp + cruise, 1.0, smoothstep(1 - (u - ramp - cruise) / ramp)),
    )
    v[t < before] = 0.0
    d = np.concatenate([[0.0], np.cumsum(0.5 * (v[1:] + v[:-1]) / fps)])
    pelvis[:, 0] = d * math.cos(heading)
    pelvis[:, 2] = -d * math.sin(heading)
    return t, pelvis, np.full(len(t), heading), (before + ramp, before + ramp + cruise)


def wander(g1, seconds, *, seed=0, fps=30, max_turn_deg=120, top_speed=0.9):
    """A learner walking about a room: speeding up, stopping, turning at most max_turn_deg/s."""
    rng = np.random.default_rng(seed)
    t, pelvis, _ = track(g1, seconds, fps)
    w, phase, amp = rng.uniform(0.2, 1.2, 4), rng.uniform(0, 2 * np.pi, 4), rng.uniform(0.3, 1, 4)
    amp *= math.radians(max_turn_deg) / (amp * w).sum()
    heading = (amp * np.sin(np.outer(t, w) + phase)).sum(axis=1)
    w2, phase2 = rng.uniform(0.1, 0.5, 3), rng.uniform(0, 2 * np.pi, 3)
    speed = np.clip(top_speed * (0.3 + 0.7 * np.sin(np.outer(t, w2) + phase2).mean(axis=1)), 0, 1)
    pelvis[:, 0] = np.cumsum(speed * np.cos(heading)) / fps
    pelvis[:, 2] = -np.cumsum(speed * np.sin(heading)) / fps
    return t, pelvis, heading


def frame(t_ms, fps):
    return int(round(t_ms * fps / 1000))


def rest_spots(g1, pelvis, yaw):
    """(M, 2, 2) each foot's (x, z) in stance around the pelvis."""
    fwd = np.stack([np.cos(yaw), -np.sin(yaw)], axis=1)
    left = np.stack([-np.sin(yaw), -np.cos(yaw)], axis=1)
    return np.stack([pelvis[:, [0, 2]] + p[0] * fwd + p[1] * left for p in g1.stance], axis=1)


def width(feet, yaw):
    """How far the left ankle is left of the right one, in the body frame."""
    left = np.stack([-np.sin(yaw), -np.cos(yaw)], axis=1)
    return ((feet.ankle[:, 0, [0, 2]] - feet.ankle[:, 1, [0, 2]]) * left).sum(axis=1)


def step_lengths(feet, fps):
    """How far each landing foot is ahead of the support foot at touch-down, body frame."""
    out = []
    for step in feet.steps:
        support = feet.ankle[frame(step.t1_ms, fps), 1 - step.foot]
        fwd = np.array([math.cos(step.end_yaw), 0.0, -math.sin(step.end_yaw)])
        out.append(float((step.end - support) @ fwd))
    return np.array(out)


def assert_well_formed(g1, feet, *, fps):
    s = SETTINGS
    posed = ~np.isnan(feet.ankle).any(axis=(1, 2))
    air = ~np.isnan(feet.swing)
    assert not (air[:, 0] & air[:, 1]).any()  # one foot in the air at a time
    assert np.all((feet.swing[air] > 0) & (feet.swing[air] < 1))
    assert np.all(feet.ankle[posed][..., 1] >= g1.ankle_height)  # never below the sole
    planted = posed[:, None] & ~air
    assert np.all(feet.ankle[..., 1][planted] == g1.ankle_height)
    # A planted foot does not move or turn at all.
    still = planted[1:] & planted[:-1]
    assert np.all(np.diff(feet.ankle, axis=0)[still] == 0.0)
    assert np.all(np.diff(feet.yaw, axis=0)[still] == 0.0)
    # Each step is in the air strictly between lift-off and touch-down, exactly at both ends.
    for step in feet.steps:
        k0, k1 = frame(step.t0_ms, fps), frame(step.t1_ms, fps)
        assert air[k0 + 1 : k1, step.foot].all() and not air[[k0, k1], step.foot].any()
        assert np.array_equal(feet.ankle[k0, step.foot], step.start)
        assert np.array_equal(feet.ankle[k1, step.foot], step.end)
        assert feet.yaw[k1, step.foot] == step.end_yaw
        half = 500.0 / fps
        assert s.min_swing_ms - half <= step.t1_ms - step.t0_ms <= s.max_swing_ms + half
    # Steps follow one another with both feet down in between.
    for a, b in zip(feet.steps, feet.steps[1:], strict=False):
        assert b.t0_ms - a.t1_ms >= s.min_double_support_ms - 500.0 / fps
    # No teleports.
    moved = np.linalg.norm(np.diff(feet.ankle, axis=0), axis=2)
    assert np.nanmax(moved, initial=0.0) <= MAX_ANKLE_SPEED_M_S / fps
    turned = np.abs(np.diff(feet.yaw, axis=0))
    assert np.nanmax(turned, initial=0.0) <= 1.875 * s.max_step_yaw_rad / (
        s.min_swing_ms * fps / 1000
    )


def test_standing_still_keeps_the_feet_planted_in_stance(g1):
    t, pelvis, yaw = track(g1, 10)

    feet = plan(g1, t * 1000, pelvis, yaw)

    assert feet.steps == ()
    assert np.isnan(feet.swing).all()
    assert np.allclose(feet.ankle[..., [0, 2]], rest_spots(g1, pelvis, yaw))
    assert np.all(feet.ankle[..., 1] == g1.ankle_height)
    assert np.all(feet.yaw == 0.0)


def test_a_sway_and_small_turns_never_step(g1):
    t, pelvis, _ = track(g1, 20)
    pelvis[:, 0] = 0.06 * np.sin(2 * np.pi * t / 2.5)
    pelvis[:, 2] = 0.05 * np.sin(2 * np.pi * t / 3.7)
    yaw = math.radians(15) * np.sin(2 * np.pi * t / 4.3)

    feet = plan(g1, t * 1000, pelvis, yaw)

    assert feet.steps == ()
    assert np.all(feet.ankle == feet.ankle[0])  # exactly where they started


@pytest.mark.parametrize(("fps", "heading"), [(30, 0.0), (30, 2.0), (10, -0.7)])
def test_a_straight_walk_alternates_feet_at_a_walking_rhythm(g1, fps, heading):
    t, pelvis, yaw, (cruise_from, cruise_to) = walk(g1, heading=heading, fps=fps)

    feet = plan(g1, t * 1000, pelvis, yaw)

    assert_well_formed(g1, feet, fps=fps)
    steps = feet.steps
    assert len(steps) >= 5
    assert all(a.foot != b.foot for a, b in zip(steps, steps[1:], strict=False))
    cruise = [k for k, s in enumerate(steps) if cruise_from <= s.t0_ms / 1000 <= cruise_to]
    assert len(cruise) >= 3
    lift_offs = np.array([steps[k].t0_ms for k in cruise])
    cadence = 1000.0 / np.median(np.diff(lift_offs))
    assert 1.6 <= cadence <= 2.2  # steps per second
    lengths = step_lengths(feet, fps)
    assert np.all(lengths <= SETTINGS.max_step_m + 1e-9)
    assert 0.35 <= np.median(lengths[cruise]) <= 0.45
    for k in cruise:
        step = steps[k]
        assert 300 <= step.t1_ms - step.t0_ms <= 450
        k0, k1 = frame(step.t0_ms, fps), frame(step.t1_ms, fps)
        lift = feet.ankle[k0:k1, step.foot, 1] - g1.ankle_height
        assert lift.max() >= 0.05  # clearance mid-swing
        assert abs(feet.swing[k0 + int(np.argmax(lift)), step.foot] - 0.5) <= 0.5 / (k1 - k0) + 1e-9
    # The feet end in stance under the final pelvis.
    final = rest_spots(g1, pelvis[-1:], yaw[-1:])[0]
    assert np.linalg.norm(feet.ankle[-1][:, [0, 2]] - final, axis=1).max() <= SETTINGS.settle_m
    # A planted foot stays within the leg's reach of its hip (sinking reach_slack_m to get it).
    hip_h = pelvis[:, 1] - g1.ankle_height - SETTINGS.reach_slack_m
    reach = np.sqrt(float(-g1.stance[0][2]) ** 2 - hip_h**2)
    off = np.linalg.norm(feet.ankle[..., [0, 2]] - rest_spots(g1, pelvis, yaw), axis=2)
    planted = np.isnan(feet.swing)
    assert np.all(off[planted] <= np.broadcast_to(reach[:, None], off.shape)[planted] + 1e-9)


def test_walking_steps_land_ahead_of_the_hip_and_the_body_passes_over_them(g1):
    t, pelvis, yaw, _ = walk(g1)

    feet = plan(g1, t * 1000, pelvis, yaw)

    for step in feet.steps[1:-2]:  # walking steps
        k1 = frame(step.t1_ms, 30)
        hip = rest_spots(g1, pelvis, yaw)[:, step.foot, 0]
        assert step.end[0] > hip[k1] + 0.05  # lands ahead of its hip
        later = np.flatnonzero(hip[k1:] >= step.end[0])
        assert len(later) and later[0] / 30 <= 0.6  # and the hip gets there soon


@pytest.mark.parametrize(("turn_deg", "seconds"), [(90, 1.5), (180, 2.0), (-120, 1.5)])
def test_a_turn_in_place_steps_the_feet_round_with_the_body(g1, turn_deg, seconds):
    t, pelvis, _ = track(g1, seconds + 3)
    yaw = math.radians(turn_deg) * smoothstep((t - 0.5) / seconds)

    feet = plan(g1, t * 1000, pelvis, yaw)

    assert_well_formed(g1, feet, fps=30)
    steps = feet.steps
    assert len(steps) >= 2
    assert all(a.foot != b.foot for a, b in zip(steps, steps[1:], strict=False))
    for step in steps:
        assert abs(step.end_yaw - step.start_yaw) <= SETTINGS.max_step_yaw_rad + 1e-9
        assert np.linalg.norm(step.end - step.start) <= 0.25  # around the pelvis, not away
    assert np.all(np.abs(feet.yaw[:, 0] - feet.yaw[:, 1]) <= SETTINGS.max_splay_rad + 1e-9)
    assert np.all(np.abs(feet.yaw[-1] - math.radians(turn_deg)) <= SETTINGS.settle_yaw_rad)
    final = rest_spots(g1, pelvis[-1:], yaw[-1:])[0]
    assert np.linalg.norm(feet.ankle[-1][:, [0, 2]] - final, axis=1).max() <= SETTINGS.settle_m
    assert width(feet, yaw).min() >= SETTINGS.min_width_m - 1e-9


def test_a_jump_of_the_pelvis_is_caught_up_in_capped_steps(g1):
    t, pelvis, yaw = track(g1, 6)
    pelvis[t >= 1.0, 0] = 1.5  # the body jumps 1.5 m forward in one frame

    feet = plan(g1, t * 1000, pelvis, yaw)

    assert_well_formed(g1, feet, fps=30)
    steps = feet.steps
    assert len(steps) >= 4  # several steps, not one giant one
    assert all(a.foot != b.foot for a, b in zip(steps, steps[1:], strict=False))
    assert np.all(step_lengths(feet, 30) <= SETTINGS.max_step_m + 1e-9)
    for step in steps:
        assert np.linalg.norm(step.end - step.start) <= 2 * SETTINGS.max_step_m + 1e-9
    final = rest_spots(g1, pelvis[-1:], yaw[-1:])[0]
    assert np.linalg.norm(feet.ankle[-1][:, [0, 2]] - final, axis=1).max() <= SETTINGS.settle_m


def test_a_sidestep_leads_with_the_foot_on_that_side_and_the_feet_never_cross(g1):
    for direction, leader in ((1.0, 0), (-1.0, 1)):  # to the left (-z at yaw 0), to the right
        t, pelvis, yaw = track(g1, 4)
        pelvis[:, 2] = -direction * 0.6 * smoothstep((t - 0.5) / 1.5)

        feet = plan(g1, t * 1000, pelvis, yaw)

        assert_well_formed(g1, feet, fps=30)
        assert feet.steps[0].foot == leader
        assert width(feet, yaw).min() >= SETTINGS.min_width_m - 1e-9


@pytest.mark.parametrize("path", ["circle", "zigzag"])
def test_the_feet_never_cross_on_a_curving_walk(g1, path):
    t, pelvis, _ = track(g1, 12)
    if path == "circle":  # a 1 m radius at 0.6 m/s
        angle = 0.6 * t
        pelvis[:, 0], pelvis[:, 2] = np.sin(angle), -(1 - np.cos(angle))
        yaw = angle
    else:  # weaving +-40 degrees at 0.7 m/s
        yaw = math.radians(40) * np.sin(2 * np.pi * t / 4)
        pelvis[:, 0] = np.cumsum(0.7 * np.cos(yaw)) / 30
        pelvis[:, 2] = -np.cumsum(0.7 * np.sin(yaw)) / 30

    feet = plan(g1, t * 1000, pelvis, yaw)

    assert_well_formed(g1, feet, fps=30)
    assert len(feet.steps) >= 15
    assert all(a.foot != b.foot for a, b in zip(feet.steps, feet.steps[1:], strict=False))
    assert width(feet, yaw).min() >= SETTINGS.min_width_m - 1e-9


def test_frames_without_a_pose_have_no_feet_and_no_swing_crosses_a_gap(g1):
    t, pelvis, yaw = track(g1, 6)
    pelvis[:15] = np.nan  # before the first pose
    pelvis[60:75] = np.nan  # the body stays where it was

    feet = plan(g1, t * 1000, pelvis, yaw)

    assert np.isnan(feet.ankle[:15]).all() and np.isnan(feet.yaw[:15]).all()
    assert np.isnan(feet.ankle[60:75]).all() and np.isnan(feet.swing[60:75]).all()
    assert feet.steps == ()
    assert np.allclose(feet.ankle[15][:, [0, 2]], rest_spots(g1, pelvis[15:16], yaw[15:16])[0])
    assert np.array_equal(feet.ankle[75], feet.ankle[59])  # resumed where they were

    # A walk with a gap: a short move during it resumes and steps on, a long one re-plants.
    for moved, replant in ((0.25, False), (3.0, True)):
        t, pelvis, yaw = track(g1, 6)
        pelvis[:, 0] = np.where(t < 2.0, 0.0, moved)
        pelvis[45:75] = np.nan

        feet = plan(g1, t * 1000, pelvis, yaw)

        assert_well_formed(g1, feet, fps=30)
        for step in feet.steps:  # no swing spans the gap
            assert frame(step.t1_ms, 30) < 45 or frame(step.t0_ms, 30) >= 75
        spots = rest_spots(g1, pelvis[75:76], yaw[75:76])[0]
        if replant:
            assert np.allclose(feet.ankle[75][:, [0, 2]], spots)
        else:
            assert np.array_equal(feet.ankle[75], feet.ankle[44])
            assert len(feet.steps) >= 2
            final = feet.ankle[-1][:, [0, 2]]
            assert np.linalg.norm(final - spots, axis=1).max() <= SETTINGS.settle_m

    nothing = plan(g1, t * 1000, np.full_like(pelvis, np.nan), yaw)
    assert nothing.steps == () and np.isnan(nothing.ankle).all()


def test_planning_five_minutes_of_wandering_is_quick_and_well_formed(g1):
    t, pelvis, yaw = wander(g1, 300)

    start = time.perf_counter()
    feet = plan(g1, t * 1000, pelvis, yaw)
    elapsed = time.perf_counter() - start

    assert elapsed < 1.0  # about 20 ms on a laptop
    assert_well_formed(g1, feet, fps=30)
    assert len(feet.steps) > 300
    # The body turns at most 120 degrees/s here; the bow around the support foot is smooth, so
    # a swing can come a few millimeters inside min_width_m in a tight curve.
    assert width(feet, yaw).min() >= SETTINGS.min_width_m - 0.015
    # Planted feet past the leg's reach step within one swing (the last swing never fits).
    hip_h = pelvis[:, 1] - g1.ankle_height - SETTINGS.reach_slack_m
    reach = np.sqrt(float(-g1.stance[0][2]) ** 2 - hip_h**2)[:, None]
    off = np.linalg.norm(feet.ankle[..., [0, 2]] - rest_spots(g1, pelvis, yaw), axis=2)
    beyond = (off > reach) & np.isnan(feet.swing)
    beyond[-15:] = False
    for i in (0, 1):
        runs = np.diff(np.flatnonzero(np.diff(np.concatenate([[0], beyond[:, i], [0]]))))[::2]
        assert runs.max(initial=0) <= round(SETTINGS.max_swing_ms * 30 / 1000)


def test_the_plan_is_deterministic(g1):
    t, pelvis, yaw = wander(g1, 30, seed=3)

    a = plan(g1, t * 1000, pelvis, yaw)
    b = plan(g1, t * 1000, pelvis, yaw)

    assert np.array_equal(a.ankle, b.ankle, equal_nan=True)
    assert np.array_equal(a.swing, b.swing, equal_nan=True)
    assert [(s.foot, s.t0_ms, s.end.tolist()) for s in a.steps] == [
        (s.foot, s.t0_ms, s.end.tolist()) for s in b.steps
    ]


def test_settings_shape_the_gait(g1):
    t, pelvis, yaw, _ = walk(g1)

    short = plan(g1, t * 1000, pelvis, yaw, settings=GaitSettings(max_step_m=0.25))
    usual = plan(g1, t * 1000, pelvis, yaw)

    assert np.all(step_lengths(short, 30) <= 0.25 + 1e-9)
    assert len(short.steps) > len(usual.steps)
