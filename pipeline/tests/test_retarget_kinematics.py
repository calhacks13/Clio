import math

import numpy as np
import pytest
from numpy.testing import assert_allclose

from clio_pipeline.retarget import DEFAULT_PROFILE, load_profile
from clio_pipeline.retarget.kinematics import (
    Chain,
    matrix_to_quat,
    quat_to_matrix,
    rotation_vector,
)
from clio_pipeline.retarget.urdf import UrdfError, parse_urdf, rpy_matrix

# A small arm with every supported joint type: yaw, pitch, a slide, a fixed tool frame turned 90
# degrees about z, and a finger that mimics the slide at half speed.
TEST_URDF = """<?xml version="1.0"?>
<robot name="test_arm">
  <link name="base"/><link name="l1"/><link name="l2"/><link name="l3"/>
  <link name="tool"/><link name="finger"/>
  <joint name="yaw" type="revolute">
    <parent link="base"/><child link="l1"/>
    <origin xyz="0 0 0.1"/><axis xyz="0 0 1"/>
    <limit lower="-3" upper="3" effort="1" velocity="1"/>
  </joint>
  <joint name="pitch" type="continuous">
    <parent link="l1"/><child link="l2"/>
    <origin xyz="0 0 0.2" rpy="0 0 0"/><axis xyz="0 2 0"/>
  </joint>
  <joint name="slide" type="prismatic">
    <parent link="l2"/><child link="l3"/>
    <origin xyz="0.3 0 0"/><axis xyz="1 0 0"/>
    <limit lower="0" upper="0.1" effort="1" velocity="1"/>
  </joint>
  <joint name="tool_mount" type="fixed">
    <parent link="l3"/><child link="tool"/>
    <origin xyz="0.05 0 0" rpy="0 0 1.5707963267948966"/>
  </joint>
  <joint name="finger_joint" type="prismatic">
    <parent link="l3"/><child link="finger"/>
    <origin xyz="0 0 0.02"/><axis xyz="0 0 1"/>
    <limit lower="0" upper="0.05" effort="1" velocity="1"/>
    <mimic joint="slide" multiplier="0.5" offset="0.01"/>
    <visual><geometry><box size="0.01 0.01 0.01"/></geometry></visual>
  </joint>
</robot>
"""


def _replace(text: str, old: str, new: str) -> str:
    assert old in text
    return text.replace(old, new)


def test_urdf_reader_reads_joints_origins_axes_limits_and_mimics():
    urdf = parse_urdf(TEST_URDF)

    assert (urdf.name, urdf.root) == ("test_arm", "base")
    assert list(urdf.joints) == ["yaw", "pitch", "slide", "tool_mount", "finger_joint"]
    pitch, slide = urdf.joints["pitch"], urdf.joints["slide"]
    assert_allclose(pitch.axis, [0, 1, 0])  # normalized
    assert (pitch.lower, pitch.upper) == (-math.inf, math.inf)  # continuous
    assert (slide.lower, slide.upper) == (0.0, 0.1)
    assert_allclose(urdf.joints["tool_mount"].origin[:3, 3], [0.05, 0, 0])
    assert_allclose(urdf.joints["tool_mount"].origin[:3, :3], rpy_matrix(0, 0, math.pi / 2))
    finger = urdf.joints["finger_joint"]
    assert (finger.mimic.joint, finger.mimic.multiplier, finger.mimic.offset) == (
        "slide",
        0.5,
        0.01,
    )
    assert not finger.actuated and finger.moves
    assert [j.name for j in urdf.chain("base", "tool")] == ["yaw", "pitch", "slide", "tool_mount"]


def test_urdf_rpy_is_fixed_axis_roll_then_pitch_then_yaw():
    R = rpy_matrix(0.3, -0.2, 1.1)

    def axis_rotation(axis, angle):
        return quat_to_matrix([*(np.array(axis) * math.sin(angle / 2)), math.cos(angle / 2)])

    expected = axis_rotation([0, 0, 1], 1.1) @ axis_rotation([0, 1, 0], -0.2)
    assert_allclose(R, expected @ axis_rotation([1, 0, 0], 0.3), atol=1e-12)


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        ('type="continuous"', 'type="floating"', "not supported"),
        ('type="continuous"', 'type="planar"', "not supported"),
        ('<limit lower="0" upper="0.1" effort="1" velocity="1"/>', "", "needs <limit>"),
        ('lower="-3" upper="3"', 'lower="3" upper="-3"', "above upper"),
        ('<axis xyz="0 0 1"/>', '<axis xyz="0 0 0"/>', "axis is zero"),
        ('<origin xyz="0.3 0 0"/>', '<origin xyz="0.3 0"/>', "expected 3 numbers"),
        ('mimic joint="slide"', 'mimic joint="nope"', "unknown joint"),
        ('<child link="tool"/>', '<child link="l2"/>', "more than one parent"),
        (
            '<parent link="l3"/><child link="tool"/>',
            '<parent link="ghost"/><child link="tool"/>',
            "not defined",
        ),
        ('<link name="tool"/>', '<link name="tool"/><link name="island"/>', "one root link"),
        ('<robot name="test_arm">', "<robot>", "no 'name'"),
    ],
)
def test_urdf_reader_rejects_what_it_does_not_support_with_a_clear_error(old, new, message):
    with pytest.raises(UrdfError, match=message):
        parse_urdf(_replace(TEST_URDF, old, new))


def test_urdf_reader_rejects_text_that_is_not_xml():
    with pytest.raises(UrdfError, match="not valid XML"):
        parse_urdf("<robot name='x'>")


def test_chain_folds_fixed_joints_and_lists_actuated_joints_in_order():
    chain = Chain(parse_urdf(TEST_URDF), "base", "tool")

    assert chain.joint_names == ("yaw", "pitch", "slide")
    assert chain.dof == 3
    assert_allclose(chain.lower, [-3, -math.inf, 0])


def test_forward_kinematics_matches_a_hand_computed_configuration():
    chain = Chain(parse_urdf(TEST_URDF), "base", "tool")

    # yaw 90 deg turns the slide (along l2's x) to +y; the tool sits 0.05 further, turned 180.
    R, p = chain.tip([math.pi / 2, 0.0, 0.1])
    assert_allclose(p, [0, 0.45, 0.3], atol=1e-12)
    assert_allclose(R, rpy_matrix(0, 0, math.pi), atol=1e-12)
    # pitch 90 deg about y turns l2's x to -z: the tool hangs below the pitch joint.
    R, p = chain.tip([0.0, math.pi / 2, 0.1])
    assert_allclose(p, [0, 0, 0.3 - 0.45], atol=1e-12)


def test_points_run_from_the_base_through_every_joint_to_the_tool():
    chain = Chain(parse_urdf(TEST_URDF), "base", "tool")

    points = chain.points([math.pi / 2, 0.0, 0.1])

    # base, yaw, pitch, slide (its child frame, after moving 0.1), tool
    assert_allclose(
        points, [[0, 0, 0], [0, 0, 0.1], [0, 0, 0.3], [0, 0.4, 0.3], [0, 0.45, 0.3]], atol=1e-12
    )


def test_example_arm_points_straight_up_with_every_joint_at_zero():
    arm = load_profile(DEFAULT_PROFILE).arms[0]

    R, p = arm.chain.tip(np.zeros(arm.chain.dof))

    assert_allclose(p, [0, 0, 0.79], atol=1e-12)  # 0.1 + 0.06 + 0.25 + 0.22 + 0.05 + 0.11
    assert_allclose(R, np.eye(3), atol=1e-12)


def _finite_difference_jacobian(chain: Chain, q: np.ndarray, h: float = 1e-6) -> np.ndarray:
    J = np.zeros((6, chain.dof))
    for i in range(chain.dof):
        dq = np.zeros(chain.dof)
        dq[i] = h
        R_plus, p_plus = chain.tip(q + dq)
        R_minus, p_minus = chain.tip(q - dq)
        J[:3, i] = (p_plus - p_minus) / (2 * h)
        J[3:, i] = rotation_vector(R_plus @ R_minus.T) / (2 * h)
    return J


@pytest.mark.parametrize("tip", ["tool", "finger"])
def test_jacobian_matches_finite_differences_including_prismatic_and_mimic_joints(tip):
    chain = Chain(parse_urdf(TEST_URDF), "base", tip)
    rng = np.random.default_rng(3)

    for _ in range(20):
        q = np.array([rng.uniform(-3, 3), rng.uniform(-3, 3), rng.uniform(0, 0.1)])
        assert_allclose(
            chain.jacobian(chain.forward(q)), _finite_difference_jacobian(chain, q), atol=1e-6
        )


def test_jacobian_of_the_example_arm_matches_finite_differences():
    chain = load_profile(DEFAULT_PROFILE).arms[1].chain
    rng = np.random.default_rng(4)

    for _ in range(50):
        q = chain.lower + (chain.upper - chain.lower) * rng.random(chain.dof)
        assert_allclose(
            chain.jacobian(chain.forward(q)), _finite_difference_jacobian(chain, q), atol=1e-6
        )


def test_a_mimic_joint_whose_leader_is_off_the_chain_is_rejected():
    urdf = parse_urdf(_replace(TEST_URDF, 'mimic joint="slide"', 'mimic joint="yaw"'))

    with pytest.raises(UrdfError, match="not on the chain"):
        Chain(urdf, "l1", "finger")


def test_quaternion_and_matrix_conversions_round_trip():
    rng = np.random.default_rng(5)
    q = rng.normal(size=(200, 4))
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    q[q[:, 3] < 0] *= -1  # matrix_to_quat returns w >= 0

    assert_allclose(matrix_to_quat(quat_to_matrix(q)), q, atol=1e-12)
    assert_allclose(matrix_to_quat(quat_to_matrix([0, 0, 1, 0])), [0, 0, 1, 0], atol=1e-12)
