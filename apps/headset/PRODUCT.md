# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a learner wearing a Meta Quest 3 who wants to learn a hands-on task right now:
refill a car's washer fluid, run an acid-base indicator lesson, fold a shirt. They are standing or
sitting at a real table with the real objects in front of them, hands busy, reading little. They
reach the app in Quest Browser, start it from a 2D launch page, then spend the lesson in passthrough
AR talking with a voice coach.

Secondary audiences, confirmed but not designed for first: the two developers testing on a laptop
(desktop emulator, `?debug=1`), and people watching a mirrored headset at a demo.

## Product Purpose

Clio is an AR tutor that can teach any hands-on task. The learner says a goal; a planner writes the
lesson from the goal and what the headset camera sees; the coach talks them through it step by
step, highlights the real objects each step needs, shows the motion with ghost hands and catches
mistakes. Success is a learner who finishes the task correctly without reading a manual.

Every lesson is also recorded as intent-labeled hand, object and language data that robots can
learn from ("every lesson trains two students: you, and a robot").

## Positioning

The lesson is planned live from the learner's own goal and their own table, not picked from a
catalog, and the real objects are found and lit in place rather than drawn as generic arrows.

## Operating Context

- Quest Browser on Quest 3, served from the laptop over `adb reverse` (localhost) or Wi-Fi HTTPS.
  The launch page is a 2D browser window; the lesson is an immersive-ar WebXR session.
- Input on the launch page is the controller or hand ray and the Quest's virtual keyboard or
  dictation; typing is slow, so the page asks for as little as possible.
- In AR the learner talks to the coach (Gemini Live, voice); hands are on the task. A floating
  instruction panel follows their gaze and has a touchable Done button.
- The laptop runs the server (8787), the headset app (5173), the object tracker (8790) and the
  episode visualizer (3001).

## Capabilities and Constraints

- Entering AR, the microphone and the camera need a user gesture and permission prompts on the 2D
  page; prompts cannot appear inside the immersive session.
- Without a Gemini key the app still runs with an offline, scripted coach that cannot see or
  listen.
- The coach's connection can be connecting, ready, reconnecting, closed or in error; planning takes
  several seconds.
- Saved lessons (curated in `procedures/`, or AI-planned earlier) can be started instead of a goal.
- Optional before a lesson: calibrate the table by pinching two corners; record expert
  demonstrations instead of learning.

## Brand Commitments

- Name: Clio. The launch UI omits the wordmark and tagline so the learner reaches the goal directly.
- Tracked objects glow cyan (`#24d4ed`); a lesson destination is yellow (`#ffd23f`)
  (apps/headset/DESIGN.md).
- Peter's UI rules: solid filled controls (no outlined buttons, pills or chips); solid opaque
  colors on UI elements (no gradients or translucent tints; charts exempt); no bullet, middle-dot
  or arrow characters in UI text; minimal copy, no status text that carries no decision.

## Evidence on Hand

Demo photos `public/demo/caliper.jpg` and `public/demo/micrometer.jpg`. Curated lessons in
`procedures/`. No user testimonials, metrics or press exist; never invent them.

## Product Principles

1. Get the learner into the lesson with almost no reading or typing.
2. Say what is wrong only when something is wrong, with the fix.
3. Keep quiet listening visually silent; show actionable connection problems without a transcript.
4. Perception serves the learner's view and the dataset; it never pretends to be measured.
