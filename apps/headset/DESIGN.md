# Headset UI

The launch page and lesson cards use the supplied **Clio Design Principles** (2026-10-24):
quiet cool slate, opaque white surfaces, near-black ink, hairlines and filled pill controls.
The shared library reference is `awesome-design-md/references/design-md/linear.app/DESIGN.md`
for restraint, hierarchy and surface separation; the supplied light palette and pill shapes
override that reference's dark palette and purple controls.
- Canvas `#EDF2F6`, surface `#FFFFFF`, inset `#F4F6FA`, ink `#0F1117`, secondary `#5B6472`,
  placeholder `#646D7C`, opaque hairline `#D7DFE8`. Focus is guidance blue `#1768D9`.
- Inter carries UI copy, with Inter Tight for the launch question. Self-host fonts. The launch
  screen uses a low-contrast painted daylight sky; AR always keeps the real passthrough view.
  No marketing sections or decorative serif words are added to this task surface.
- Launch with the question, goal field and dark filled Start lesson button. Remove the wordmark,
  tagline and empty-goal hint. Keep options below and setup problems only when relevant.
- Controls stay at least 56px tall on the launch page. Use 24px vertical grouping and 12px
  within the field/button pair. On phones use 24px side padding and natural vertical scrolling.
- Lesson cards fit the measured content in both width and height. Short messages are compact;
  instructions, details and actionable corrections expand naturally within a comfortable reading
  width. Keep readable text size and padding rather than shrinking the type or forcing a square.
  Use subtly rounded corners, dark text, a dark filled Done pill and sentence-case metadata.
  Quiet listening has no label or dot. Report a disconnected voice with an actionable message.
- Position cards beside the projected object silhouette with a 3.5cm gap at the card plane.
  Consider left, right, top and bottom, avoiding every known mask, including live tracker masks.
  Follow the full gaze orientation, including looking down at a table; start adjacent to the task.
  Use conservative mask bounds; estimates without masks use their declared object radius.
  Evaluate the full measured card rectangle, preferred view bounds, task proximity and gaze travel
  when choosing a side. Recheck when its size changes, and prefer a fully visible comfortable fit.
  Keep a clear placement stable. If a moving mask blocks it, choose a new clear position without
  animating across the object. In a crowded view, preserving object visibility takes precedence
  over keeping the whole card inside the preferred view area.
- Keep keyboard focus, readable disabled states, reduced-motion support and local-only assets.
  The gallery previews the actual launch UI and presenter, including explicit mask-clearance cases.

The supplied Inter families are an intentional exception to generic font-diversity lint warnings.
Gallery headings are styled through its dynamically imported CSS (H2 25.6px, H3 17.6px, body 16px),
which the HTML-only hierarchy detector does not resolve.

## Tracked object light

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

The object-light treatment is independent of the white instruction cards. Preserve its existing
cyan and destination-yellow semantics while applying the slate theme to UI surfaces.
