import './gallery.css';
import { fitFrames, launchFrame, PHONE, QUEST_WINDOW } from './launch-frames';
import { mountPanelCards } from './panel-cards';
import { LAUNCH_STATES, PANEL_STATES } from './states';

// The UI gallery (gallery.html): every UI Clio has, in its states, rendered from the real code so
// an edit shows here on save (Vite reloads the page and it comes back to the same place). The
// states are data in states.ts.

const $ = (id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`gallery.html has no #${id}`);
  return el;
};

const launch = $('launch');
fitFrames(launch);
$('launch-frames').append(...LAUNCH_STATES.map((s) => launchFrame(s, QUEST_WINDOW)));
$('launch-phone').append(...LAUNCH_STATES.filter((s) => s.phone).map((s) => launchFrame(s, PHONE)));
mountPanelCards($('panel-cards'), PANEL_STATES);

// Every frame has a fixed size, so the page is at full height now: restore the scroll position.
const SCROLL_KEY = 'clio-gallery-scroll';
history.scrollRestoration = 'manual';
try {
  const y = Number(sessionStorage.getItem(SCROLL_KEY));
  if (y > 0) window.scrollTo(0, y);
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
