# Clio integration status

This project now lives in Clio's `visualizer/` folder. Read `GOALS.md` and `INTEGRATION.md` for current ownership and goals. The text below describes the imported standalone viewer. Clio already implements its own recorder, local episode ingestion and Python export pipeline; the draft capture-v1 design does not replace those implementations. Local Clio episode loading in this Next.js viewer remains future work.

# Custom LeRobot Visualizer

A browser-based fork of Hugging Face's Apache-2.0 LeRobot Dataset Visualizer for inspecting synchronized recordings, robot motion, and user-supplied scene objects.

The current customization adds static scene composition to 3D Replay. Users can import self-contained GLB models or scene JSON, add box primitives, edit poses, and export the scene. Original robot datasets remain unchanged. Added objects are user-authored context, not measured object trajectories or physics simulation.

Use ROS REP-103 conventions for public scene coordinates: right-handed, meters, radians, X forward, Y left, Z up. The `world` frame is the scene root; `base_link` places the robot's URDF root in `world`. G1 scenes use a floor origin between the feet, with the pelvis 0.7918637524 m above it in the model reference stance. Arm-only scenes retain their root-based origin unless a scene file places it elsewhere. Standard GLB assets retain their native geometry with an explicit Y-up conversion. The renderer's historical enlargement is a display transform only.

The default entry point opens Unitree G1 Dex3 block stacking episode 0 in 3D Replay. This manufacturer-published dataset records 14 arm joints and 14 three-finger hand joints at 30 Hz; unrecorded body joints remain in the model reference pose. Dataset browsing remains available at `/?browse=1`, with humanoid examples first. The Clio interface has two views: Replay and Data. Scene editing remains optional; origin axes and joint mapping appear only in Debug mode (also available through `?debug=1`). Upstream analysis tabs and the external Doctor embed are removed from the view controller to focus this fork on recording inspection. Debug also exposes a clean comparison view with 3D Replay beside camera footage and signals on a shared timeline.

The G1 block-stacking demo automatically includes reconstructed static GLB models of the white table, red/yellow/blue-green cubes, and black tape marker. Sizes and positions are approximate estimates from episode 0 footage, not object-pose telemetry. Existing user-authored scenes are preserved; untouched empty scenes migrate to the new defaults.

The planned Quest capture workflow is specified in `docs/capture-v1/`: one versioned recording package with static scene entities, timestamped hand/headset/object streams, explicit source clocks and calibration, optional camera video, and a separate standard LeRobot export. Capture targets 60 Hz hands/cameras where supported; training export defaults to 30 Hz while preserving original raw timestamps. A local receiver with USB ADB reverse and later paired Wi-Fi uses one resumable upload contract. The schema, synthetic fixture and validator exist; the Quest recorder, receiver, capture-package replay and LeRobot exporter are not implemented. Meta's system hand-data reuse terms need clarification for the proposed training-data publication use.
