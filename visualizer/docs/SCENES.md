# Scene objects and coordinate frames

This fork adds user-authored static scene objects to 3D Replay. Open **Scene**, import a self-contained GLB or scene JSON, or add a box. Edit its parent frame, position, rotation, and scale. **Axes** marks the world origin. **Fit view** frames the robot and loaded objects. Scenes save in IndexedDB per dataset and can be exported to portable JSON including embedded GLB assets. JSON import replaces the current scene. Source recordings are unchanged.

The default G1 block-stacking scene (`public/examples/g1-blockstacking.scene.json`) includes white-table, red/yellow/blue-green cube, and tape-marker GLB models. Dimensions and poses are estimates from episode 0 camera footage; they are static, not tracked. Rebuild these small assets with `python3 scripts/generate-g1-scene.py`. **Reset demo scene** restores them. An old untouched empty G1 scene migrates automatically; custom placements are preserved.

The sample `public/examples/workcell.scene.json` contains an illustrative tabletop, bin, and pink brick. Positions are not calibrated to the recordings; objects are static, with no measured trajectories, contact simulation, or inferred grasp events.

## Standards and choices

- **Units and axes:** [ROS REP-103](https://github.com/ros-infrastructure/rep/blob/master/rep-0103.rst), SI meters, right-handed, X forward, Y left, Z up. Angles in stored transforms are unit quaternions `[x,y,z,w]`. UI rotation inputs use XYZ Euler angles in degrees for editing, converted to quaternions. Quaternions describe the child's orientation relative to its parent.
- **Robot:** the existing URDF model defines the robot's link and joint frames. The `base_link` scene frame places its root in the world. For other robots the URDF's own root name may differ; this scene frame still places the root. See [REP-105](https://github.com/ros-infrastructure/rep/blob/master/rep-0105.rst) for common mobile-robot frame semantics; this static tabletop scene does not introduce `map` or `odom`.
- **Origin:** `world` is the chosen scene reference. G1 now defaults to the floor between the feet. Its URDF root is the pelvis: `world -> base_link` translates it up by 0.7918637524 m, derived from the zero-pose ankle frames at Z=-0.7568637524 m and the foot collision sphere bottoms another 0.035 m below. This is reference-stance placement, not measured global robot localization. Arm-only scenes retain a root-based default. Moving the robot root changes that transform; world-attached objects stay fixed. A standard specifies conventions, not a universal physical origin.
- **Assets:** glTF 2.0 binary `.glb`, the [Khronos / ISO standardized 3D format](https://www.khronos.org/gltf/). Self-contained models must embed textures and buffers. The importer blocks external resources. Files are limited to 25 MB per model and 64 MB per scene.
- **Asset orientation:** glTF is right-handed Y-up, in meters. At identity the importer maps asset `(x,y,z)` to ROS `(x,-z,y)` by a +90 degree X rotation. This changes up-axis; it does not guess the object's semantic forward direction or pivot. Apply object rotation/translation to align those. Pivots and geometry are retained; no auto-centering or resizing.
- **Rendering:** upstream uses Three.js Y-up and display scales 10 for SO arms, 3 for OpenArm, and 1 for G1. The adapter maps ROS `(x,y,z)` to display `scale * (x,z,-y)` for both robot and objects. These are display transforms, not scene units. A 0.1 m cube is 10 cm regardless of robot. Grid cells are 0.1 m.

## Scene file

The versioned JSON manifest is specific to this fork, not a LeRobot, ROS, or glTF standard. Its transforms and assets follow the standards above. The robot data and scene file remain separate, permitting later adapters for ROS TF, simulation state, or tracked object poses without repackaging recordings.

```json
{
  "schemaVersion": 1,
  "convention": "ros-rep-103",
  "units": "meters",
  "frames": [
    {
      "id": "base_link",
      "parent": "world",
      "translation": [0, 0, 0],
      "rotation": [0, 0, 0, 1]
    }
  ],
  "objects": [
    {
      "id": "box",
      "name": "Example box",
      "frame": "world",
      "translation": [0.2, 0, 0.05],
      "rotation": [0, 0, 0, 1],
      "scale": [1, 1, 1],
      "geometry": { "type": "box", "size": [0.1, 0.1, 0.1], "color": "#d9a66f" }
    }
  ]
}
```

`world` is implicit. Additional named frames may reference other frames, forming an acyclic tree rooted at world. `base_link` must be present. Each object references one frame. Dimensions/translation are meters; scale is a positive dimensionless vector. GLB geometry is `{ "type": "glb", "dataUrl": "data:model/gltf-binary;base64,..." }`. Export generates this automatically. The renderer composes parent transforms before object pose and scale.

The scene editor changes the robot-base pose and object poses. More complex static frame trees can be imported from JSON. Animated object tracks and binding to individual moving robot links are future work.

Optional scene metadata `preset`, `originDescription`, and `note` describe presets, frame intent, and reconstruction limits. They survive export/import. Metadata does not alter coordinate transforms; frame matrices remain authoritative.
