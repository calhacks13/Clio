# Tracked object light

The headset is an AR task surface. Preserve labels, placement, hand skeletons and HUD. The
visual reference is Desktop `Jev fun/experiments/edgetam/preview/index.html`: saturated cyan
emission, soft light falloff and readable real material. The user rejected flat segmentation
fills and stacked contour bands, and then asked for the object itself to look like it is
glowing: a three-dimensional light coming out of it, soft enough that an imperfect mask does not
show.

Cyan `#24d4ed` identifies the primary target; the existing yellow `#ffd23f` identifies a lesson
destination. One accent color per object. No hard outline stroke around a contour.

The light is a thin volume, not a decal. One quad per object samples a signed distance field
of the silhouette several times along each eye's ray, through slices from behind the outline's
plane to a little in front of it, so the two eyes see parallax and the edge thickens like a lit
solid when seen from an angle. Each slice emits a soft rim peaking just inside the boundary
(wider than a few camera pixels of mask error), faint inner light that fades inward from the rim
so markings stay readable, and an exterior bloom: a tight gaussian plus a long exponential tail,
wider in deeper slices. The light gets deeper blue as it falls off and slightly lighter where it
is strongest. Compositing is premultiplied with alpha below the emitted color, so it reads as
light added over passthrough.

Life: a slow breath (3.6 s, about +-7% brightness and +-5% bloom) and a brief flare (about 0.4 s)
when an object is newly found: a new name, or back after fading out. A mask a frame late must
not flare again.

Parts use the same profile scaled to their size and stay on the measured surface (shallow
volume, little spill). Whole objects let their bloom spill around them; the primary-object demo
treats its target as a whole object. Lesson `region`, `point` and `item` targets use surface
mode; `tool` and `container` targets use object mode. A box alone stays corner brackets without
claiming surface precision.

No texels or facets may show. The contour is resampled and rounded (Chaikin) over about two and a
half rim widths, so the rim follows a smooth curve and never a crease sharper than itself. The
field holds the exact distance to that curve at each of 192 x 192 texels, stored as one R16F
channel: never distance packed into 8-bit channels, which mobile GPUs filter at 8 bits. The soft
edge spans at least 1.5 texels. Half a step of screen-space dither keeps the long bloom free of
8-bit bands.

Depth order: the light sits where the object is. A hand in front hides it, through depth-only
occluders built from the tracked joints (each joint's radius plus 1 mm: any more shows as a gap
around the hand). A real surface hides it only when it is more than 5 cm nearer than the object's
own front, fading over 3 cm. That front is read from the depth map at 16 points inside the
silhouette: about the 10th percentile, and where the points allow, a plane fitted to them, so an
object that leans toward the wearer (a laptop's lid, its near corners) never hides its own light.
The depth map is coarse (320 texels across the view on Quest), so each fragment blends the tests
of the 4 x 4 nearest texels with cubic B-spline weights and cuts the blend narrowly: a smooth
contour that stays tight to the hand. Quest Browser hands out the same XRFrame object every frame,
so per-frame caches key on the renderer's frame count, never on the frame object.
window.__occlusion switches all of it live on the headset (setDepth, setHands, setFilter,
setSoftness, setPlane, setMargin, setViz, probe, stats). The primary demo renders with no fixed
foveation and at 1.25 times the browser's resolution, so the light's edges stay sharp across the
view.

Cost: the CPU builds only that field per new mask (about 0.9 ms on a Mac for a 64-point mask),
with no allocations; all softness is shaped in the fragment shader. Quad, material and texture are
reused; XR frames only move, fade and animate the group. `glow-preview.html` renders the effect
on the demo photo with saved masks, a live local tracker mask, jitter and an orbiting eye.

# Highlight colors

One accent per object, chosen by the object's role in the current step, never by its position
in the show list (today's rank table in `presenters/outlines.ts` is the thing to replace). The
coach never names a color: it names a style, and the style maps here. These are the only accents
allowed; solid, saturated emitters, no tints, no gradients, no outline stroke.

| Role | What the learner reads | Accent | Where it comes from |
| ---- | ---------------------- | ------ | ------------------- |
| Act | the thing to pick up or operate now | cyan `#24d4ed` | the step's acting show item (`tool`, `item`) |
| Destination | where it goes, what it fits into | yellow `#ffd23f` | the step's `container` or `region` |
| Part | the exact spot on an object (door, scale, button) | the parent's accent, surface mode | an `item` or `region` that belongs to a parent |
| Goal level | how far: the fill band on a beaker, the mark to reach | green `#3ddc84` | a step with a target amount; the band is the part of the object's mask below the target line |
| Stop or wrong | too far, the wrong object, keep clear | red `#ff5a5a`, a 0.6 s pulse that fades | the watcher's mistakes; coach style `warning` |
| Coach hint | what the coach is pointing at, for 5 s | white `#f2f6fa`, at 60% energy | coach style `attention` |

Coach styles: `target` recolors nothing and flares the object's own accent; `attention` adds the
white hint around it; `warning` pulses red. A hint never replaces a step color: it is a second,
softer glow on the same silhouette.

Rules: at most one cyan and one yellow at a time, so the eye always knows what moves and where.
Green appears only once the acting object is in hand. Red is never steady. Colors follow the
step, not the object: the beaker that was a destination is cyan the moment a step acts on it.
(This is the design's call, made 2026-10-24; change it here if lessons read better with
object-stable colors.)

Implementation map: the plan gives each show item a `role` (act, destination, part, level) and
an optional target amount; the overlay model turns role, coach style and source into one accent
from this table; the outlines presenter reads that accent; the level band is cut from the
tracker's mask in the renderer. The tracker (`tracker/`) sends geometry only and knows nothing
about color.
