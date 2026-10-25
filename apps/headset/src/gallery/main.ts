import { mountDemoPreview } from './demo-preview';
import {
  fitFrames,
  launchFrame,
  PHONE,
  QUEST_WINDOW,
  showLaunchAlone,
  stateSlug,
} from './launch-frames';
import { mountPanelCards } from './panel-cards';
import { mountPanelMotionPreview } from './panel-motion-preview';
import { LAUNCH_STATES, PANEL_STATES } from './states';

// The UI gallery (gallery.html): every UI Clio has, in its states, rendered from the real code so
// an edit shows here on save (Vite reloads the page and it comes back to the same place). The
// states are data in states.ts. `?launch=<state>` shows one launch state alone (each frame's name
// links to it), and `&focus=<id>` focuses an element in it.

const $ = (id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`gallery.html has no #${id}`);
  return el;
};

const params = new URLSearchParams(location.search);
const alone = LAUNCH_STATES.find((s) => stateSlug(s.name) === params.get('launch'));
if (alone) showLaunchAlone(alone, params.get('focus'));
else if (params.has('demo')) void import('./gallery.css').then(showDemoAlone);
else void import('./gallery.css').then(mountGallery);

function showDemoAlone(): void {
  document.title = 'Demonstrations';
  const main = document.createElement('main');
  main.className = 'demo-alone';
  const title = document.createElement('h1');
  title.textContent = 'Demonstrations';
  const preview = document.createElement('div');
  main.append(title, preview);
  document.body.replaceChildren(main);
  mountDemoPreview(preview);
}

function mountGallery(): void {
  const launch = $('launch');
  fitFrames(launch);
  $('launch-frames').append(...LAUNCH_STATES.map((s) => launchFrame(s, QUEST_WINDOW)));
  $('launch-phone').append(
    ...LAUNCH_STATES.filter((s) => s.phone).map((s) => launchFrame(s, PHONE)),
  );
  mountPanelMotionPreview($('panel-motion'));
  mountPanelCards($('panel-cards'), PANEL_STATES);
  mountDemoPreview($('demo-preview'));

  // Every frame has a fixed size, so the page is at full height now: restore the scroll position.
  const SCROLL_KEY = 'clio-gallery-scroll';
  history.scrollRestoration = 'manual';
  try {
    const y = Number(sessionStorage.getItem(SCROLL_KEY));
    if (y > 0) window.scrollTo(0, y);
    else if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  } catch {
    // Storage blocked: start at the top.
  }
  window.addEventListener('pagehide', () => {
    try {
      sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
    } catch {
      // Storage blocked.
    }
  });
}
