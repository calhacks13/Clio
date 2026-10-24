import type { HealthResponse, ProcedureSummary } from '@clio/protocol';

// The launch page's markup, a pure function of what boot() learned, so the UI gallery
// (gallery.html) can show every state without a server or a headset.

export interface BootModel {
  /** Null when the server is unreachable. */
  health: HealthResponse | null;
  procedures: ProcedureSummary[];
  /** Whether immersive-ar is available. */
  ar: boolean;
  /** Prefilled from ?goal=. */
  goal: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderBoot({ health, procedures, ar, goal }: BootModel): string {
  const check = (ok: boolean, label: string) =>
    `<li class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${label}</li>`;
  const options = procedures
    .map(
      (p) =>
        `<option value="${esc(p.id)}">${esc(p.title)}${p.source === 'generated' ? ' (AI-planned)' : ''}</option>`,
    )
    .join('');
  return `
    <main class="boot">
      <h1>Clio</h1>
      <p class="tag">Every lesson trains two students: you, and a robot.</p>
      <ul class="checks">
        ${check(!!health, health ? `server ${esc(health.version)}` : 'server unreachable (run pnpm dev)')}
        ${check(!!health?.coach.configured, health?.coach.configured ? `voice coach ${esc(health.coach.liveModel)}` : 'no Gemini key: offline coach')}
        ${check(ar, ar ? 'passthrough AR available' : 'no immersive-ar (use a Quest, or ?emulate=1)')}
      </ul>
      <label class="field">What do you want to learn?
        <input id="goal" type="text" placeholder="e.g. refill windshield washer fluid" value="${esc(goal)}">
        <small>Leave empty to just talk to Clio once you're in.</small>
      </label>
      <label class="field">…or run a saved lesson
        <select id="procedure"><option value="">(none)</option>${options}</select>
      </label>
      <label class="check"><input id="calibrate" type="checkbox"> Calibrate the table first (pinch two corners)</label>
      <label class="check"><input id="record" type="checkbox"> Record expert demonstrations</label>
      <button id="enter" ${ar ? '' : 'disabled'}>Enter AR</button>
      <p id="status" class="status"></p>
    </main>
    <div id="xr"></div>`;
}
