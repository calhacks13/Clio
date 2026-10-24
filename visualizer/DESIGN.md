# Clio visualizer design

The visualizer is an inspection surface: inspect synchronized recordings and 3D replay. The user's Clio Design Principles are the primary visual authority. Adapt their quiet slate system to a working tool, with the recording itself as the focal point. The local awesome-design-md Linear reference informs restraint and precise hierarchy only; its dark marketing palette and lavender are not adopted.

## Visual rules

- Default to light: page #EDF2F6, white chrome and panels, inset #F4F6FA. Ink #0F1117, secondary #24303D, muted #5B6472. Hairlines #D6DEE8, stronger #BCC8D6. UI fills are opaque.
- Optional dark mode follows the supplied night palette: #0C0F14 canvas, #14171D panels, #1F232C controls, #EDF0F5 ink, #C3CBDB secondary, #8A94A4 muted.
- Inter for body and controls; Inter Tight 600 for headings and the Clio wordmark. Use tabular figures for time and measurements, system monospace for raw coordinates. No decorative serif on working controls. The sky texture belongs to the marketing site and does not sit behind the inspection canvas.
- Citrus #FF7B3D marks active recording/selection and the brand dot; readable citrus text #B94A00. Primary actions use solid ink with white text. Secondary controls use filled slate pills. No outlined buttons, gradients, translucent chrome, all-caps labels, emoji or Unicode arrow separators.
- Use 4/8/12/16/20/24/32px spacing. Inspection header 56–60px, side panel 248px when opened, desktop workspace inset 24px. Buttons and small controls are pill/circle shaped; viewport and editor use 18px corners. Hairlines separate working regions; shadows remain soft and sparse.

## Interface scope

- Only Replay and Data views remain. Data means inspection of existing camera recordings and signal charts; this interface does not capture a new recording. Statistics, Filtering, Frames, Action Insights, annotation editing and the external Doctor embed are removed from this fork's navigation and view controller. Keep upstream attribution and unmodified standalone modules available as source.
- The inspection header is a single compact row with the Clio mark, an episode picker, Replay/Data selection, replay tools, dataset browsing and the theme toggle. Hide the wordmark and extra Visualizer text in this working surface. Dataset browsing is a compact public dataset picker, not a marketing page.
- Episode selection opens from the header picker; the collapsed list occupies no rail or vertical label. Scene composition stays available through Scene, including existing local import, export and pose editing. Label the robot transform “Robot placement” and distinguish whole-robot placement from recorded joint motion. Use meters, degrees and size multiplier labels for object adjustments.
- Origin axes and their labels are hidden by default. Debug (or an explicit ?debug=1) exposes them and joint mapping. Turning Debug off removes diagnostics immediately. A subdued floor grid remains spatial context.
- Show Scene details only in Debug mode, preserving model reference-pose and static-reconstruction caveats there. Never imply reconstructed props are recorded trajectories.
- Playback is the primary action; seek, current time, duration and optional motion trails share one compact transport. Round displayed seconds to the nearest integer while preserving full seek precision.

## Behavior and checks

Keep visible focus rings, labeled native form controls, pressed/expanded states, and reduced-motion support. On narrow displays, keep the primary navigation together and wrap only replay tools onto a compact second row when needed, open episode selection as a drawer, and put the scene editor below the viewport with bounded scrolling. Keep a useful minimum canvas height; allow the workspace to scroll on short screens. Check light/dark, collapsed/expanded sidebar, scene editor, Debug, playback and dataset browsing. Missing model/data errors must offer a recovery action. Private recordings and scene storage stay local; this redesign adds no upload or publishing flow.

## Clio episode viewer

The `/clio` pages replay Clio recordings, live or finished. These rules add to the ones above and, where they are more specific, win over them on Clio pages. The G1 demo keeps its current look.

### Measured, derived and inferred

Every value on screen belongs to one of three levels. Each level keeps one look in the 3D scene, the lanes and the inspector, and a lower level never borrows a higher level's look.

- **Measured**: what the headset wrote at capture time. Hand joints, head pose, object updates with their recorded source, detector answers with their recorded confidence and latency and, in episodes that declare them, location flags and grasp and release events. The source says how the headset got the value: a layout position is a recorded plan position, not a sensor reading. Measured marks are solid and full height.
- **Derived**: exact arithmetic on measured values, with no assumptions. Time since the last update, a detector's observation time (answer time minus its latency), batch counts. Derived marks are thin 1px strokes in the muted color, never filled bars. A derived figure's label names its basis, such as "4.2 s since update".
- **Inferred**: the viewer's own guess, which can be wrong. Held spans from pinch proximity or from frame-rate pinch runs, and any event whose origin is `inferred`. Inferred marks are the measured mark drawn dashed in the muted color, and their label says so ("Inferred from pinch"). In the event list an inferred event carries a muted "Inferred" after its name.

Show confidence only where it was measured (detector and marker answers). When it is null, leave the row out instead of showing 0, a dash or "n/a". Episodes without location flags never show tracking loss; the lane's tooltip says "Tracking loss not recorded" instead of drawing a gap.

### Color roles

Each role keeps its meaning across the scene, lanes, inspector and list. Every color is opaque.

| Role      | Light                                | Dark    | Used for                                                                                                         |
| --------- | ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------- |
| Live      | `--accent` #FF7B3D with #0F1117 text | same    | The Live pill and the live edge; nothing else in the lanes or scene                                              |
| Detection | #6D4AD8                              | #B49CFF | Detector and marker ticks, detector answers, detection outlines                                                  |
| Hand      | `--fg-soft` #24303D                  | #C3CBDB | Pinch placement and carried ticks, recorded held spans                                                           |
| Held ring | `--fg` #0F1117                       | #EDF0F5 | The 3D held ring                                                                                                 |
| Plan      | `--fg-faint` #646D7C                 | #8A94A4 | Layout and manual ticks                                                                                          |
| Muted     | `--fg-muted` #5B6472                 | #A5AFBF | Derived strokes, inferred dashes, misses, position lost, the head and its trail                                  |
| Missing   | `--fill-strong` #E4EAF1              | #303742 | Time ranges the viewer has not loaded or has not kept                                                            |
| Problem   | `--flag-fg` #BE123C                  | #FDA4AF | Missing batches and failed reads, as text. Flagging is not in the Clio navigation, so here rose means a problem. |

Objects get identity colors in the order they first appear in the capture, cycling after seven: teal #0F7C80 / #5AD1C5, green #3B8A3E / #7FD483, gold #A07400 / #F2C94C, magenta #C2417A / #FF8FC0, blue #2F6FDE / #8AB4FF, brown #8B5E3C / #D9A66F, olive #66791A / #C4D66B (light / dark). Identity colors appear on the 3D object, its trail and label, and the swatch beside its lane, never on lane marks. Hands use muted colors, left #4F6D8F / #9DB7D5 and right #8F5A6B / #D9A3B5, so they read as the person rather than as tracked objects. Every scene color keeps at least 3:1 against the canvas (#F4F6FA light, #14171D dark).

### 3D scene

- **Objects**: a dot, the object's radius ring flat on the table, a 3 s trail and a name label, all in its identity color. Hidden objects (such as a shirt-fold zone) are not drawn and get no lane.
- **Held ring**: while a held span covers the viewed time, a ring in the held-ring color sits 12 mm outside the radius ring. A recorded span draws it solid; an inferred span draws it as evenly spaced segments, matching the dashed lane band. There is no ring outside a span.
- **Unknown orientation**: an object whose rotation is null has no heading. Draw only the dot and radius ring, never a box or axes at the identity rotation; the inspector shows "Orientation unknown". With a known rotation, a short tick from the dot to the ring marks its forward (+X) axis.
- **Position lost** (episodes with location flags): the object stays at its last valid position in the muted color, and its trail ends at the loss. Without flags, nothing is drawn as lost.
- **Hands**: only the 25 recorded joints and their bones. An untracked hand, or one outside the kept range, disappears; there is no ghost at the last pose.
- **Detections**: a line loop in the detection color, with no fill and a small "Approximate" label, because the outline assumes a camera model. The reason ("Assumed camera model") goes in the inspector or a tooltip, not on the canvas.
- **Context**: the workspace box and the floor plane from calibration stay as subdued as the grid. Their labels follow the axes rule and appear in Debug: "table corner" at the origin and "floor from calibration" on the floor.

### Lanes

One row per drawn object, in the order objects first appear, on one time axis that spans the whole episode (up to the live edge while live).

- Rows are 28px tall. The 144px label column holds an 8px identity swatch, then the object name in Inter 13px/500 `--fg-soft`, truncated, with the full name in a tooltip. `--line-subtle` hairlines separate rows on `--surface-0`.
- Top band, 6px: held spans. Recorded is solid in the hand color; inferred is dashed (6px dash, 3px gap) in the muted color.
- Middle, 12px: update ticks, 2px wide, colored by source as detection, hand or plan. A carry updates at frame rate, so its ticks merge into a solid run; that is real data.
- Detector answers sit on the tick row: a 1px derived stroke from observation time to answer time, ending in an 8px solid circle in the detection color when found, or an 8px solid muted square for a miss.
- Bottom band, 4px: position lost, solid muted, only in episodes with location flags.
- Missing ranges ("Not loaded", "Hands not kept") fill the full lane height in the missing color behind the marks and are named once on the time axis.
- The playhead is a 1px `--playhead` line across the axis and lanes. The live edge is a 2px citrus line, and the playhead never passes it.
- One legend row above the lanes uses solid swatches and one word each: Detector, Hand, Plan, Held, Inferred, Lost.
- Every mark has a hover and focus tooltip with its exact time and source. Shape, dash and position carry each distinction, so color is never the only cue.
- The selected object's row uses `--accent-soft` (#FBE5DA / #452D24) behind its label; its 3D object keeps its identity color.

Source labels in the lanes, legend and inspector:

| Recorded source   | Label                                           | Tick color |
| ----------------- | ----------------------------------------------- | ---------- |
| `layout`          | Plan layout                                     | Plan       |
| `manual`          | Manual                                          | Plan       |
| `pinch` placement | Pinch placement                                 | Hand       |
| `clio-grip` carry | Carried                                         | Hand       |
| `detector`        | Detector, with the recorded finder in a tooltip | Detection  |
| `marker`          | Marker                                          | Detection  |

### Status and live

- Status pills are 20px tall with 8px side padding, in Inter 12px/500 and sentence case. **Live** is a citrus fill with #0F1117 text in both themes. **Stopped** and **Reconnecting** use a `--fg-muted` fill with `--surface-0` text (#FFFFFF / #14171D). **Finished** uses a `--fill-strong` fill with `--fg-soft` text.
- Batch integrity appears only when something is missing: "3 batches missing" in the problem color beside the pill, in the list and the header. A complete episode adds no text; the Finished pill's tooltip says "All 12 batches received".
- While following, the transport shows the Live pill. After a seek away from the edge, a filled slate "Go live" pill takes its place.
- The live indicator never pulses or blinks; the advancing edge shows growth.
- The Clio transport shows tenths of a second (`m:ss.s`, as `formatClock` writes it), an exception to whole-second rounding, because steps, grasps and detector latency are sub-second.
- Lag figures, duplicate and rejected counts and episode ids belong to Debug, in system monospace and the muted color. The arrival-age figure is labeled "approximate", because the headset and laptop clocks can differ.

### Headers and copy

- Headers and list rows name an episode by its procedure title and start time, as separate text with a gap between them. Never show episode ids, schema ids, sequence numbers, entity ids or version stamps in headers, list rows, lane labels or 3D labels. Ids live in the URL and in Debug.
- Name objects by their display name and events in plain words. Write ranges with "to" ("1:02.3 to 1:03.1"). No middle dots, bullets or arrow symbols anywhere in the UI.
- No status text that carries no decision: no "Connected", no "Complete" on every row, no explanatory paragraphs. Detail goes in a tooltip only when it is needed.
- "Follow live" is a solid ink primary button; "Pin" and "Go live" are filled slate secondary pills. When the Clio server cannot be reached, the list says so and offers Retry.

### Solid fills

Status pills, legend swatches, lane bands and marks, missing ranges and the selected row are opaque fills. Shade time ranges with the missing color, never a translucent overlay. Trails and the live edge are solid, with no gradient or fade. 3D materials stay opaque: a lost object changes to the muted color, not to a lower opacity. Detection outlines and radius rings are lines with no fill. No pill, swatch or button here has an outlined variant.

### Checks for Clio pages

Check light and dark; live, stopped, finished and reconnecting; an episode with and one without location flags; a null rotation; recorded and inferred held spans; "Not loaded" and "Hands not kept" ranges; a long object name; and narrow widths, where the lanes sit below the viewport and the label column shrinks to the swatch and a truncated name.
