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

Up close the depth map is not trusted. Meta gives the Quest 3 depth estimate a minimum effective
range of about 20 cm and calls nearer reads unreliable, so a read nearer than 20 cm (or one that is
not a number) is unknown: it never hides the light. And the test fades out as the light itself
comes near: fully on beyond 40 cm, off within 28 cm (where a surface hiding it would have to be
nearer than 20 cm, given the margin and falloff). A learner leaning over the table never loses the
light to a phantom surface; hands still hide it, through their occluders. The views' near plane
stays at 1 cm: three.js would move it to the depth map's 10 cm and clip what is that close
(window.__nearPlane.set(m) tries another live).

Everything else stays in view. Panels that trail the head (the instruction card, the HUDs) rise to
stay within 20 degrees of the gaze when the learner looks down at the work, just above it, and
they and the names over objects draw over the light and the hands' occluders (no depth test, after
everything else), so a raised hand never takes the instructions away. A frame whose update or
render throws is skipped, counted and logged once, and the next one draws as usual: three.js asks
for the next frame only after the last returns, so one exception used to leave only passthrough
(window.__frames counts them).

window.__occlusion switches all of it live on the headset (setDepth, setHands, setFilter,
setSoftness, setPlane, setMargin, setMinDepth, setNearRange, setViz, probe, stats; stats.render
has the near plane in use, stats.frames the frames that threw, and setViz('diff') shows the
too-near zone in yellow). The primary demo renders with no fixed foveation and at 1.25 times the
browser's resolution, so the light's edges stay sharp across the view.

Cost: the CPU builds only that field per new mask (about 0.9 ms on a Mac for a 64-point mask),
with no allocations; all softness is shaped in the fragment shader. Quad, material and texture are
reused; XR frames only move, fade and animate the group. `glow-preview.html` renders the effect
on the demo photo with saved masks, a live local tracker mask, jitter and an orbiting eye.
