---

version: 1
slug: "src-app-boot-view-ts"
primary_target: "src/app/boot-view.ts"
related_targets: ["src/styles.css","src/app/boot.ts","src/adapters/render/presenters/instruction-panel.ts"]
---

# Launch page and lesson cards

Scope: the 2D launch page (`src/app/boot-view.ts`, `src/styles.css`, wired by `src/app/boot.ts`) and
the content-sized in-headset instruction cards
(`src/adapters/render/presenters/instruction-panel.ts`). Mode: Operate.

Audience and task: a learner in Quest Browser on a Quest 3, about to start a lesson; pointer or hand
ray, slow virtual keyboard. Confirmed by the user on 2026-10-24: lead with a goal box and one
button; saved lessons, table calibration and demo recording tucked below; setup checks only when
something is wrong, with the fix; actionable connection problems appear on the lesson panel.

## Direction contract

THESIS: The launch page is a doorway, not a dashboard: one question, one button, and silence when
everything works. It refuses the setup-checklist page with diagnostics on top.

OWN-WORLD: The supplied Clio Design Principles: quiet slate UI over a painted daylight sky on the
launch page, opaque white cards in AR, near-black ink, Inter typography and solid dark pill
controls. Guidance blue belongs to focus and AR, while existing object glows keep their colors.

STORY: The learner reads one question, types or dictates a goal or leaves it empty, presses the
button, allows microphone and camera, and is in AR. When something is broken they see what and the
fix before pressing.

FIRST VIEWPORT: Quest Browser window (about 1280 x 720 CSS px). One column, max about 40rem, centred.
The question is the heading, with no wordmark, tagline or empty-goal hint; a full-width
64 px white input; directly under it a full-width dark pill button, 64 px; a collapsed
"More options" disclosure below. A problem block appears above the question only when needed.
Signature move: the button narrates its own progress in place (permissions, entering AR, an error
with retry), so nothing else on the page has to.

FORM: the user's pinned structure (goal box, one button, options below, checks only when wrong);
the dealt structures were not used. seed:480395b52405a8f3

Lesson cards: content-sized white cards offset beside objects with clear space around every
projected mask. Both width and height follow measured text, with fixed readable type and padding.
Choose initial placement using the complete card rectangle, visibility, task proximity and gaze
travel. Keep position and orientation anchored in world space while the learner moves their head;
use a delayed damped recovery only after sustained loss of reach. Avoid all tracked objects and
nearby detected furniture with a 6cm minimum gap and extra initial clearance. No listening label,
dot or duplicate transcript. Useful
instructions, corrections and actionable offline messages remain.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
