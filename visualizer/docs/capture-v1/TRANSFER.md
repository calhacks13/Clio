# Quest Capture v1 transfer contract

Design contract only. No receiver, headset app, pairing UI, or upload route is implemented yet. This document defines what to build; port 8787 below is reserved by convention, not a running service. The existing visualizer remains on port 3000.

## Recommendation

Build one small local ingestion service alongside the browser viewer. The Quest app records to its own local storage and uploads finalized recordings to that service. The browser talks to the service to list validated packages and open them. Keep USB, local Wi-Fi and later remote uploads on the same protocol. A local browser cannot assume arbitrary access to headset files or listen for network uploads by itself.

Start development over USB with ADB reverse. It works independently of local Wi-Fi and keeps the receiver bound to computer loopback. Use Wi-Fi for ordinary untethered recording once pairing is implemented. The computer must be on the same reachable network and listening on its LAN interface for Wi-Fi; `127.0.0.1` on the Quest itself normally refers to the Quest, not the computer.

```sh
adb devices
adb reverse tcp:8787 tcp:8787
```

Then the native Quest app can reach the proposed computer receiver at `http://127.0.0.1:8787` through USB. Developer mode and authorized USB debugging are prerequisites. This is an ADB data tunnel, not Meta Quest Link; Windows Link is not needed for a Mac receiver. Native Android development builds need narrowly scoped cleartext network configuration for this loopback endpoint. Normal Wi-Fi/internet transfers use TLS. Do not enable global cleartext traffic or disable certificate validation.

Source for the reverse command: https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md

## Recording lifecycle

1. Recorder writes append-only JSONL logs with bounded buffers and periodically flushes them. Encode independent 10–30 second MP4 segments and index each segment separately to limit crash loss. A `video` manifest entry is one segment; camera IDs can repeat across segments and `frame_index` resets per segment. Use monotonically increasing sequence within each camera's index stream. Keep headset capture independent of network backpressure.
2. Stop recording, close encoders, verify frame-index counts, calculate file hashes and write `recording.json.tmp`. Atomically rename to `recording.json` only after all payloads are complete. Set `status: complete`; recovered recordings explicitly say `recovered` and record lost intervals in extensions.
3. Queue the package for upload. Keep it on the Quest until validation acknowledgment; removal remains an explicit user retention policy. A connection loss never deletes the recording.
4. Receiver stages files under its own generated upload ID, verifies byte lengths/hashes and package semantics, then atomically promotes the directory to the library. The viewer sees only ready recordings. A duplicate recording ID + identical manifest digest is idempotent; same ID + different digest is a conflict, not an overwrite.
5. List the ready recording in the viewer, open motion/video replay, and allow a separate LeRobot export job. Upload does not imply permission to publish to Hugging Face.

## Pairing and transport

For Wi-Fi, show a QR code on the computer containing receiver URL, certificate fingerprint/public-key pin, and a short-lived one-use pairing secret. The Quest scans or manually enters it. Successful pairing issues a scoped device bearer token; never include it in saved recording manifests. Use TLS with a trusted certificate or pinned local certificate in the native app. Browser UI can use the computer's same-origin local service/proxy without handling certificate bypasses. Configure LAN access deliberately and restrict receiver CORS to the viewer origin; do not expose a development receiver publicly.

USB development can provision a short-lived token through a development-only setup flow. All writes still authenticate. For the later internet path, use authenticated HTTPS to an ingestion endpoint/object store, preserving the same manifest, file hashes, resume semantics and recording ID. A cloud service is not necessary for the initial local tool.

## HTTP v1

All paths below begin `/api/capture/v1`. Authenticated requests use `Authorization: Bearer <device-token>`. Bodies with JSON use `application/json`. IDs returned by the service are opaque. Scope tokens to upload/read as appropriate; publishing/exporting uses separate authorization.

| Request                                    | Body / response                                                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                              | Protocol/version and readiness; contains no recording data                                                                             |
| `POST /uploads`                            | Final `recording.json` body; returns `upload_id`, manifest SHA-256 and file IDs/confirmed offsets; `201` new or `200` identical resume |
| `GET /uploads/{upload_id}`                 | State and confirmed contiguous byte offset for each file ID                                                                            |
| `PUT /uploads/{upload_id}/files/{file_id}` | Raw file chunk, `Upload-Offset` and `Upload-Chunk-SHA256` request headers; `204` with new `Upload-Offset` after verified durable write |
| `POST /uploads/{upload_id}/complete`       | Empty body; `202` validating or `200` already ready                                                                                    |
| `GET /uploads/{upload_id}`                 | `uploading`, `validating`, `ready` or `rejected`, plus structured errors and recording URL when ready                                  |
| `GET /recordings`                          | Authorized ready-library listing with cursor pagination                                                                                |

The receiver derives file IDs from its validated manifest inventory; a client never supplies an arbitrary destination path. Default upload chunk size 4 MiB, last chunk shorter, at most two concurrent files, ordered chunks within each file. Resume at the returned offset. A dropped response requires querying confirmed offset before retrying; no blind append. An offset mismatch returns `409` with current offset. Hash/length failures return `422`; quota/body-size excess `413`; expired token `401`. Retrying `/complete` or creation of an identical package must not create another recording. Interrupted validation can be retried against unchanged staged content.

A receiver stores the exact manifest plus its digest. Validate schema before allocating inventory resources; impose configured disk/file/count/recording-size quotas. Treat all declared paths as relative; reject traversal, symlinks, duplicate/alias paths, file hash mismatch, unsupported schema version, dangling IDs and non-finite values. For ZIP import, apply the same limits before extraction, including decompressed size. Never follow embedded network resources in GLB. Serve validated assets and videos with range requests for seeking. Do not inline huge uploads through a serverless request route with a small body limit.

## Live preview

Optional later: a WebSocket carrying decimated poses at 15–30 Hz and low-bandwidth preview video. This is expendable monitoring data; the local files remain authoritative. Network arrival time is not capture time. A live preview may drop frames under congestion without changing the archived recording. Use the same world coordinates, IDs and timestamps as the archival streams.

## Minimal implementation order

1. Generate synthetic packages, validate them, and implement local-folder import/motion replay.
2. Implement the native recorder's shared clock, calibration, raw hand/headset logs and camera recording; verify on hardware.
3. Add this receiver, USB tunnel transfer and validation acknowledgments.
4. Add QR pairing and Wi-Fi transfer.
5. Implement and test the pinned LeRobot exporter against the official reader and a chosen training profile.

The delivered fixture has no video and deliberately synthetic, anatomically unrealistic hand coordinates. It tests the data contract, not capture quality, policy compatibility, or a trained robot action pipeline.
