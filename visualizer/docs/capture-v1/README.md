> Clio integration note: this was the earlier standalone proposal. `../../GOALS.md` and `../../INTEGRATION.md` define current integration direction. Clio's existing `clio.episode/1` contract and local server on 8787 take precedence; do not start a duplicate receiver or migrate the 25-joint WebXR recorder to this 26-joint proposal implicitly.

# Quest Capture v1 starter kit

A device-independent recording contract for timestamped human hands, headset poses, moving objects, static scene geometry and optional camera video, with a separate ordinary LeRobot training export.

- Read [FORMAT.md](FORMAT.md) for fields, units, rate defaults, timing, calibration and export semantics.
- Read [TRANSFER.md](TRANSFER.md) for USB/Wi-Fi ingestion and the proposed receiver protocol.
- Use [capture.schema.json](capture.schema.json) to validate JSON documents and JSONL records.
- Start from [example/recording.json](example/recording.json). Every sample is synthetic, with one deliberately lost object pose. There is no camera video; absence is valid and explicit.

```sh
bun install
bun run validate -- example/recording.json
```

The validator covers structural and cross-file rules; it does not decode videos or certify real calibration/tracking quality. The format and validator are delivered; the Quest recorder, network receiver, package replay UI and LeRobot exporter are planned work. Existing scene editor JSON is a different static-only format.

Meta's current system-hand-tracking documentation restricts reuse beyond enabling hand tracking inside the app. Clarify terms before publishing system-derived hand poses as training data; this package can also carry independently permitted tracking sources.
