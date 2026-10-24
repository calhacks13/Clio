---
title: Visualize Dataset (v2.0+ latest dataset format)
emoji: 💻
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
hf_oauth: true
hf_oauth_scopes:
  - read-repos
hf_oauth_expiration_minutes: 480
---

# Clio visualizer

Start with [GOALS.md](GOALS.md) for the full project intent, what is implemented, local-storage expectations, contract differences and next steps. [INTEGRATION.md](INTEGRATION.md) maps this imported viewer to Clio's existing recorder, episode API, 25-joint WebXR contract and LeRobot pipeline.

From the Clio root:

```sh
pnpm visualizer:install
pnpm visualizer:dev        # http://127.0.0.1:3001
pnpm visualizer:check
```

This is a regular source folder with its own Bun dependencies; it contains no nested Git repository, Supabase setup or copied secrets/recordings. The UI currently opens the public G1 LeRobot demo and downloads public HF assets. Loading private Clio episodes locally is a planned adapter, not implemented by this copy. No automatic episode upload/publication is introduced. Root Clio continues using pnpm.

The Clio UI uses the website’s slate palette, Inter typography and filled rounded controls. **Replay** and **Data** are the two views. **Debug** (or `?debug=1`) reveals origin axes and joint mapping; both are hidden normally. Analysis tabs and the external Doctor embed are removed from the Clio interface. Scene import/export remains local. See [DESIGN.md](DESIGN.md) for the adapted visual system.

Snapshot: `peterjzhao/lerobot-dataset-visualizer` commit `afd282331a6b5215a2b4bdeaa860561a0061de0d`, originally based on Hugging Face's Apache-2.0 viewer. Original documentation follows; the Clio handoff above takes precedence for integration.

# LeRobot Dataset Visualizer

## Humanoid default

Opening `/` loads [Unitree's G1 Dex3 block-stacking dataset](https://huggingface.co/datasets/unitreerobotics/G1_Dex3_BlockStacking_Dataset), episode 0, in 3D Replay. It records 14 arm joints and 14 articulated three-finger hand joints at 30 Hz. The other body joints use the URDF reference pose. The world origin is on the floor between the feet, with the pelvis frame positioned above it. The demo includes reconstructed static GLB models for the white table, red/yellow/blue-green cubes, and tape marker; their positions and sizes are approximate. The **Hands** camera shortcut frames both hands; **Fit view** restores the whole scene. Choose **Datasets** (or open `/?browse=1`) to browse other recordings. Explicit dataset links and legacy URL parameters remain supported.

## Custom scene objects

This fork adds static scene composition to **3D Replay**. Open **Scene** to import a self-contained GLB, add boxes, edit poses in meters, load an illustrative workcell, and export portable scene JSON. **Debug** shows the world origin; **Fit view** frames all loaded geometry. Changes save in the browser per dataset.

Public coordinates follow ROS REP-103: X forward, Y left, Z up. G1 places its pelvis above a floor-based world origin; arm-only scenes retain their root-based default. Scene manifests are a fork-specific format; GLB assets and coordinate conventions use established standards. Added scene objects are user-authored context, not measured object motion or physics.

See [scene format and coordinate conventions](docs/SCENES.md), [example scene](public/examples/workcell.scene.json), and [sample GLB](public/examples/sample-box.glb).

LeRobot Dataset Tool and Visualizer is a web application for interactive exploration and visualization of robotics datasets, particularly those in the LeRobot format. It enables users to browse, view, and analyze episodes from large-scale robotics datasets, combining synchronized video playback with rich, interactive data graphs.

## Project Overview

This tool is designed to help robotics researchers and practitioners quickly inspect and understand large, complex datasets. It fetches dataset metadata and episode data (including video and sensor/telemetry data), and provides a unified interface for:

- Navigating between organizations, datasets, and episodes
- Watching episode videos
- Exploring synchronized time-series data with interactive charts
- Analyzing action quality and identifying problematic episodes
- Visualizing robot poses in 3D using URDF models
- Paginating through large datasets efficiently

## Upstream features

This section documents the imported source. The Clio interface exposes Replay and Data; the upstream analysis panels below are retained as source only.

- **Dataset & Episode Navigation:** Quickly jump between organizations, datasets, and episodes using a sidebar and navigation controls.
- **Synchronized Video & Data:** Video playback is synchronized with interactive data graphs for detailed inspection of sensor and control signals.
- **Overview Panel:** At-a-glance summary of dataset metadata, camera info, and episode details.
- **Statistics Panel:** Dataset-level statistics including episode count, total recording time, frames-per-second, and an episode-length histogram.
- **Action Insights Panel:** Data-driven analysis tools to guide training configuration — includes autocorrelation, state-action alignment, speed distribution, and cross-episode variance heatmap.
- **Filtering Panel:** Identify and flag problematic episodes (low movement, jerky motion, outlier length) for removal. Exports flagged episode IDs as a ready-to-run LeRobot CLI command.
- **3D URDF Viewer:** Visualize robot joint poses frame-by-frame in an interactive 3D scene, with end-effector trail rendering. Supports SO-100, SO-101, and OpenArm bimanual robots.
- **Annotations Panel:** Hand-edit the v3.1 language schema (`language_persistent` + `language_events`) — subtask, plan, memory, interjection + paired speech, and VQA atoms with bounding-box / keypoint / count / attribute / spatial answers. VQA bboxes and keypoints render as overlays on the video player; drag or click on a camera to draw new ones. Backed by an optional FastAPI service (in `backend/`) for parquet rewrites and HF Hub push.
- **Efficient Data Loading:** Uses parquet and JSON loading for large dataset support, with pagination, chunking, and lazy-loaded panels for fast initial load.
- **Responsive UI:** Built with React, Next.js, and Tailwind CSS for a fast, modern user experience.

## Technologies Used

- **Next.js** (App Router)
- **React**
- **Recharts** (for data visualization)
- **Three.js** + **@react-three/fiber** + **@react-three/drei** (for 3D URDF visualization)
- **urdf-loader** (for parsing URDF robot models)
- **hyparquet** (for reading Parquet files)
- **Tailwind CSS** (styling)

## Getting Started

### Prerequisites

This project uses [Bun](https://bun.sh) as its package manager. If you don't have it installed:

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
```

### Installation

Install dependencies:

```bash
bun install
```

### Development

Run the development server:

```bash
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `src/app/page.tsx` or other files in the `src/` directory. The app supports hot-reloading for rapid development.

### Other Commands

```bash
# Build for production
bun run build

# Start production server
bun start

# Run linter
bun run lint

# Format code
bun run format
```

### Environment Variables

- `DATASET_URL`: (optional) Base URL for dataset hosting (defaults to HuggingFace Datasets).
- `NEXT_PUBLIC_ANNOTATE_BACKEND_URL`: (optional) URL of the FastAPI annotation
  backend (`backend/app.py`). When set, the Annotations tab can save edits and
  rewrite parquet shards / push to the Hub. When unset the tab is read/edit
  only with sessionStorage persistence.

## Annotations backend (optional)

The Annotations tab edits LeRobot v3.1 language atoms — `language_persistent`
(broadcast subtask/plan/memory) and `language_events` (per-frame
interjection / vqa / speech) — and renders existing bbox/keypoint atoms over
the video player. Edits live in `sessionStorage` by default; to write the
new columns into `data/chunk-*/file-*.parquet` (matching the writer in
[lerobot#3471](https://github.com/huggingface/lerobot/pull/3471)) and push the
result to the Hub, run the bundled FastAPI service:

```bash
# 1. install + start the backend (port 7861 by default)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --port 7861 --reload

# 2. start the visualizer with the backend URL configured
cd ..
NEXT_PUBLIC_ANNOTATE_BACKEND_URL=http://127.0.0.1:7861 bun run dev
```

The backend exposes:

- `POST /api/dataset/load` — load a dataset by `repo_id` or `local_path`
- `GET  /api/episodes/{ep}/atoms` — list atoms for an episode
- `POST /api/episodes/{ep}/atoms` — replace atoms (event timestamps are
  snapped to exact source-frame timestamps before persisting)
- `GET  /api/episodes/{ep}/frame_timestamps` — used client-side for snapping
- `POST /api/export` — rewrite parquet with the new language columns plus
  the dataset-level `tools` column (drops legacy `subtask_index`)
- `POST /api/push_to_hub` — export and push to a target repo

## Docker Deployment

This application can be deployed using Docker with bun for optimal performance and self-contained builds.

### Build the Docker image

```bash
docker build -t lerobot-visualizer .
```

### Run the container

```bash
docker run -p 7860:7860 lerobot-visualizer
```

The application will be available at [http://localhost:7860](http://localhost:7860).

### Run with custom environment variables

```bash
docker run -p 7860:7860 -e DATASET_URL=your-url lerobot-visualizer
```

## Contributing

Contributions, bug reports, and feature requests are welcome! Please open an issue or submit a pull request.

### Acknowledgement

The app was orignally created by [@Mishig25](https://github.com/mishig25) and taken from this PR [#1055](https://github.com/huggingface/lerobot/pull/1055)

## Quest capture format design

The [Quest Capture v1 starter kit](docs/capture-v1/README.md) defines the planned human hand/object recording format, rate defaults, synchronization, static scene context, and LeRobot export semantics. Its [transfer contract](docs/capture-v1/TRANSFER.md) covers a local receiver, USB development tunnel, and paired Wi-Fi uploads. JSON Schema, synthetic sample recordings and a validator are included. Recording, receiving, replaying these packages and exporting them to LeRobot remain planned work.
