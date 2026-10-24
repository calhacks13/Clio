"""A small URDF reader for kinematic chains (standard library XML only).

Reads links and joints: type, parent and child, origin xyz/rpy, axis, limits and mimic. Visual,
collision, inertial, transmission and gazebo elements are ignored. Floating and planar joints are
rejected, as is anything that is not a tree with one root link.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SUPPORTED_JOINTS = ("revolute", "continuous", "prismatic", "fixed")


class UrdfError(ValueError):
    """The URDF is malformed or uses something this reader does not support."""


@dataclass(frozen=True)
class Mimic:
    """value = multiplier * value(joint) + offset"""

    joint: str
    multiplier: float
    offset: float


@dataclass(frozen=True, eq=False)
class Joint:
    name: str
    type: str  # one of SUPPORTED_JOINTS
    parent: str
    child: str
    origin: np.ndarray  # (4, 4) the joint frame (= child link frame at zero) in the parent link
    axis: np.ndarray  # (3,) unit vector in the joint frame; zeros for fixed joints
    lower: float  # -inf for continuous joints
    upper: float  # +inf for continuous joints
    mimic: Mimic | None

    @property
    def moves(self) -> bool:
        return self.type != "fixed"

    @property
    def actuated(self) -> bool:
        """Moves and is not driven by another joint."""
        return self.moves and self.mimic is None


@dataclass(frozen=True, eq=False)
class Urdf:
    name: str
    root: str
    links: tuple[str, ...]
    joints: dict[str, Joint]  # file order

    def parent_joint(self, link: str) -> Joint | None:
        """The joint whose child is `link`; None for the root."""
        return self._parents().get(link)

    def chain(self, base_link: str, tip_link: str) -> list[Joint]:
        """Joints from `base_link` down to `tip_link`, in order."""
        for link in (base_link, tip_link):
            if link not in self.links:
                raise UrdfError(f"robot {self.name!r} has no link {link!r}")
        joints: list[Joint] = []
        link = tip_link
        while link != base_link:
            joint = self.parent_joint(link)
            if joint is None:
                raise UrdfError(f"link {tip_link!r} is not below {base_link!r}")
            joints.append(joint)
            link = joint.parent
        return joints[::-1]

    def _parents(self) -> dict[str, Joint]:
        return {joint.child: joint for joint in self.joints.values()}


def load_urdf(path: Path | str) -> Urdf:
    path = Path(path)
    try:
        return parse_urdf(path.read_text(encoding="utf-8"))
    except UrdfError as e:
        raise UrdfError(f"{path}: {e}") from None


def parse_urdf(text: str) -> Urdf:
    try:
        robot = ET.fromstring(text)
    except ET.ParseError as e:
        raise UrdfError(f"not valid XML ({e})") from None
    if robot.tag != "robot":
        raise UrdfError(f"root element is <{robot.tag}>, expected <robot>")
    name = _required(robot, "name", "<robot>")

    links: list[str] = []
    for el in robot.findall("link"):
        link = _required(el, "name", "<link>")
        if link in links:
            raise UrdfError(f"link {link!r} is defined twice")
        links.append(link)
    if not links:
        raise UrdfError("no links")

    joints: dict[str, Joint] = {}
    for el in robot.findall("joint"):
        joint = _joint(el, links)
        if joint.name in joints:
            raise UrdfError(f"joint {joint.name!r} is defined twice")
        joints[joint.name] = joint
    _check_mimics(joints)
    root = _check_tree(links, joints)
    return Urdf(name=name, root=root, links=tuple(links), joints=joints)


def rpy_matrix(roll: float, pitch: float, yaw: float) -> np.ndarray:
    """URDF fixed-axis roll, pitch, yaw: R = Rz(yaw) @ Ry(pitch) @ Rx(roll)."""
    cr, sr = math.cos(roll), math.sin(roll)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cy, sy = math.cos(yaw), math.sin(yaw)
    return np.array(
        [
            [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
            [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
            [-sp, cp * sr, cp * cr],
        ]
    )


def _joint(el: ET.Element, links: list[str]) -> Joint:
    name = _required(el, "name", "<joint>")
    where = f"joint {name!r}"
    kind = _required(el, "type", where)
    if kind not in SUPPORTED_JOINTS:
        raise UrdfError(f"{where}: type {kind!r} is not supported (only {SUPPORTED_JOINTS})")
    parent = _link_ref(el, "parent", where, links)
    child = _link_ref(el, "child", where, links)

    origin = np.eye(4)
    origin_el = el.find("origin")
    if origin_el is not None:
        origin[:3, :3] = rpy_matrix(*_floats(origin_el.get("rpy"), 3, f"{where} origin rpy"))
        origin[:3, 3] = _floats(origin_el.get("xyz"), 3, f"{where} origin xyz")

    axis = np.zeros(3)
    lower, upper = -math.inf, math.inf
    if kind != "fixed":
        axis_el = el.find("axis")
        xyz = axis_el.get("xyz") if axis_el is not None else None
        axis = np.array(_floats(xyz, 3, f"{where} axis") if xyz else (1.0, 0.0, 0.0))  # default
        norm = float(np.linalg.norm(axis))
        if norm < 1e-9:
            raise UrdfError(f"{where}: axis is zero")
        axis = axis / norm
    if kind in ("revolute", "prismatic"):
        limit = el.find("limit")
        if limit is None:
            raise UrdfError(f"{where}: a {kind} joint needs <limit>")
        lower = _float(limit.get("lower", "0"), f"{where} limit lower")
        upper = _float(limit.get("upper", "0"), f"{where} limit upper")
        if lower > upper:
            raise UrdfError(f"{where}: limit lower {lower} is above upper {upper}")

    mimic = None
    mimic_el = el.find("mimic")
    if mimic_el is not None:
        if kind == "fixed":
            raise UrdfError(f"{where}: a fixed joint cannot mimic another")
        mimic = Mimic(
            joint=_required(mimic_el, "joint", f"{where} <mimic>"),
            multiplier=_float(mimic_el.get("multiplier", "1"), f"{where} mimic multiplier"),
            offset=_float(mimic_el.get("offset", "0"), f"{where} mimic offset"),
        )
    return Joint(name, kind, parent, child, origin, axis, lower, upper, mimic)


def _check_mimics(joints: dict[str, Joint]) -> None:
    for joint in joints.values():
        if joint.mimic is None:
            continue
        leader = joints.get(joint.mimic.joint)
        if leader is None:
            raise UrdfError(f"joint {joint.name!r} mimics unknown joint {joint.mimic.joint!r}")
        if not leader.actuated:
            raise UrdfError(
                f"joint {joint.name!r} mimics {leader.name!r}, which is fixed or itself a mimic"
            )


def _check_tree(links: list[str], joints: dict[str, Joint]) -> str:
    """One root link, every other link has exactly one parent joint, no cycles."""
    parent_of: dict[str, str] = {}
    for joint in joints.values():
        if joint.child in parent_of:
            raise UrdfError(f"link {joint.child!r} has more than one parent joint")
        if joint.child == joint.parent:
            raise UrdfError(f"joint {joint.name!r} connects link {joint.child!r} to itself")
        parent_of[joint.child] = joint.parent
    roots = [link for link in links if link not in parent_of]
    if len(roots) != 1:
        raise UrdfError(f"expected one root link, found {roots or 'none'}")
    for link in links:
        seen = {link}
        while link in parent_of:
            link = parent_of[link]
            if link in seen:
                raise UrdfError(f"the joints form a cycle through link {link!r}")
            seen.add(link)
    return roots[0]


def _required(el: ET.Element, attr: str, where: str) -> str:
    value = el.get(attr)
    if not value:
        raise UrdfError(f"{where} has no {attr!r} attribute")
    return value


def _link_ref(el: ET.Element, tag: str, where: str, links: list[str]) -> str:
    ref = el.find(tag)
    if ref is None:
        raise UrdfError(f"{where} has no <{tag}>")
    link = _required(ref, "link", f"{where} <{tag}>")
    if link not in links:
        raise UrdfError(f"{where}: {tag} link {link!r} is not defined")
    return link


def _float(text: str, where: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise UrdfError(f"{where}: {text!r} is not a number") from None
    if not math.isfinite(value):
        raise UrdfError(f"{where}: {text!r} is not finite")
    return value


def _floats(text: str | None, count: int, where: str) -> tuple[float, ...]:
    if text is None:
        return (0.0,) * count
    parts = text.split()
    if len(parts) != count:
        raise UrdfError(f"{where}: expected {count} numbers, got {text!r}")
    return tuple(_float(p, where) for p in parts)
