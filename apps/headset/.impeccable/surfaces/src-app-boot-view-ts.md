---
version: 1
slug: "src-app-boot-view-ts"
primary_target: "src/app/boot-view.ts"
related_targets: ["src/styles.css","src/app/boot.ts","src/adapters/render/presenters/instruction-panel.ts"]
---

# Launch page and coach status

Scope: the 2D launch page (`src/app/boot-view.ts`, `src/styles.css`, wired by `src/app/boot.ts`) and
the coach status mark on the in-headset instruction panel
(`src/adapters/render/presenters/instruction-panel.ts`). Mode: Operate.

Audience and task: a learner in Quest Browser on a Quest 3, about to start a lesson; pointer or hand
ray, slow virtual keyboard. Confirmed by the user on 2026-10-24: lead with a goal box and one
button; saved lessons, table calibration and demo recording tucked below; setup checks only when
something is wrong, with the fix; the coach status lives on the lesson panel.

## Direction contract

THESIS: The launch page is a doorway, not a dashboard: one question, one button, and silence when
everything works. It refuses the setup-checklist page with diagnostics on top.

OWN-WORLD: The headset's light world on a 2D page. A deep navy ground like a dark room before
passthrough; one light, the same cyan the real objects glow, carried by the primary button and the
focus ring; cool white text, muted blue secondary text; solid borderless fields on a raised navy;
problems as solid amber or red blocks with dark text. Large, plain system type sized for a browser
window floating in a headset.

STORY: The learner reads one question, types or dictates a goal or leaves it empty, presses the
button, allows microphone and camera, and is in AR. When something is broken they see what and the
fix before pressing.

FIRST VIEWPORT: Quest Browser window (about 1280 x 720 CSS px). One column, max about 40rem, centred.
Small wordmark and tagline at the top; the question as the heading (about 2.4rem); a full-width
64 px input; directly under it a full-width cyan button, 64 px; one short hint line; a collapsed
"More options" disclosure below. A problem block appears above the question only when needed.
Signature move: the button narrates its own progress in place (permissions, entering AR, an error
with retry), so nothing else on the page has to.

FORM: the user's pinned structure (goal box, one button, options below, checks only when wrong);
the dealt structures were not used. seed:480395b52405a8f3

Coach status mark: a small solid mark plus one word at the right of the panel's header row.
Listening (calm cyan, slow breath), Listening while the learner talks (cyan, livelier), Clio
speaking (three white bars moving), Planning (cyan arc turning), Connecting (amber, blinking),
Voice offline (red, still). Hidden for the offline scripted coach. Priority: offline, connecting,
speaking, hearing, planning, listening.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
