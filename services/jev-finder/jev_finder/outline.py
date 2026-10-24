"""Mask to outline: the largest piece of a SAM mask as one closed polygon, a box and two points.

No OpenCV. scipy labels the pieces and computes the distance transform; the outer contour is
traced along pixel edges, so its bounds are exactly the mask's pixel-edge box
(`bench.mask_box`) and its area is the piece's area with holes filled.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import ndimage

MAX_OUTLINE_POINTS = 64
# Douglas-Peucker starts at one pixel, which flattens the stair steps of a pixel-edge contour.
START_TOLERANCE_PX = 1.0

# Pixels that touch at a corner belong to the same piece.
EIGHT_CONNECTED = np.ones((3, 3), dtype=bool)
# Holes smaller than this share of the piece are mask specks (glare, texture) and are filled
# before choosing the point; larger ones (a mug handle) stay, so the point never lands in them.
SPECK_SHARE = 0.01
# The contact point is the middle of the piece's lowest rows, this share of its height (at least
# one row), so a single stray pixel at the bottom doesn't decide where the object rests.
CONTACT_BAND = 0.03

# Headings as (dx, dy) with y down, clockwise on screen: east, south, west, north. Turning right
# is +1, turning left is +3 (mod 4).
STEPS = ((1, 0), (0, 1), (-1, 0), (0, -1))
# The two pixels in front of a vertex for each heading, (ahead-left, ahead-right), as (row, col)
# offsets from the vertex. Pixel (r, c) has its top-left corner at vertex (x=c, y=r).
AHEAD = (
    ((-1, 0), (0, 0)),
    ((0, 0), (0, -1)),
    ((0, -1), (-1, -1)),
    ((-1, -1), (-1, 0)),
)


@dataclass(frozen=True)
class Shape:
    """One piece of a mask, normalized to 0..1 of the mask (x right, y down)."""

    outline: list[list[float]]
    box: list[float]
    point: list[float]
    """The pixel deepest inside the piece."""
    contact: list[float]
    """The middle of the piece's lowest edge, where the object most likely rests on a surface."""
    area: int


def mask_shape(mask: np.ndarray, max_points: int = MAX_OUTLINE_POINTS) -> Shape | None:
    """Outline, box, deepest point and contact point of the mask's largest 8-connected piece.
    None when the mask is empty."""
    labels, count = ndimage.label(mask, structure=EIGHT_CONNECTED)
    if count == 0:
        return None
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    label = int(sizes.argmax())
    rows, cols = ndimage.find_objects(labels)[label - 1]
    piece = labels[rows, cols] == label
    offset = np.array([cols.start, rows.start], dtype=float)
    h, w = mask.shape
    scale = np.array([w, h], dtype=float)

    contour = outer_contour(piece) + offset
    outline = simplify(contour, max_points) / scale
    x0, y0 = contour.min(axis=0) / scale
    x1, y1 = contour.max(axis=0) / scale
    point = (deepest_point(fill_specks(piece)) + offset) / scale
    contact = (contact_point(piece) + offset) / scale
    return Shape(
        outline=[[_round(x), _round(y)] for x, y in outline],
        box=[_round(x0), _round(y0), _round(x1), _round(y1)],
        point=[_round(point[0]), _round(point[1])],
        contact=[_round(contact[0]), _round(contact[1])],
        area=int(sizes[label]),
    )


def outer_contour(piece: np.ndarray) -> np.ndarray:
    """Corners of the outer boundary of one 8-connected piece as pixel-edge vertices (x, y).

    Walks the boundary with the piece on its right, starting at the top-left corner of its first
    pixel in raster order, so the ring runs clockwise on screen. Holes are ignored. Two pixels
    that touch only at a corner stay joined, and the ring passes through that corner twice.
    """
    grid = np.pad(np.asarray(piece, dtype=bool), 1)
    filled = np.flatnonzero(grid)
    if filled.size == 0:
        raise ValueError("The piece has no pixels.")
    width = grid.shape[1]
    cells = grid.tobytes()  # one byte per pixel, 0 or 1
    steps = [dy * width + dx for dx, dy in STEPS]
    ahead = [(lr * width + lc, rr * width + rc) for (lr, lc), (rr, rc) in AHEAD]

    # At the start vertex the boundary arrives heading north and leaves heading east.
    start = vertex = int(filled[0])
    heading = 0
    corners: list[int] = []
    for _ in range(4 * grid.size):
        vertex += steps[heading]
        left, right = ahead[heading]
        if cells[vertex + left]:
            turn = 3
        elif cells[vertex + right]:
            turn = 0
        else:
            turn = 1
        if turn:
            heading = (heading + turn) % 4
            corners.append(vertex)
            if vertex == start and heading == 0:
                ys, xs = np.divmod(np.array(corners), width)
                # Undo the one-pixel border.
                return np.stack([xs - 1, ys - 1], axis=1).astype(float)
    raise RuntimeError("Contour tracing did not close.")


def fill_specks(piece: np.ndarray, share: float = SPECK_SHARE) -> np.ndarray:
    """The piece with its holes smaller than `share` of its area filled."""
    holes, count = ndimage.label(ndimage.binary_fill_holes(piece) & ~piece)
    if count == 0:
        return piece
    sizes = np.bincount(holes.ravel())
    small = sizes < share * piece.sum()
    small[0] = False
    return piece | small[holes]


def deepest_point(piece: np.ndarray) -> np.ndarray:
    """Center (x, y) of the pixel farthest from the piece's edge, holes and the frame included.

    Of several equally deep pixels it takes the one nearest their middle, so a bar gets its
    center instead of its first deep pixel.
    """
    distance = ndimage.distance_transform_edt(np.pad(np.asarray(piece, dtype=bool), 1))
    rows, cols = np.nonzero(distance == distance.max())
    nearest = int(np.argmin((rows - rows.mean()) ** 2 + (cols - cols.mean()) ** 2))
    return np.array([cols[nearest] - 1 + 0.5, rows[nearest] - 1 + 0.5])


def contact_point(piece: np.ndarray, band: float = CONTACT_BAND) -> np.ndarray:
    """Middle (x, y) of the piece's lowest edge: the middle of the pixels in its bottom `band`
    of rows, on the bottom pixel edge."""
    rows = np.flatnonzero(np.asarray(piece, dtype=bool).any(axis=1))
    if rows.size == 0:
        raise ValueError("The piece has no pixels.")
    bottom = int(rows[-1])
    height = max(1, round(band * (bottom - int(rows[0]) + 1)))
    cols = np.nonzero(piece[bottom - height + 1 : bottom + 1])[1]
    return np.array([(cols.min() + cols.max() + 1) / 2, bottom + 1], dtype=float)


def simplify(
    ring: np.ndarray, max_points: int = MAX_OUTLINE_POINTS, tolerance: float = START_TOLERANCE_PX
) -> np.ndarray:
    """A closed ring with at most `max_points` vertices that keeps its shape.

    Douglas-Peucker from `tolerance` (in the ring's units), doubled until it fits, like Clio's
    `simplifyOutline`. The ring is split at its first point and the point farthest from it.
    """
    ring = np.asarray(ring, dtype=float)
    if len(ring) <= 3:
        return ring
    far = int(np.argmax(np.hypot(*(ring - ring[0]).T)))
    closed = np.vstack([ring, ring[:1]])
    while True:
        keep = np.zeros(len(closed), dtype=bool)
        keep[[0, far, len(ring)]] = True
        _douglas_peucker(closed, 0, far, tolerance, keep)
        _douglas_peucker(closed, far, len(ring), tolerance, keep)
        simple = closed[:-1][keep[:-1]]
        if len(simple) < 3:
            break
        if len(simple) <= max_points:
            return simple
        tolerance *= 2
    # A sliver that simplification collapses: fall back to evenly spaced vertices.
    return ring[np.linspace(0, len(ring), max_points, endpoint=False).astype(int)]


def _douglas_peucker(
    points: np.ndarray, first: int, last: int, tolerance: float, keep: np.ndarray
) -> None:
    stack = [(first, last)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        distances = _segment_distances(points[i + 1 : j], points[i], points[j])
        k = int(np.argmax(distances))
        if distances[k] > tolerance:
            k += i + 1
            keep[k] = True
            stack += [(i, k), (k, j)]


def _segment_distances(points: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    ab = b - a
    length2 = float(ab @ ab)
    if length2 == 0:
        return np.hypot(*(points - a).T)
    t = np.clip((points - a) @ ab / length2, 0, 1)
    return np.hypot(*(points - (a + t[:, None] * ab)).T)


def _round(value: float) -> float:
    # 1e-4 of a 1568 px side is a sixth of a pixel; shorter JSON for the headset.
    return round(float(value), 4)
