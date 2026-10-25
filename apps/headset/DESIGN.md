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
- Anchor cards in the room: both world position and orientation remain fixed during ordinary head
  turns, leaning, head bob and brief glances away. Do not billboard or rearrange them every frame.
  Keep every card upright and level with the world horizon: placement uses heading only, never
  the headset's pitch or roll. Relocation and catch-up preserve that level orientation.
  Only after the card stays well outside reading reach (50 degrees horizontally, 40 vertically,
  or outside 35cm–1.45m) for 800ms may it ease toward one captured recovery target. Use a damped
  spring with no continuous head chasing, and let it settle before another optional recovery.
  Keep a card still while a fingertip is near it. Reduced motion disables optional catch-up.
- Keep a 6cm minimum gap at the card's actual depth from every known object, with extra initial
  clearance so modest head movement and tracker jitter do not trigger constant rearrangement.
  Consider left, right, top and bottom. Include all followed masks, including objects not lit by
  this step, and detected nearby furniture before any lesson is running. Reserve 18cm above a
  detected worktop as presentation clearance for the working area; never record that buffer as
  measured geometry. Structural room planes do not block the entire UI view.
  Use conservative mask bounds; estimates without masks use their declared object radius.
  Check all four corners of the actual world-oriented card for both eyes, including depth and
  parallax. Resizing and each catch-up sample must preserve clearance, including the swept path.
  A newly blocking object may require immediate relocation; optional head recovery must never
  slide through an object. In a crowded view, object visibility takes precedence over keeping the
  whole card inside the preferred view area.
- Keep keyboard focus, readable disabled states, reduced-motion support and local-only assets.
  The gallery previews the actual launch UI and presenter, including a manual head-movement
  preview with a fixed world task and mask-clearance cases.

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

Up close the depth map is not trusted. Meta gives the Quest 3 depth estimate a minimum effective
range of about 20 cm and calls nearer reads unreliable, so a read nearer than 20 cm (or one that is
not a number) is unknown: it never hides the light. And the test fades out as the light itself
comes near: fully on beyond 40 cm, off within 28 cm (where a surface hiding it would have to be
nearer than 20 cm, given the margin and falloff). A learner leaning over the table never loses the
light to a phantom surface; hands still hide it, through their occluders. The views' near plane
stays at 1 cm: three.js would move it to the depth map's 10 cm and clip what is that close
(window.__nearPlane.set(m) tries another live).

Everything else stays in view. The HUDs rise to stay within 20 degrees of the gaze when the
learner looks down at the work. Instruction cards use the persistent, horizon-level anchoring
and delayed recovery described above. Cards, HUDs and the names over objects draw over the light
and the hands' occluders (no depth test, after everything else), so a raised hand never takes the
instructions away. A frame whose update or
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

The object-light treatment is independent of the white instruction cards. Its role-based
accents are shared by the lesson and live renderers.

## Highlight colors

One accent per object, chosen by the object's role in the current step, never by its position
in the show list (shared by the lesson and live renderers). The
coach never names a color: it names a style, and the style maps here. These are the only accents
allowed; solid, saturated emitters, no tints, no gradients, no outline stroke.

| Role          | What the learner reads                                | Accent                                  | Where it comes from                                                                          |
| ------------- | ----------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| Act           | the thing to pick up or operate now                   | cyan `#24d4ed`                          | the step's acting show item (`tool`, `item`)                                                 |
| Destination   | where it goes, what it fits into                      | yellow `#ffd23f`                        | the step's `container` or `region`                                                           |
| Part          | the exact spot on an object (door, scale, button)     | the parent's accent, surface mode       | an `item` or `region` that belongs to a parent                                               |
| Goal level    | how far: the fill band on a beaker, the mark to reach | green `#3ddc84`                         | a step with a target amount; the band is the part of the object's mask below the target line |
| Stop or wrong | too far, the wrong object, keep clear                 | red `#ff5a5a`, a 0.6 s pulse that fades | the watcher's mistakes; coach style `warning`                                                |
| Coach hint    | what the coach is pointing at, for 5 s                | white `#f2f6fa`, at 60% energy          | coach style `attention`                                                                      |

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
