"""Robot retargeting profiles: which robot, where it stands, and how a hand drives it.

A profile is a JSON file (schema: profile.schema.json next to this module) that pins its URDF by
SHA-256, so a compiled trajectory always names the exact robot it was solved for. Field meanings:

- `arms[]`: one per driven arm. `hand` drives the chain from `baseLink` to `tipLink` (the tool
  frame). `base.pose` places `baseLink` in the export robot frame at the table corner (z up:
  x = -z_W, y = -x_W, z = +y_W, as in frames.py). `restPose` is the first solver seed.
- `tcp`: the hand point the tool follows (`wrist`, `pinch_point` or `palm`) with the wrist's
  orientation; `wristToTcp` offsets the tool from that point in WebXR wrist axes (-z along the
  fingers, -y out of the palm), and `toolAlign` turns the hand frame into the robot tool frame.
- `workspace`: targets are scaled by `scale` about `pivot` (W) before solving.
- `orientation`: `mode` (full, approach_axis, position_only), `weight` (meters per radian) and
  `approachAxis` (tool frame) for the solver.
- `gripper`: the pinch aperture maps linearly from `pinchOpenM` (0, open) to `pinchClosedM`
  (1, closed).
- `solver`: damping, iteration limit and the tolerances a frame must meet to count as reachable.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
from jsonschema import Draft202012Validator

from ..frames import Q_ROBOT_FROM_WORKSPACE, R_ROBOT_FROM_WORKSPACE, quat_multiply
from ..schema import parse_json
from .ik import IkSettings
from .kinematics import Chain
from .urdf import Urdf, UrdfError, parse_urdf

SCHEMA_PATH = Path(__file__).with_name("profile.schema.json")
PROFILES_DIR = Path(__file__).with_name("profiles")
DEFAULT_PROFILE = PROFILES_DIR / "clio-arm-6dof.json"


@dataclass(frozen=True, eq=False)
class ArmProfile:
    hand: str  # left | right
    chain: Chain
    base_pose: np.ndarray  # (7,) baseLink in the export robot frame at the table corner
    rest_pose: np.ndarray  # (dof,)

    @property
    def joints(self) -> tuple[str, ...]:
        return self.chain.joint_names

    @property
    def base_in_workspace(self) -> np.ndarray:
        """(7,) baseLink pose in the workspace frame W."""
        p = R_ROBOT_FROM_WORKSPACE.T @ self.base_pose[:3]
        q_inv = Q_ROBOT_FROM_WORKSPACE * np.array([-1.0, -1.0, -1.0, 1.0])
        q = quat_multiply(q_inv, self.base_pose[3:])
        return np.concatenate([p, q / np.linalg.norm(q)])


@dataclass(frozen=True, eq=False)
class RetargetProfile:
    id: str
    version: int
    name: str
    robot_type: str
    example: bool
    path: Path
    profile_sha256: str  # of the profile file, so a compile can tell when it was edited
    urdf_path: Path
    urdf_sha256: str
    urdf: Urdf
    arms: tuple[ArmProfile, ...]
    tcp_target: str  # wrist | pinch_point | palm
    wrist_to_tcp: np.ndarray  # (7,) in WebXR wrist axes
    tool_align: np.ndarray  # (4,)
    workspace_scale: float
    workspace_pivot: np.ndarray  # (3,) W
    pinch_open_m: float
    pinch_closed_m: float
    ik: IkSettings

    @property
    def robot(self) -> str:
        """The URDF's robot name."""
        return self.urdf.name

    @property
    def artifact_name(self) -> str:
        """The compiled file name: retarget-<id>.json."""
        return f"retarget-{self.id}.json"


def load_profile(path: str | Path) -> RetargetProfile:
    """Read and check a profile: schema, URDF hash, links and rest pose. ValueError if anything is
    wrong (including a URDF whose SHA-256 differs from the profile's), FileNotFoundError if the
    profile itself is missing."""
    path = Path(path)
    try:
        doc = parse_json(path.read_text(encoding="utf-8"))
    except ValueError as e:
        raise ValueError(f"{path}: invalid JSON ({e})") from None
    errors = sorted(_validator().iter_errors(doc), key=lambda e: _json_path(e.absolute_path))
    if errors:
        shown = "; ".join(f"{_json_path(e.absolute_path)}: {e.message}" for e in errors[:5])
        raise ValueError(f"{path}: not a valid retarget profile: {shown}")

    urdf_path = (path.parent / doc["urdf"]["path"]).resolve()
    if not urdf_path.is_file():
        raise ValueError(f"{path}: URDF {urdf_path} does not exist")
    data = urdf_path.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    if sha != doc["urdf"]["sha256"]:
        raise ValueError(
            f"{path}: URDF {urdf_path.name} has SHA-256 {sha}, but the profile pins "
            f"{doc['urdf']['sha256']}; review the robot change and update the profile (and its "
            "version)"
        )
    try:
        urdf = parse_urdf(data.decode("utf-8"))
    except (UrdfError, UnicodeDecodeError) as e:
        raise ValueError(f"{urdf_path}: {e}") from None

    hands = [arm["hand"] for arm in doc["arms"]]
    if len(set(hands)) != len(hands):
        raise ValueError(f"{path}: each hand can drive only one arm, got {hands}")
    arms = tuple(_arm(path, urdf, arm) for arm in doc["arms"])
    if len({j for arm in arms for j in arm.joints}) != sum(len(arm.joints) for arm in arms):
        raise ValueError(f"{path}: the arms share joints; each arm needs its own chain")

    gripper = doc["gripper"]
    if gripper["pinchOpenM"] <= gripper["pinchClosedM"]:
        raise ValueError(f"{path}: gripper.pinchOpenM must be larger than pinchClosedM")
    tcp, orientation, solver = doc["tcp"], doc["orientation"], doc["solver"]
    return RetargetProfile(
        id=doc["id"],
        version=doc["version"],
        name=doc["name"],
        robot_type=doc["robotType"],
        example=doc["example"],
        path=path,
        profile_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        urdf_path=urdf_path,
        urdf_sha256=sha,
        urdf=urdf,
        arms=arms,
        tcp_target=tcp["target"],
        wrist_to_tcp=_pose(path, "tcp.wristToTcp", tcp["wristToTcp"]),
        tool_align=_unit(path, "tcp.toolAlign", tcp["toolAlign"]),
        workspace_scale=float(doc["workspace"]["scale"]),
        workspace_pivot=np.asarray(doc["workspace"]["pivot"], dtype=np.float64),
        pinch_open_m=float(gripper["pinchOpenM"]),
        pinch_closed_m=float(gripper["pinchClosedM"]),
        ik=IkSettings(
            mode=orientation["mode"],
            rot_weight=float(orientation["weight"]),
            approach_axis=_unit(path, "orientation.approachAxis", orientation["approachAxis"]),
            damping=float(solver["damping"]),
            max_iterations=int(solver["maxIterations"]),
            tol_pos_m=float(solver["tolPosM"]),
            tol_rot_rad=float(solver["tolRotRad"]),
        ),
    )


def _arm(path: Path, urdf: Urdf, arm: dict) -> ArmProfile:
    where = f"{path}: arm {arm['hand']!r}"
    try:
        chain = Chain(urdf, arm["baseLink"], arm["tipLink"])
    except UrdfError as e:
        raise ValueError(f"{where}: {e}") from None
    rest = np.asarray(arm["restPose"], dtype=np.float64)
    if rest.shape != (chain.dof,):
        raise ValueError(
            f"{where}: restPose has {len(rest)} values, the chain has {chain.dof} joints "
            f"{list(chain.joint_names)}"
        )
    outside = [
        n
        for n, v, lo, hi in zip(chain.joint_names, rest, chain.lower, chain.upper, strict=True)
        if not lo <= v <= hi
    ]
    if outside:
        raise ValueError(f"{where}: restPose is outside the joint limits of {outside}")
    return ArmProfile(
        hand=arm["hand"],
        chain=chain,
        base_pose=_pose(path, f"arm {arm['hand']} base.pose", arm["base"]["pose"]),
        rest_pose=rest,
    )


def _pose(path: Path, where: str, values: list[float]) -> np.ndarray:
    pose = np.asarray(values, dtype=np.float64)
    return np.concatenate([pose[:3], _unit(path, where + " quaternion", pose[3:])])


def _unit(path: Path, where: str, values) -> np.ndarray:
    v = np.asarray(values, dtype=np.float64)
    norm = float(np.linalg.norm(v))
    if norm < 1e-9:
        raise ValueError(f"{path}: {where} is zero")
    return v / norm


def _json_path(parts) -> str:
    return "$" + "".join(f"[{p}]" if isinstance(p, int) else f".{p}" for p in parts)


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    return Draft202012Validator(json.loads(SCHEMA_PATH.read_text(encoding="utf-8")))
