"""Template walking for the G1's feet, planned from the pelvis track alone.

The Quest measures the head and the hands, never the feet, so the G1 walks the way a G1 would
when its pelvis moves the way the learner's did: a plausible gait, not the one that happened. The
whole track is known (this runs after the recording), so the planner looks ahead. It is
deterministic, and sequential over frames (one foot's step depends on where the other one is).

1. Rest spots. Each foot belongs at its stance offset around the pelvis, on the floor, in the
   body's heading. A planted foot does not move at all while the body sways near it.
2. When. A foot steps once its rest spot at the time it would touch down (were it to lift now)
   is more than trigger_m off or turned more than trigger_yaw_rad. Just after a step the
   thresholds drop to settle_m and settle_yaw_rad for up to two steps, so a walk ends square. A
   step hurries when a planted foot is about to be out of the leg's reach from its hip (the hip
   is at the pelvis height and may sink reach_slack_m to reach) or the body is turning across
   the feet.
3. Rhythm. One foot in the air at a time, both down for min_double_support_ms at least. Walking,
   lift-offs are a step period apart from a constant walk ratio (step length over cadence),
   T = sqrt(walk_ratio / v): 0.5 s and 0.4 m steps at 0.8 m/s, longer periods and shorter steps
   when slower. A turn counts as walking at turn_lever_m times its rate. A foot is in the air for
   swing_share of the period, less for a short step, within [min_swing_ms, max_swing_ms] and
   never faster than max_foot_speed_m_s at the peak.
4. Where. On the rest spot under the pelvis a lead after touch-down (half the foot's stance
   phase, at most max_lead_ms), so the hip passes over the foot mid-stance. Its heading turns at
   most max_step_yaw_rad from where it was and stays within max_splay_rad of the other foot. It
   lands at most max_step_m ahead of its place beside the support foot (max_back_step_m behind,
   max_side_step_m outside), so a long move is caught up in several steps, and min_width_m or
   more to its own side of the support foot, in the body frame at touch-down and in the feet's
   own (mean heading) frame.
5. Which foot. The one whose step takes away the most error (distance plus heading); the foot
   that stepped last counts less, so a walk alternates and a sidestep leads with its own foot.
6. Swing. Minimum-jerk from lift-off to touch-down (zero velocity and acceleration at both ends),
   the heading the same way, lifted by a smooth bump of clearance_m (min_clearance_m for a step
   in place) and bowed out by the same bump where it would pass inside min_width_m of the support
   foot (a straight swing cuts inside a curve); exactly at the landing spot, sole on the floor,
   at touch-down.
7. Gaps. No pose, no feet, and no swing across a gap. After one the feet resume where they were
   if each is still near its rest spot, else both re-plant in stance.

The feet never cross in their own frame. In the body frame they stay min_width_m apart while the
body turns no faster than steps can follow (about 120 degrees/s: each step turns a foot at most
max_step_yaw_rad, within max_splay_rad of the other); a faster spin of the body yaw leaves the
planted feet behind it for a step or two.

World frame: the local floor, y up, floor at y = 0, meters. A body yaw faces (cos, 0, -sin); its
left is (-sin, 0, -cos). Feet are the ankle-roll origin, ankle_height above a flat sole. Foot yaw
is continuous (it follows the branch of the body yaw it was planted with), not wrapped.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

_SAME_FOOT = 0.6  # the foot that stepped last counts this share of its gain: feet alternate
_YAW_M_PER_RAD = 0.2  # a heading error weighs like this many meters per radian
_MIN_GAIN_M = 0.02  # a step must take away at least this much error
_SETTLE_STEPS = 2  # settle steps in a row, at most (one per foot)
_SIDE = (1.0, -1.0)  # left foot on the +left side, right foot on the -left side
_ALIGNED_RAD = math.radians(60)  # the body frame keeps the feet apart while this near theirs


@dataclass(frozen=True)
class GaitSettings:
    """How the G1 walks, tuned for its size: ankle positions on the floor, in G1 meters."""

    trigger_m: float = 0.14  # a planted foot steps once its landing spot is this far off...
    trigger_yaw_rad: float = math.radians(30)  # ... or turned this far from its heading
    settle_m: float = 0.04  # just after a step, a foot squares up past this...
    settle_yaw_rad: float = math.radians(8)  # ... or this turn
    settle_ms: float = 1000.0  # after a touch-down, the feet square up for this long
    max_step_m: float = 0.42  # landing ahead of its place beside the support foot, at most
    max_back_step_m: float = 0.25  # ... behind it
    max_side_step_m: float = 0.2  # ... outside it
    min_width_m: float = 0.14  # ankles apart sideways in the body frame, at least (stance 0.237)
    max_step_yaw_rad: float = math.radians(90)  # a foot's turn in one step
    max_splay_rad: float = math.radians(60)  # between the two feet's headings
    walk_ratio: float = 0.2  # step length (m) over cadence (steps/s): 0.4 m at 2/s is 0.8 m/s
    turn_lever_m: float = 0.3  # turning at w rad/s keeps the rhythm of walking at w * this
    max_period_ms: float = 800.0  # the slowest rhythm: shuffles, turns, squaring up
    swing_share: float = 0.8  # of the step period a foot is in the air
    min_swing_ms: float = 300.0
    max_swing_ms: float = 440.0
    max_foot_speed_m_s: float = 4.5  # peak ankle speed in a swing (1.875x its mean speed)
    min_double_support_ms: float = 80.0  # both feet down between steps, at least
    lead_share: float = 0.5  # of its stance, when the hip passes over a landed foot
    max_lead_ms: float = 300.0
    clearance_m: float = 0.065  # swing lift for a step of max_step_m or longer...
    min_clearance_m: float = 0.025  # ... and for a step in place
    reach_slack_m: float = 0.06  # the hip may sink this far below the pelvis to reach a foot...
    min_reach_m: float = 0.2  # ... and the leg always reaches this far along the floor
    resume_m: float = 0.4  # after a gap the feet stay if each is this near its rest spot...
    resume_yaw_rad: float = math.radians(60)  # ... and turned less than this from it
    speed_window_ms: float = 500.0  # the body's speed and turn rate, measured this far ahead


DEFAULT_SETTINGS = GaitSettings()


@dataclass(frozen=True, eq=False)
class Step:
    foot: int  # 0 left, 1 right
    t0_ms: float  # lift-off
    t1_ms: float  # touch-down
    start: np.ndarray  # (3,) ankle at lift-off, world
    end: np.ndarray  # (3,) ankle at touch-down, world
    start_yaw: float
    end_yaw: float


@dataclass(frozen=True, eq=False)
class FootPlan:
    ankle: np.ndarray  # (M, 2, 3) ankle-roll origin per frame and foot, world; NaN where no pose
    yaw: np.ndarray  # (M, 2) foot heading, rad; NaN where no pose
    swing: np.ndarray  # (M, 2) swing phase in (0, 1) while the foot is in the air, else NaN
    steps: tuple[Step, ...]


def plan_footsteps(
    t_ms: np.ndarray,
    pelvis: np.ndarray,
    yaw: np.ndarray,
    *,
    stance: np.ndarray,
    ankle_height: float,
    leg_length: float,
    settings: GaitSettings = DEFAULT_SETTINGS,
) -> FootPlan:
    """Both feet over the whole track: planted spots, steps and swing trajectories.

    `t_ms` (M,) is a uniform grid; `pelvis` (M, 3) and `yaw` (M,) are the body, NaN where it has
    no pose; `stance` (2, 2) is each ankle's (forward, left) offset from the pelvis, left foot
    first; `leg_length` is the hip (at the pelvis height) to the ankle, straight.
    """
    s = settings
    t = np.asarray(t_ms, dtype=np.float64)
    pelvis = np.asarray(pelvis, dtype=np.float64)
    yaw = np.asarray(yaw, dtype=np.float64)
    stance = np.asarray(stance, dtype=np.float64)
    m = len(t)
    if t.shape != (m,) or pelvis.shape != (m, 3) or yaw.shape != (m,) or stance.shape != (2, 2):
        raise ValueError("t_ms (M,), pelvis (M, 3), yaw (M,) and stance (2, 2) are expected")
    ankle = np.full((m, 2, 3), np.nan)
    foot_yaw = np.full((m, 2), np.nan)
    phase = np.full((m, 2), np.nan)
    valid = np.isfinite(pelvis).all(axis=1) & np.isfinite(yaw)
    if not valid.any():
        return FootPlan(ankle=ankle, yaw=foot_yaw, swing=phase, steps=())

    dt = float(np.median(np.diff(t))) if m > 1 else 1000.0 / 30
    k = np.arange(m)
    ends = np.flatnonzero(valid & ~np.append(valid[1:], False))
    seg_end = ends[np.minimum(np.searchsorted(ends, k), len(ends) - 1)]  # last frame of the run

    px = np.where(valid, pelvis[:, 0], 0.0)
    py = np.where(valid, pelvis[:, 1], 0.0)
    pz = np.where(valid, pelvis[:, 2], 0.0)
    by = np.where(valid, yaw, 0.0)
    cos, sin = np.cos(by), np.sin(by)
    fwd_x, fwd_z, left_x, left_z = cos, -sin, -sin, -cos
    spot_x = [px + stance[i, 0] * fwd_x + stance[i, 1] * left_x for i in (0, 1)]
    spot_z = [pz + stance[i, 0] * fwd_z + stance[i, 1] * left_z for i in (0, 1)]

    # The rhythm from the body's speed and turn rate just ahead.
    kw = np.minimum(k + max(1, round(s.speed_window_ms / dt)), seg_end)
    span_s = np.maximum(kw - k, 1) * dt / 1000.0
    speed = np.hypot(px[kw] - px, pz[kw] - pz) / span_s
    turn = np.abs(_wrap_array(by[kw] - by)) / span_s
    brisk_ms = s.min_swing_ms + s.min_double_support_ms
    pace = np.maximum(speed + s.turn_lever_m * turn, 1e-9)
    period = np.clip(1000.0 * np.sqrt(s.walk_ratio / pace), brisk_ms, s.max_period_ms)
    # Catching up (out of reach, or the body turning across the feet): full-length steps' rhythm.
    hurry_ms = float(np.clip(1000.0 * s.walk_ratio / s.max_step_m, brisk_ms, s.max_period_ms))
    swing_guess = np.clip(s.swing_share * period, s.min_swing_ms, s.max_swing_ms)
    ka = np.minimum(k + np.rint(swing_guess / dt).astype(int), seg_end)  # touch-down, if now
    kr = np.minimum(k + max(1, round(s.min_double_support_ms / dt)), seg_end)  # a little ahead
    hip_h = np.maximum(py - ankle_height - s.reach_slack_m, 0.0)
    reach = np.maximum(np.sqrt(np.maximum(leg_length**2 - hip_h**2, 0.0)), s.min_reach_m)

    # Plain lists: the loop below reads single values, much faster than from arrays.
    T = t.tolist()
    VALID = valid.tolist()
    END = seg_end.tolist()
    PX, PZ, YAW = px.tolist(), pz.tolist(), by.tolist()
    FX, FZ, LX, LZ = fwd_x.tolist(), fwd_z.tolist(), left_x.tolist(), left_z.tolist()
    SX = [a.tolist() for a in spot_x]  # rest spots now
    SZ = [a.tolist() for a in spot_z]
    TX = [a[ka].tolist() for a in spot_x]  # ... and at touch-down, were a foot to lift now
    TZ = [a[ka].tolist() for a in spot_z]
    TYAW = by[ka].tolist()
    KA, KR = ka.tolist(), kr.tolist()
    PERIOD, REACH = period.tolist(), reach.tolist()
    st_f, st_l = stance[:, 0].tolist(), stance[:, 1].tolist()
    half_dt = 0.5 * dt

    feet: list[list[float]] = []  # per foot [x, z, yaw] while planted
    since = [0, 0]  # the frame each foot's current plant began
    runs: list[tuple[int, int, int, float, float, float]] = []  # foot, from, to, x, z, yaw
    plans: list[tuple] = []  # foot, lift-off, touch-down, start, end, lift, support foot
    landing: tuple[int, int, float, float, float] | None = None  # foot, frame, x, z, yaw
    last_down = last_up = -math.inf
    last_foot, settles, inside = -1, 0, False

    def place(i: int, k: int, period_ms: float, swing_ms: float, quickest_ms: float = 0.0):
        """Where foot i lands if it lifts at frame k; None if the run ends first."""
        j = 1 - i
        n = max(2, round(swing_ms / dt))
        if n * dt < quickest_ms - 1e-6:
            n += 1
        k1 = k + n
        end = END[k]
        if k1 > end:
            return None
        lead_ms = min(max(s.lead_share * (2 * period_ms - n * dt), 0.0), s.max_lead_ms)
        kl = min(k + round((n * dt + lead_ms) / dt), end)
        xi, zi, yi = feet[i]
        xj, zj, yj = feet[j]
        ty = YAW[kl]
        # Heading: a limited turn, never splayed too far from the support foot.
        turn = _wrap(ty - yi)
        ey = yi + max(-s.max_step_yaw_rad, min(s.max_step_yaw_rad, turn))
        splay = _wrap(ey - yj)
        if splay > s.max_splay_rad:
            ey -= splay - s.max_splay_rad
        elif splay < -s.max_splay_rad:
            ey -= splay + s.max_splay_rad
        c, sn = math.cos(ey), math.sin(ey)
        ex = PX[kl] + st_f[i] * c - st_l[i] * sn
        ez = PZ[kl] - st_f[i] * sn - st_l[i] * c
        # The step's length, around the place beside the support foot, in the touch-down frame.
        fx, fz, lx, lz = FX[k1], FZ[k1], LX[k1], LZ[k1]
        df, dl = st_f[i] - st_f[j], st_l[i] - st_l[j]
        bx = xj + df * fx + dl * lx
        bz = zj + df * fz + dl * lz
        ahead = (ex - bx) * fx + (ez - bz) * fz
        out = ((ex - bx) * lx + (ez - bz) * lz) * _SIDE[i]
        cap = s.max_step_m if ahead > 0 else s.max_back_step_m
        r = (ahead / cap) ** 2 + ((out / s.max_side_step_m) ** 2 if out > 0 else 0.0)
        if r > 1.0:
            q = 1.0 / math.sqrt(r)
            ahead *= q
            if out > 0:
                out *= q
        ex = bx + ahead * fx + out * _SIDE[i] * lx
        ez = bz + ahead * fz + out * _SIDE[i] * lz
        # Never across the support foot: in the body frame at touch-down unless the body has
        # spun away from the feet, then in the frame of the two feet's mean heading.
        mean = yj + 0.5 * _wrap(ey - yj)
        frames = [(-math.sin(mean), -math.cos(mean))]
        if abs(_wrap(YAW[k1] - mean)) < _ALIGNED_RAD:
            frames.insert(0, (lx, lz))
        for lxk, lzk in frames:
            short = s.min_width_m - ((ex - xj) * lxk + (ez - zj) * lzk) * _SIDE[i]
            if short > 0:
                ex += short * _SIDE[i] * lxk
                ez += short * _SIDE[i] * lzk
        # How much nearer its own spot (in the target heading) the step brings the foot.
        tc, ts = math.cos(ty), math.sin(ty)
        gx = PX[kl] + st_f[i] * tc - st_l[i] * ts
        gz = PZ[kl] - st_f[i] * ts - st_l[i] * tc
        before = math.hypot(xi - gx, zi - gz) + _YAW_M_PER_RAD * abs(_wrap(yi - ty))
        after = math.hypot(ex - gx, ez - gz) + _YAW_M_PER_RAD * abs(_wrap(ey - ty))
        return k1, ex, ez, ey, before - after

    for k in range(m):
        if not VALID[k]:
            if inside:
                runs.extend((i, since[i], k, *feet[i]) for i in (0, 1))
                inside = False
            continue
        if not inside:
            inside = True
            near = bool(feet) and all(
                math.hypot(feet[i][0] - SX[i][k], feet[i][1] - SZ[i][k]) <= s.resume_m
                and abs(_wrap(feet[i][2] - YAW[k])) <= s.resume_yaw_rad
                for i in (0, 1)
            )
            if not near:
                feet = [[SX[i][k], SZ[i][k], YAW[k]] for i in (0, 1)]
            since = [k, k]
            last_down = last_up = -math.inf
            last_foot, settles = -1, 0
        if landing is not None:
            if k < landing[1]:
                continue
            i = landing[0]
            feet[i] = list(landing[2:])
            since[i] = k
            last_down = T[k]
            landing = None
        if T[k] - last_down < s.min_double_support_ms - half_dt:
            continue

        # Does a foot need to step?
        settling = T[k] - last_down < s.settle_ms and settles < _SETTLE_STEPS
        over = small = hurry = False
        kr = KR[k]  # lift before the hip leaves a foot out of reach
        for i in (0, 1):
            x, z, fy = feet[i]
            e = math.hypot(x - TX[i][k], z - TZ[i][k])
            ey = abs(_wrap(fy - TYAW[k]))
            if e > s.trigger_m or ey > s.trigger_yaw_rad:
                over = True
            elif e > s.settle_m or ey > s.settle_yaw_rad:
                small = True
            if math.hypot(x - SX[i][kr], z - SZ[i][kr]) > REACH[kr]:
                hurry = True
        # Hurry before the body turns across the feet (by touch-down, were a foot to lift now).
        kd = KA[k]
        width = (feet[0][0] - feet[1][0]) * LX[kd] + (feet[0][1] - feet[1][1]) * LZ[kd]
        if width < s.min_width_m:
            hurry = True
        if not (over or hurry or (settling and small)):
            continue
        period_ms = min(PERIOD[k], hurry_ms) if hurry else PERIOD[k]
        if T[k] - last_up < period_ms - half_dt:
            continue

        # Which foot, and where: the step that takes away the most error.
        best, best_gain = None, _MIN_GAIN_M
        for i in (0, 1):
            swing_ms = min(max(s.swing_share * period_ms, s.min_swing_ms), s.max_swing_ms)
            p = place(i, k, period_ms, swing_ms)
            if p is None:
                continue
            # Again with the swing time that suits the step's length: quicker when short, never
            # faster than the foot can go.
            stride = math.hypot(p[1] - feet[i][0], p[2] - feet[i][1])
            by_length = s.min_swing_ms + (s.max_swing_ms - s.min_swing_ms) * min(
                stride / (2 * s.max_step_m), 1.0
            )
            quickest = 1875.0 * stride / s.max_foot_speed_m_s
            swing_ms = min(max(min(swing_ms, by_length), quickest), s.max_swing_ms)
            p = place(i, k, period_ms, swing_ms, quickest) or p
            gain = p[4] * (_SAME_FOOT if i == last_foot else 1.0)
            if gain > best_gain:
                best, best_gain = (i, p), gain
        if best is None:
            continue
        i, (k1, ex, ez, ey, _) = best
        x, z, fy = feet[i]
        stride = math.hypot(ex - x, ez - z)
        lift = s.min_clearance_m + (s.clearance_m - s.min_clearance_m) * min(
            stride / s.max_step_m, 1.0
        )
        runs.append((i, since[i], k + 1, x, z, fy))
        plans.append((i, k, k1, x, z, fy, ex, ez, ey, lift, *feet[1 - i]))
        landing = (i, k1, ex, ez, ey)
        last_up, last_foot = T[k], i
        settles = 0 if over or hurry else settles + 1
    if inside:
        runs.extend((i, since[i], m, *feet[i]) for i in (0, 1))

    for i, a, b, x, z, fy in runs:
        ankle[a:b, i] = (x, ankle_height, z)
        foot_yaw[a:b, i] = fy
    steps = []
    for i, k0, k1, x, z, fy, ex, ez, ey, lift, xj, zj, yj in plans:
        frames = slice(k0 + 1, k1)
        tau = (t[frames] - t[k0]) / (t[k1] - t[k0])
        blend = tau**3 * (10.0 - 15.0 * tau + 6.0 * tau**2)  # minimum jerk
        bump = 16.0 * tau**2 * (1.0 - tau) ** 2  # 1 mid-swing, flat at both ends
        sx = x + (ex - x) * blend
        sz = z + (ez - z) * blend
        sy = fy + (ey - fy) * blend
        # A straight swing cuts inside a curve: bow it out to min_width_m beside the support
        # foot in the body frame, while the body faces the feet's way.
        lx, lz = left_x[frames], left_z[frames]
        facing = np.abs(_wrap_array(by[frames] - yj - 0.5 * _wrap_array(sy - yj))) < _ALIGNED_RAD
        if facing.all():
            short = s.min_width_m - ((sx - xj) * lx + (sz - zj) * lz) * _SIDE[i]
            out = np.clip(short, 0.0, s.min_width_m) * bump * _SIDE[i]
            sx, sz = sx + out * lx, sz + out * lz
        ankle[frames, i, 0] = sx
        ankle[frames, i, 1] = ankle_height + lift * bump
        ankle[frames, i, 2] = sz
        foot_yaw[frames, i] = sy
        phase[frames, i] = tau
        steps.append(
            Step(
                foot=i,
                t0_ms=T[k0],
                t1_ms=T[k1],
                start=np.array([x, ankle_height, z]),
                end=np.array([ex, ankle_height, ez]),
                start_yaw=fy,
                end_yaw=ey,
            )
        )
    return FootPlan(ankle=ankle, yaw=foot_yaw, swing=phase, steps=tuple(steps))


def _wrap(a: float) -> float:
    return (a + math.pi) % (2 * math.pi) - math.pi


def _wrap_array(a: np.ndarray) -> np.ndarray:
    return (a + np.pi) % (2 * np.pi) - np.pi
