"""Clio tracker: YOLOE-26 vision encoder + ByteTrack, with jev naming the target."""

import os

# Ultralytics prints a banner per model call and pip-installs missing packages at runtime; a
# service should do neither.
os.environ.setdefault("YOLO_VERBOSE", "False")
os.environ.setdefault("YOLO_AUTOINSTALL", "False")

__version__ = "0.2.0"
