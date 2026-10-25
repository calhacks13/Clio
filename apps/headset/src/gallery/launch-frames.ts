import { bindBootView, renderBoot } from '../app/boot-view';
import styles from '../styles.css?inline';
import type { LaunchState } from './states';

// The launch page in frames: each state is its own document (an iframe with the page's real
// stylesheet), so ids don't collide and :root and body rules apply as they do in index.html. A
// frame is drawn at its real size in CSS pixels and scaled down to the column (--scale, set by
// fitFrames), with the real size in its label.

export interface FrameSize {
  width: number;
  height: number;
}

/** Quest Browser's default window, in CSS pixels. */
export const QUEST_WINDOW: FrameSize = { width: 1280, height: 720 };
export const PHONE: FrameSize = { width: 390, height: 844 };

const page = (state: LaunchState) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>${styles}</style>
  </head>
  <body><div id="app">${renderBoot(state.model)}</div></body>
</html>`;

/** The state's name in a URL: `?launch=<slug>` shows that state alone. */
export const stateSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Replaces the gallery with one launch state as its own page, at the window's real size, for
 * resizing it, inspecting it, or a screenshot. `focus` names an element id to focus.
 */
export function showLaunchAlone(state: LaunchState, focus: string | null): void {
  document.title = `${state.name}: Clio launch page`;
  const style = document.createElement('style');
  style.textContent = styles;
  document.head.append(style);
  document.body.innerHTML = `<div id="app">${renderBoot(state.model)}</div>`;
  const root = document.getElementById('app');
  if (!root) return;
  bindBootView(root);
  state.after?.(root);
  if (focus) document.getElementById(focus)?.focus();
}

export function launchFrame(state: LaunchState, size: FrameSize): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'frame';
  figure.style.setProperty('--w', String(size.width));
  figure.style.setProperty('--h', String(size.height));

  const box = document.createElement('div');
  box.className = 'frame-box';
  const iframe = document.createElement('iframe');
  iframe.title = `${state.name}, ${size.width} by ${size.height}`;
  // Same origin, so the gallery can reach into the frame; no scripts, autofocus or form submits.
  iframe.sandbox.add('allow-same-origin');
  iframe.addEventListener('load', () => {
    const root = iframe.contentDocument?.getElementById('app');
    if (!root) return;
    // Binding may focus a field, which would scroll this page to the frame.
    const { scrollX, scrollY } = window;
    bindBootView(root);
    state.after?.(root);
    window.scrollTo(scrollX, scrollY);
  });
  iframe.srcdoc = page(state);
  box.append(iframe);

  const caption = document.createElement('figcaption');
  const name = document.createElement('a');
  name.textContent = state.name;
  name.href = `?launch=${stateSlug(state.name)}`;
  name.target = '_blank';
  name.title = 'Open this state alone, to resize or inspect it';
  const dims = document.createElement('span');
  dims.className = 'dims';
  dims.textContent = `${size.width} × ${size.height}`;
  caption.append(name, dims);

  figure.append(box, caption);
  return figure;
}

/** Keeps `--scale` on `column` so a QUEST_WINDOW frame fills its width (never above 1:1). */
export function fitFrames(column: HTMLElement): void {
  const fit = () => {
    const scale = Math.min(1, column.clientWidth / QUEST_WINDOW.width);
    column.style.setProperty('--scale', scale.toFixed(4));
    column.style.setProperty(
      '--phone-scale',
      Math.min(1, column.clientWidth / PHONE.width).toFixed(4),
    );
  };
  new ResizeObserver(fit).observe(column);
  fit();
}
