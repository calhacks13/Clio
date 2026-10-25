"""CAD programs (clio_pipeline.models.cad): every shape tessellates to a closed, consistently
wound mesh with unit normals and the right bounds; answers are checked part by part; a program
is fitted by its height."""

from collections import Counter

import numpy as np
import pytest

from clio_pipeline.models import cad
from clio_pipeline.models.cad import CadError, fit_program, shape_mesh, validate_program

SHAPES = {
    "box": (
        {"x": 0.2, "y": 0.1, "z": 0.3, "bevel": 0.0},
        [[-0.1, -0.05, -0.15], [0.1, 0.05, 0.15]],
    ),
    "rounded box": (
        {"x": 0.2, "y": 0.1, "z": 0.3, "bevel": 0.02},
        [[-0.1, -0.05, -0.15], [0.1, 0.05, 0.15]],
    ),
    "cylinder": (
        {"radius": 0.05, "height": 0.2, "bevel": 0.0},
        [[-0.05, -0.1, -0.05], [0.05, 0.1, 0.05]],
    ),
    "rounded cylinder": (
        {"radius": 0.05, "height": 0.2, "bevel": 0.01},
        [[-0.05, -0.1, -0.05], [0.05, 0.1, 0.05]],
    ),
    "cone": (
        {"radiusBottom": 0.05, "radiusTop": 0.0, "height": 0.1},
        [[-0.05, -0.05, -0.05], [0.05, 0.05, 0.05]],
    ),
    "frustum": (
        {"radiusBottom": 0.02, "radiusTop": 0.05, "height": 0.1},
        [[-0.05, -0.05, -0.05], [0.05, 0.05, 0.05]],
    ),
    "sphere": ({"radius": 0.1}, [[-0.1, -0.1, -0.1], [0.1, 0.1, 0.1]]),
    "torus": (
        {"radius": 0.05, "tube": 0.01, "arc": 360.0},
        [[-0.06, -0.01, -0.06], [0.06, 0.01, 0.06]],
    ),
    "half torus": (
        {"radius": 0.05, "tube": 0.01, "arc": 180.0},
        [[0.0, -0.01, -0.06], [0.06, 0.01, 0.06]],
    ),
    "capsule": ({"radius": 0.02, "length": 0.1}, [[-0.02, -0.07, -0.02], [0.02, 0.07, 0.02]]),
    "lathe": (
        # A cup: out along the floor, up the outside, over the rim, down the inside.
        {"profile": [[0, 0], [0.04, 0], [0.045, 0.1], [0.04, 0.1], [0.036, 0.005], [0, 0.005]]},
        [[-0.045, 0.0, -0.045], [0.045, 0.1, 0.045]],
    ),
    "lathe ring": (
        {"profile": [[0.05, 0], [0.06, 0], [0.06, 0.02], [0.05, 0.02], [0.05, 0]]},
        [[-0.06, 0.0, -0.06], [0.06, 0.02, 0.06]],
    ),
    "extrude": (
        {"outline": [[0, 0], [0.1, 0], [0.1, 0.1], [0.05, 0.04], [0, 0.1]], "height": 0.02},
        [[0.0, -0.01, 0.0], [0.1, 0.01, 0.1]],
    ),
}
SHAPE_OF = {name: name.split()[-1] for name in SHAPES}
SHAPE_OF.update({"frustum": "cone", "lathe ring": "lathe"})


def _closed_and_wound(mesh: cad.Mesh) -> None:
    """Every triangle faces where its normals do, and once coincident vertices are welded each
    directed edge is matched by its reverse exactly once: closed, consistently wound."""
    p, n, t = mesh.positions, mesh.normals, mesh.triangles
    face = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
    assert (np.einsum("ij,ij->i", face, n[t].sum(axis=1)) > 0).all()
    _, weld = np.unique(np.round(p, 7), axis=0, return_inverse=True)
    w = weld.reshape(-1)[t]
    edges = Counter(map(tuple, np.concatenate([w[:, [0, 1]], w[:, [1, 2]], w[:, [2, 0]]])))
    assert all(k == 1 and edges.get((b, a)) == 1 for (a, b), k in edges.items())
    volume = np.einsum("ij,ij->i", p[t[:, 0]], np.cross(p[t[:, 1]], p[t[:, 2]])).sum() / 6
    assert volume > 0  # outward: the normals point out of the solid


@pytest.mark.parametrize("name", list(SHAPES))
def test_every_shape_is_closed_wound_outward_with_unit_normals_and_its_bounds(name):
    dims, bounds = SHAPES[name]
    mesh = shape_mesh(SHAPE_OF[name], dims)
    np.testing.assert_allclose(np.linalg.norm(mesh.normals, axis=1), 1.0, atol=1e-9)
    np.testing.assert_allclose(mesh.positions.min(axis=0), bounds[0], atol=1e-9)
    np.testing.assert_allclose(mesh.positions.max(axis=0), bounds[1], atol=1e-9)
    _closed_and_wound(mesh)


def test_volumes_match_the_solids():
    def volume(mesh):
        p, t = mesh.positions, mesh.triangles
        return np.einsum("ij,ij->i", p[t[:, 0]], np.cross(p[t[:, 1]], p[t[:, 2]])).sum() / 6

    assert volume(cad.box_mesh(0.2, 0.1, 0.3)) == pytest.approx(0.006)
    assert volume(cad.cylinder_mesh(0.05, 0.2)) == pytest.approx(np.pi * 0.05**2 * 0.2, rel=0.01)
    assert volume(cad.sphere_mesh(0.1)) == pytest.approx(4 / 3 * np.pi * 0.1**3, rel=0.02)
    torus = 2 * np.pi**2 * 0.05 * 0.01**2
    assert volume(cad.torus_mesh(0.05, 0.01)) == pytest.approx(torus, rel=0.02)
    # Rounding the edges takes a little off the corners, never adds.
    assert 0.0055 < volume(cad.box_mesh(0.2, 0.1, 0.3, bevel=0.02)) < 0.006


def test_curved_surfaces_are_smooth_and_creases_sharp():
    cylinder = cad.cylinder_mesh(0.05, 0.2)
    side = np.abs(cylinder.positions[:, 1]) < 0.0999
    np.testing.assert_allclose(cylinder.normals[side, 1], 0.0, atol=1e-9)  # side: horizontal
    radial = cylinder.positions[side][:, [0, 2]] / 0.05
    np.testing.assert_allclose(cylinder.normals[side][:, [0, 2]], radial, atol=1e-9)
    caps = np.abs(np.abs(cylinder.normals[:, 1]) - 1.0) < 1e-9
    assert caps.sum() >= 2 * cad.SEGMENTS  # the caps have their own flat-shaded rim vertices
    sphere = cad.sphere_mesh(0.1)
    np.testing.assert_allclose(sphere.normals, sphere.positions / 0.1, atol=1e-9)


def test_an_elliptic_cylinder_keeps_its_normals_perpendicular():
    mesh = cad.cylinder_mesh(0.05, 0.1, radius_z=0.02)
    np.testing.assert_allclose(mesh.positions.max(axis=0), [0.05, 0.05, 0.02], atol=1e-9)
    side = np.abs(mesh.positions[:, 1]) < 0.0499
    p, n = mesh.positions[side], mesh.normals[side]
    np.testing.assert_allclose(n[:, [0, 2]], _ellipse_normals(p), atol=1e-9)
    _closed_and_wound(mesh)


def _ellipse_normals(p):
    g = np.stack([p[:, 0] / 0.05**2, p[:, 2] / 0.02**2], axis=1)
    return g / np.linalg.norm(g, axis=1, keepdims=True)


def test_rotation_turns_about_x_then_y_then_z():
    part = {
        "name": "post",
        "shape": "cylinder",
        "dims": {"radius": 0.01, "height": 0.2},
        "position": [0.5, 0.1, 0.0],
        "rotation": [90, 0, 0],  # y (its axis) onto z
        "color": "#ffffff",
    }
    mesh = cad.part_mesh(validate_program({"parts": [part]}).parts[0])
    np.testing.assert_allclose(mesh.positions.min(axis=0), [0.49, 0.09, -0.1], atol=1e-9)
    np.testing.assert_allclose(mesh.positions.max(axis=0), [0.51, 0.11, 0.1], atol=1e-9)
    np.testing.assert_allclose(cad.euler_matrix((0, 90, 0)) @ [1, 0, 0], [0, 0, -1], atol=1e-12)
    np.testing.assert_allclose(cad.euler_matrix((90, 0, 90)) @ [0, 1, 0], [-0, 0, 1], atol=1e-12)


def _part(shape="box", **dims):
    return {
        "name": "p",
        "shape": shape,
        "dims": dims or {"x": 0.1, "y": 0.1, "z": 0.1},
        "position": [0, 0.05, 0],
        "rotation": [0, 0, 0],
        "color": "#336699",
    }


def test_validation_drops_the_parts_it_cannot_build_and_keeps_the_rest():
    raw = {
        "name": "thing",
        "parts": [
            _part(),
            _part(x=0.1, y=float("nan"), z=0.1),  # non-finite
            _part(x=0.1, y=-0.1, z=0.1),  # impossible
            _part("cylinder", radius=0.05),  # no height
            _part("torus", radius=0.02, tube=0.03),  # tube thicker than the ring
            _part("extrude", outline=[[0, 0], [1, 1], [1, 0], [0, 1]], height=0.1),  # crossing
            _part("lathe", profile=[[0, 0], [0, 0.1]]),  # on the axis
            _part("blob", radius=0.1),  # no such shape
            {**_part(), "position": [0, "up", 0]},
            {**_part(), "color": "red", "metalness": 7, "roughness": -1, "rotation": None},
        ],
    }
    program = validate_program(raw)
    assert len(program.parts) == 2
    assert len(program.dropped) == 8
    assert "part 2: " in program.dropped[0] and "dims.y" in program.dropped[0]
    lenient = program.parts[1]
    assert lenient.color == cad.DEFAULT_COLOR and lenient.rotation == (0.0, 0.0, 0.0)
    assert (lenient.metalness, lenient.roughness) == (1.0, 0.0)
    assert [p.name for p in program.parts] == ["p", "p 2"]  # names stay unique for the nodes


def test_validation_clamps_to_48_parts_and_bevels_to_the_shape():
    program = validate_program({"parts": [_part()] * 60})
    assert len(program.parts) == cad.MAX_PARTS
    assert program.dropped == ("12 parts past the first 48",)
    beveled = validate_program({"parts": [_part(x=0.1, y=0.02, z=0.1, bevel=0.5)]}).parts[0]
    assert beveled.dims["bevel"] == pytest.approx(0.01)
    assert validate_program({"parts": [_part(shape="cylinder", radius=0.01, height=0.1)]})


@pytest.mark.parametrize(
    "raw", [None, [], {"parts": "box"}, {"parts": []}, {"parts": [_part("x")]}]
)
def test_an_answer_without_a_buildable_part_is_refused(raw):
    with pytest.raises(CadError):
        validate_program(raw)


def test_colors_are_read_as_srgb_and_written_linear():
    assert cad.hex_to_srgb("#ff8000").tolist() == pytest.approx([1.0, 128 / 255, 0.0])
    assert validate_program({"parts": [{**_part(), "color": "#F80"}]}).parts[0].color == "#ff8800"
    assert cad.srgb_to_linear(np.array([0.0, 0.5, 1.0])).tolist() == pytest.approx(
        [0.0, 0.21404, 1.0], abs=1e-5
    )
    assert cad.srgb_to_hex(np.array([1.0, 0.5, 0.0])) == "#ff8000"


def test_fitting_scales_uniformly_by_height_to_the_bottom_center():
    body = {**_part("cylinder", radius=0.5, height=2.0), "position": [3.0, 5.0, 0.0]}
    handle = {
        **_part("torus", radius=0.4, tube=0.1, arc=200),
        "position": [3.5, 5.0, 0.0],
        "rotation": [90, 0, 0],
        "color": "#aa0000",
        "metalness": 0.2,
    }
    program = validate_program({"name": "mug", "parts": [body, handle]})
    fitted = fit_program(program, 0.1)  # 2 m tall in the program, 10 cm measured
    assert fitted.scale == pytest.approx(0.05)
    assert [n.name for n in fitted.nodes] == ["p", "p 2"]
    points = np.concatenate([n.mesh.positions for n in fitted.nodes])
    low, high = points.min(axis=0), points.max(axis=0)
    assert low[1] == pytest.approx(0.0, abs=1e-6) and high[1] == pytest.approx(0.1, abs=1e-6)
    assert (low[0] + high[0]) / 2 == pytest.approx(0.0, abs=1e-6)
    assert (low[2] + high[2]) / 2 == pytest.approx(0.0, abs=1e-6)
    np.testing.assert_allclose(fitted.size, high - low, atol=1e-6)
    assert fitted.size[0] == pytest.approx((1.0 + 0.5) * 0.05, abs=1e-3)  # body plus handle
    handle_node = fitted.nodes[1]
    np.testing.assert_allclose(
        handle_node.base_color[:3], cad.srgb_to_linear(cad.hex_to_srgb("#aa0000"))
    )
    assert handle_node.metallic == pytest.approx(0.2)
