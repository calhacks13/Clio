"""Robot retargeting: solve a profile's robot arms to follow the recorded hands (numpy only).

`load_profile` reads a profile (profile.py), `retarget_episode` solves every grid frame by inverse
kinematics (run.py, ik.py) and `retarget_doc` turns the result into a `retarget-<profile>.json`
document. The bundled `clio-arm-6dof` profile drives a made-up example arm.
"""

from .profile import DEFAULT_PROFILE, PROFILES_DIR, ArmProfile, RetargetProfile, load_profile
from .run import ArmTrajectory, Retargeted, RetargetSummary, retarget_doc, retarget_episode

__all__ = [
    "DEFAULT_PROFILE",
    "PROFILES_DIR",
    "ArmProfile",
    "ArmTrajectory",
    "RetargetProfile",
    "RetargetSummary",
    "Retargeted",
    "load_profile",
    "retarget_doc",
    "retarget_episode",
]
