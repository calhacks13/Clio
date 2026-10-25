"""The primitive models' meshes (clio_pipeline.models.mesh): a box and a capped cylinder, either
rounded, tessellate closed and consistently wound, with unit normals and the right bounds."""

from collections import Counter

import numpy as np
import pytest

from clio_pipeline.models import mesh
from clio_pipeline.models.mesh import Mesh, box_mesh, cylinder_mesh, srgb_to_linear

SHAPES = {
    "box": (lambda: box_mesh(0.2, 0.1, 0.3), [[-0.1, -0.05, -0.15], [0.1, 0.05, 0.15]]),
    "rounded box": (
        lambda: box_mesh(0.2, 0.1, 0.3, bevel=0.02),
        [[-0.1, -0.05, -0.15], [0.1, 0.05, 0.15]],
    ),
    "cylinder": (lambda: cylinder_mesh(0.05, 0.2), [[-0.05, -0.1, -0.05], [0.05, 0.1, 0.05]]),
    "rounded cylinder": (
        lambda: cylinder_mesh(0.05, 0.2, bevel=0.01),
        [[-0.05, -0.1, -0.05], [0.05, 0.1, 0.05]],
    ),
}


def _volume(m: Mesh) -> float:
    p, t = m.positions, m.triangles
    return float(np.einsum("ij,ij->i", p[t[:, 0]], np.cross(p[t[:, 1]], p[t[:, 2]])).sum() / 6)


def _closed_and_wound(m: Mesh) -> None:
    """Every triangle faces where its normals do, and once coincident vertices are welded each
    directed edge is matched by its reverse exactly once: closed, consistently wound."""
    p, n, t = m.positions, m.normals, m.triangles
    face = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
    assert (np.einsum("ij,ij->i", face, n[t].sum(axis=1)) > 0).all()
    _, weld = np.unique(np.round(p, 7), axis=0, return_inverse=True)
    w = weld.reshape(-1)[t]
    edges = Counter(map(tuple, np.concatenate([w[:, [0, 1]], w[:, [1, 2]], w[:, [2, 0]]])))
    assert all(k == 1 and edges.get((b, a)) == 1 for (a, b), k in edges.items())
    assert _volume(m) > 0  # outward: the normals point out of the solid


@pytest.mark.parametrize("name", list(SHAPES))
def test_every_shape_is_closed_wound_outward_with_unit_normals_and_its_bounds(name):
    make, bounds = SHAPES[name]
    m = make()
    np.testing.assert_allclose(np.linalg.norm(m.normals, axis=1), 1.0, atol=1e-9)
    np.testing.assert_allclose(m.positions.min(axis=0), bounds[0], atol=1e-9)
    np.testing.assert_allclose(m.positions.max(axis=0), bounds[1], atol=1e-9)
    _closed_and_wound(m)


def test_volumes_match_the_solids():
    assert _volume(box_mesh(0.2, 0.1, 0.3)) == pytest.approx(0.006)
    assert _volume(cylinder_mesh(0.05, 0.2)) == pytest.approx(np.pi * 0.05**2 * 0.2, rel=0.01)
    # Rounding the edges takes a little off the corners, never adds.
    assert 0.0055 < _volume(box_mesh(0.2, 0.1, 0.3, bevel=0.02)) < 0.006


def test_a_cylinders_side_is_smooth_and_its_rims_sharp():
    cylinder = cylinder_mesh(0.05, 0.2)
    side = np.abs(cylinder.positions[:, 1]) < 0.0999
    np.testing.assert_allclose(cylinder.normals[side, 1], 0.0, atol=1e-9)  # side: horizontal
    radial = cylinder.positions[side][:, [0, 2]] / 0.05
    np.testing.assert_allclose(cylinder.normals[side][:, [0, 2]], radial, atol=1e-9)
    caps = np.abs(np.abs(cylinder.normals[:, 1]) - 1.0) < 1e-9
    assert caps.sum() >= 2 * mesh.SEGMENTS  # the caps have their own flat-shaded rim vertices


def test_an_elliptic_cylinder_keeps_its_normals_perpendicular():
    m = cylinder_mesh(0.05, 0.1, radius_z=0.02)
    np.testing.assert_allclose(m.positions.max(axis=0), [0.05, 0.05, 0.02], atol=1e-9)
    side = np.abs(m.positions[:, 1]) < 0.0499
    p, n = m.positions[side], m.normals[side]
    g = np.stack([p[:, 0] / 0.05**2, p[:, 2] / 0.02**2], axis=1)
    np.testing.assert_allclose(
        n[:, [0, 2]], g / np.linalg.norm(g, axis=1, keepdims=True), atol=1e-9
    )
    _closed_and_wound(m)


def test_colors_are_written_linear():
    assert srgb_to_linear(np.array([0.0, 0.5, 1.0])).tolist() == pytest.approx(
        [0.0, 0.21404, 1.0], abs=1e-5
    )
