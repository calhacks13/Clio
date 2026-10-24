# Glow tracking: an organic outline that follows the part every frame

> Design agreed in chat on 2026-10-24. Local and test only: a flag in the tracker, nothing merged.

## Intent

The headset highlight should be the real shape of the part or object the learner is interacting
with (a fridge door: its outside, inside and edge as they come into view), and it should move
with that part on every frame so it reads as the thing itself glowing. Today the outline is
YOLOE-26's prototype mask for a whole-object candidate: coarse (about 6 frame pixels per mask
cell), and for a part it is the parent's mask cut to jev's box or a rounded rectangle, because
YOLOE proposes whole objects only. Measured on 24 jev boxes: YOLOE-26L gives no outline at all
on 11 of 35 cases and its box IoU (0.73) equals jev's own box (0.72); SAM 2.1 Small reaches
0.79 in 140 ms a frame on this Mac, Large 0.80 in 520 ms; SAM 3.1 is no better here and ten
times slower.

## The three loops

1. **Identify (jev, about once a second, unchanged).** jev names and boxes the target on a
   frame. It decides *what*. Its box is loose and rounded to 0.01, so it never defines the shape.
2. **Segment (SAM 2.1, on jev's frame and on demand).** The *keyframe mask*: SAM 2.1 prompted
   with jev's box on the very frame jev looked at. The same model re-segments the newest frame,
   prompted with the followed box, whenever the follower is in doubt (at most about five times a
   second with Small). Both run in a background thread; the stream never waits for them.
3. **Follow (every frame, local, a few milliseconds).** The latest mask is carried to the
   current frame by the camera's motion (motion.py, as now) plus the part's own motion, measured
   from sparse flow points inside the mask (the same Lucas-Kanade, forward-backward check and
   RANSAC as motion.py, seeded inside the mask). The warped mask is the outline. When too few
   points survive, or the warped mask disagrees with ByteTrack's box for the object, the follower
   reports doubt: the outline falls back to today's behaviour and a refresh is requested.

YOLOE and ByteTrack stay: whole-object candidates keep the object's identity between jev
answers, the appearance memory decides re-acquisition, and `wants_jev_now` still asks jev early.

## Goals

- An outline that is the segmenter's mask, on every frame, for whole objects and parts alike.
- The headset needs no change: `/track` and `/locate` keep their messages; only the geometry
  gets better.
- Off by one flag: `--segmenter none` restores today's tracker exactly.

## Non-goals

- Replacing jev, or any grounding model (LocateAnything is a grounder, not a segmenter).
- A new on-device model. Everything runs on the Mac.
- Text-prompted segmentation (SAM 3.1 text missed 9 of 35 parts).

## Anti-goals (what would make this a failure)

- An outline that freezes between segmenter answers, or lags the door by more than a few pixels
  while it swings.
- The stream's frame rate dropping because the segmenter runs on the stream thread.
- A part's outline spilling onto the whole object again.

## Decisions

- Segmenter: SAM 2.1 through Hugging Face `transformers` (`Sam2Model`, `Sam2Processor`), on
  MPS, `facebook/sam2.1-hiera-small` by default (`sam2.1-large` selectable). Best of the three
  candidate masks by the model's own predicted IoU, no box padding (padding hurt in the
  earlier benchmark).
- The follower estimates a full affine (RANSAC) when it has at least 12 inliers, a similarity
  with 8 to 11, and otherwise uses the camera's motion alone and reports doubt.
- When unsure (hand over the door, blur), the outline holds its last shape at the predicted
  place for the tracker's existing coast window, then fades with the existing confidence decay.
  (My call; easy to change.)
- Refresh pacing: never two segmenter calls in flight; at least 150 ms apart; a keyframe
  (jev's answer) always wins the slot.
- Settings: `CLIO_TRACKER_SEGMENTER` / `--segmenter` = `auto` (SAM 2.1 Small when
  `transformers` is installed, else none), `none`, `sam2.1-small`, `sam2.1-large`.
- Measured with the jitter harness: the existing part scenes plus two new ones where the part
  moves on its own (a slide and a swing), and on the headset over `/track`.

## Left to the builder

Exact thresholds for doubt beyond those above, crop resolutions, and how the moving-part
scenes are synthesized, within the plan's tests.
