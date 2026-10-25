import json

import numpy as np
import pytest

from clio_pipeline.glb import (
    MeshData,
    Node,
    glb_bounds,
    parse_glb,
    read_glb,
    transform_glb,
    vertex_normals,
    write_glb,
)

QUARTER_TURN_Y = (0.0, np.sin(np.pi / 4), 0.0, np.cos(np.pi / 4))


def triangle_node(**kwargs) -> Node:
    positions = np.array([[0, 0, 0], [1, 0, 0], [0, 0, -1]], dtype=np.float32)
    return Node(
        name="tri",
        mesh=MeshData(positions, np.array([[0, 1, 2]], dtype=np.uint32)),
        **kwargs,
    )


def test_round_trip_keeps_trs_geometry_colors_material_and_extras():
    colors = np.array([[1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float32)
    node = triangle_node(
        translation=(0.5, 1.0, -2.0),
        rotation=QUARTER_TURN_Y,
        base_color=(0.2, 0.4, 0.6, 1.0),
        extras={"kind": "table", "global": False},
    )
    node.mesh.colors = colors
    node.mesh.normals = vertex_normals(node.mesh.positions, node.mesh.triangles())
    data = write_glb([node, Node(name="empty")], extras={"source": "test"})

    back = read_glb(data)
    assert [n.name for n in back] == ["tri", "empty"]
    tri = back[0]
    np.testing.assert_allclose(tri.translation, (0.5, 1.0, -2.0))
    np.testing.assert_allclose(tri.rotation, QUARTER_TURN_Y, atol=1e-7)
    np.testing.assert_array_equal(tri.mesh.positions, node.mesh.positions)
    np.testing.assert_array_equal(tri.mesh.indices, [[0, 1, 2]])
    np.testing.assert_allclose(tri.mesh.colors, colors)
    np.testing.assert_allclose(tri.mesh.normals, [[0, 1, 0]] * 3, atol=1e-6)
    np.testing.assert_allclose(tri.base_color, (0.2, 0.4, 0.6, 1.0))
    assert tri.extras == {"kind": "table", "global": False}
    doc, _ = parse_glb(data)
    assert doc["scenes"][0]["extras"] == {"source": "test"}
    assert doc["accessors"][0]["min"] == [0.0, 0.0, -1.0]


def test_world_positions_apply_the_node_transform():
    node = triangle_node(translation=(1, 0, 0), rotation=QUARTER_TURN_Y)
    world = node.world_positions()
    # A quarter turn about +y takes +x to -z.
    np.testing.assert_allclose(world[1], [1, 0, -1], atol=1e-6)


def test_nested_nodes_are_flattened_into_the_root_frame():
    data = write_glb([triangle_node()])
    moved = transform_glb(data, scale=2.0, translation=(0, 1, 0))
    nodes = [n for n in read_glb(moved) if n.mesh is not None]  # the new root has no mesh
    assert len(nodes) == 1
    np.testing.assert_allclose(nodes[0].mesh.positions[1], [2, 1, 0])
    lo, hi = glb_bounds(moved)
    np.testing.assert_allclose(lo, [0, 1, -2])
    np.testing.assert_allclose(hi, [2, 1, 0])


def test_transform_keeps_the_binary_chunk_and_adds_one_root():
    data = write_glb([triangle_node(), triangle_node(translation=(3, 0, 0))])
    doc_before, bin_before = parse_glb(data)
    doc, binary = parse_glb(transform_glb(data, rotation=QUARTER_TURN_Y))
    assert binary == bin_before
    assert doc["scenes"][0]["nodes"] == [2]
    assert doc["nodes"][2]["children"] == [0, 1]
    assert len(doc["nodes"]) == len(doc_before["nodes"]) + 1


def test_reads_normalized_integer_colors_and_short_indices_from_other_exporters():
    positions = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float32).tobytes()
    colors = np.array([[255, 0, 0, 255]] * 3, dtype=np.uint8).tobytes()
    indices = np.array([0, 1, 2, 0], dtype=np.uint16).tobytes()  # padded to 4 bytes
    binary = positions + colors + indices
    doc = {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [0]}],
        "nodes": [
            {"name": "n", "mesh": 0, "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]}
        ],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "COLOR_0": 1}, "indices": 2}]}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 36},
            {"buffer": 0, "byteOffset": 36, "byteLength": 12},
            {"buffer": 0, "byteOffset": 48, "byteLength": 6},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"},
            {
                "bufferView": 1,
                "componentType": 5121,
                "normalized": True,
                "count": 3,
                "type": "VEC4",
            },
            {"bufferView": 2, "componentType": 5123, "count": 3, "type": "SCALAR"},
        ],
    }
    text = json.dumps(doc).encode()
    text += b" " * (-len(text) % 4)
    import struct

    body = struct.pack("<II", len(text), 0x4E4F534A) + text
    body += struct.pack("<II", len(binary), 0x004E4942) + binary
    data = struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body
    (node,) = read_glb(data)
    np.testing.assert_allclose(node.mesh.colors[0], [1, 0, 0, 1])
    np.testing.assert_array_equal(node.mesh.indices, [[0, 1, 2]])
    # A matrix node is flattened: positions moved by the matrix's translation.
    np.testing.assert_allclose(node.mesh.positions[0], [5, 0, 0])


def test_refuses_what_is_not_a_glb():
    with pytest.raises(ValueError):
        parse_glb(b"not a glb at all, sorry")
