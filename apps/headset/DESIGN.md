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

Cost: the CPU builds only that field per new mask (about 0.9 ms on a Mac for a 64-point mask),
with no allocations; all softness is shaped in the fragment shader. Quad, material and texture are
reused; XR frames only move, fade and animate the group. `glow-preview.html` renders the effect
on the demo photo with saved masks, a live local tracker mask, jitter and an orbiting eye.
