import type { HealthResponse, ProcedureSummary } from '@clio/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  type BootModel,
  bindBootView,
  bootButtonLabel,
  readBootChoice,
  renderBoot,
  setBootProgress,
} from '../../src/app/boot-view';

// The launch page: silent when everything works, a problem and its fix only when something is
// wrong, one button that names what it starts and then narrates starting in place.

const health = (configured: boolean): HealthResponse => ({
  ok: true,
  version: '0.1.0',
  coach: { configured, liveModel: 'gemini-live', relayPath: '/gemini' },
});

const procedures: ProcedureSummary[] = [
  {
    id: 'shirt-fold',
    version: 1,
    title: 'Fold a <shirt>',
    summary: '',
    stepCount: 4,
    source: 'curated',
  },
  {
    id: 'plan-1',
    version: 1,
    title: 'Washer fluid',
    summary: '',
    stepCount: 5,
    source: 'generated',
  },
];

const ready: BootModel = { health: health(true), procedures, ar: true, goal: '' };

/** The page's controls, as boot-view finds them, with the state the markup gives them. */
function page(html: string) {
  const attr = (re: RegExp) => re.exec(html)?.[1] ?? '';
  const has = (re: RegExp) => re.test(html);
  const listeners = new Map<string, ((e: { preventDefault(): void }) => void)[]>();
  const element = (init: Record<string, unknown> = {}) => {
    const attrs = new Map<string, string>();
    return {
      dataset: {} as Record<string, string>,
      textContent: '',
      value: '',
      checked: false,
      disabled: false,
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      getAttribute: (name: string) => attrs.get(name) ?? null,
      removeAttribute: (name: string) => attrs.delete(name),
      querySelector: (_: string): unknown => null,
      addEventListener: (type: string, fn: (e: { preventDefault(): void }) => void) =>
        listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      ...init,
    };
  };
  const label = element({ textContent: attr(/<span class="label">([^<]*)<\/span>/) });
  const nodes: Record<string, ReturnType<typeof element>> = {
    '.boot': element({
      dataset: {
        start: attr(/data-start="(\w+)"/),
        progress: attr(/data-progress="(\w+)"/),
      },
    }),
    '#boot-form': element(),
    '#enter': element({
      disabled: has(/<button id="enter"[^>]*\sdisabled/),
      querySelector: (s: string) => (s === '.label' ? label : null),
    }),
    '#goal': element({
      value: attr(/id="goal"[^>]*\svalue="([^"]*)"/),
      disabled: has(/<input id="goal"[^>]*\sdisabled/),
    }),
    '#procedure': element({ value: attr(/<option value="([^"]*)" selected>/) }),
    '#calibrate': element({ checked: has(/id="calibrate"[^>]*\schecked/) }),
    '#record': element({ checked: has(/id="record"[^>]*\schecked/) }),
    '#boot-error': element(),
    '#status': element(),
  };
  const root = { querySelector: (s: string) => nodes[s] ?? null } as unknown as ParentNode;
  const fire = (type: string) => {
    const event = { preventDefault: vi.fn() };
    for (const fn of listeners.get(type) ?? []) fn(event);
    return event;
  };
  const n = (s: string) => nodes[s] as ReturnType<typeof element>;
  return {
    root,
    fire,
    main: n('.boot'),
    button: n('#enter'),
    label,
    goal: n('#goal'),
    procedure: n('#procedure'),
    record: n('#record'),
    error: n('#boot-error'),
    status: n('#status'),
  };
}

describe('renderBoot', () => {
  it('asks one question with one button and says nothing else when everything works', () => {
    const html = renderBoot(ready);
    expect(html).toContain('<h1><label for="goal">What do you want to learn?</label></h1>');
    expect(html).toContain('<span class="label">Start lesson</span>');
    expect(html).not.toMatch(/<button id="enter"[^>]*\sdisabled/);
    expect(html).not.toContain('class="problems"');
    expect(html).toContain('Every lesson trains two students: you, and a robot.');
    expect(html).toContain('Or leave it empty and tell Clio once you’re in.');
    expect(html).toContain('<details class="more">');
    expect(html).toContain('role="status" aria-live="polite"');
    // Peter's rules: no bullets, middle dots or arrows anywhere in the copy.
    expect(html).not.toMatch(/[·•→←↑↓➜⟶✓✗]/);
  });

  it('names an unreachable server and the fix, and still lets the learner start', () => {
    const html = renderBoot({ ...ready, health: null, procedures: [] });
    expect(html).toContain('<li class="problem bad"><p class="problem-title">Can’t reach the');
    expect(html).toContain('Run <code>pnpm dev</code> on the laptop');
    expect(html).not.toContain('Gemini');
    expect(html).not.toMatch(/<button id="enter"[^>]*\sdisabled/);
    // Without a listening coach an empty goal goes nowhere, so the hint is not offered.
    expect(html).not.toContain('leave it empty');
    expect(html).not.toContain('id="procedure"');
  });

  it('warns that without a Gemini key the offline coach can neither see nor listen', () => {
    const html = renderBoot({ ...ready, health: health(false) });
    expect(html).toContain('<li class="problem warn">');
    expect(html).toContain('No Gemini key: Clio uses the offline coach.');
    expect(html).toContain('It can’t see or listen. Set <code>GEMINI_API_KEY</code>');
    expect(html).not.toContain('leave it empty');
  });

  it('disables the button only when immersive AR is missing, and says where to open it', () => {
    const html = renderBoot({ ...ready, ar: false });
    expect(html).toContain('This browser can’t enter AR.');
    expect(html).toContain('add <code>?emulate=1</code> on a laptop');
    expect(html).toMatch(/<button id="enter"[^>]*\sdisabled/);
  });

  it('lists saved lessons by source and escapes what the server sent', () => {
    const html = renderBoot({ ...ready, goal: 'pour "acid" <safely>' });
    expect(html).toContain('value="pour &#34;acid&#34; &#60;safely&#62;"');
    expect(html).toContain(
      '<optgroup label="Curated"><option value="shirt-fold">Fold a &#60;shirt&#62;</option></optgroup>',
    );
    expect(html).toContain('<optgroup label="Planned by Clio"><option value="plan-1">');
    expect(html).toContain('<option value="">None</option>');
  });

  it('prefills a saved lesson, which opens the options and sets the goal aside', () => {
    const html = renderBoot({ ...ready, goal: 'ignored', procedureId: 'plan-1' });
    expect(html).toContain('<option value="plan-1" selected>');
    expect(html).toContain('<details class="more" open>');
    expect(html).toMatch(/<input id="goal"[^>]*\sdisabled/);
    expect(html).toContain('data-start="saved"');
    expect(html).toContain('<span class="label">Start saved lesson</span>');
    // A ?procedure= the server does not have is ignored.
    const unknown = renderBoot({ ...ready, procedureId: 'gone' });
    expect(unknown).not.toContain(' selected');
    expect(unknown).toContain('<details class="more">');
    expect(unknown).toContain('<span class="label">Start lesson</span>');
  });

  it('prefills calibration and recording', () => {
    const html = renderBoot({ ...ready, calibrate: true, record: true });
    expect(html).toMatch(/id="calibrate" type="checkbox" role="switch" checked/);
    expect(html).toMatch(/id="record" type="checkbox" role="switch" checked/);
    expect(html).toContain('<details class="more" open>');
    expect(html).toContain('<span class="label">Start recording</span>');
  });
});

describe('bootButtonLabel', () => {
  it('names what the button starts, then how far starting has got', () => {
    expect(bootButtonLabel('lesson', { kind: 'idle' })).toBe('Start lesson');
    expect(bootButtonLabel('saved', { kind: 'idle' })).toBe('Start saved lesson');
    expect(bootButtonLabel('record', { kind: 'idle' })).toBe('Start recording');
    expect(bootButtonLabel('lesson', { kind: 'permissions' })).toBe('Allow microphone and camera');
    expect(bootButtonLabel('lesson', { kind: 'permissions', message: 'Allow the camera' })).toBe(
      'Allow the camera',
    );
    expect(bootButtonLabel('saved', { kind: 'entering' })).toBe('Entering AR');
    expect(bootButtonLabel('lesson', { kind: 'inside' })).toBe('In AR');
    expect(bootButtonLabel('record', { kind: 'error', message: 'denied' })).toBe('Try again');
  });
});

describe('setBootProgress', () => {
  it('narrates permissions and entering in the button and keeps it focusable', () => {
    const p = page(renderBoot(ready));
    setBootProgress(p.root, { kind: 'permissions' });
    expect(p.main.dataset.progress).toBe('permissions');
    expect(p.label.textContent).toBe('Allow microphone and camera');
    expect(p.button.getAttribute('aria-disabled')).toBe('true');
    expect(p.button.disabled).toBe(false);
    expect(p.status.textContent).toBe('Allow microphone and camera');
    setBootProgress(p.root, { kind: 'entering' });
    expect(p.label.textContent).toBe('Entering AR');
    expect(p.status.textContent).toBe('Entering AR');
  });

  it('shows an error with a retry, then clears it', () => {
    const p = page(renderBoot(ready));
    setBootProgress(p.root, { kind: 'entering' });
    setBootProgress(p.root, { kind: 'error', message: 'Permission denied' });
    expect(p.label.textContent).toBe('Try again');
    expect(p.button.getAttribute('aria-disabled')).toBeNull();
    expect(p.error.textContent).toBe('Could not start. Permission denied.');
    expect(p.status.textContent).toBe('Could not start. Permission denied. Try again.');
    setBootProgress(p.root, { kind: 'idle' });
    expect(p.label.textContent).toBe('Start lesson');
    expect(p.error.textContent).toBe('');
    expect(p.status.textContent).toBe('');
  });
});

describe('bindBootView', () => {
  it('relabels the button from the options and sets the goal aside for a saved lesson', () => {
    const p = page(renderBoot({ ...ready, goal: 'fold a shirt' }));
    bindBootView(p.root);
    expect(p.label.textContent).toBe('Start lesson');
    p.procedure.value = 'shirt-fold';
    p.fire('change');
    expect(p.main.dataset.start).toBe('saved');
    expect(p.goal.disabled).toBe(true);
    expect(p.label.textContent).toBe('Start saved lesson');
    p.record.checked = true;
    p.fire('change');
    expect(p.label.textContent).toBe('Start recording');
    expect(p.goal.disabled).toBe(true);
    p.record.checked = false;
    p.procedure.value = '';
    p.fire('change');
    expect(p.goal.disabled).toBe(false);
    expect(p.label.textContent).toBe('Start lesson');
  });

  it('leaves a narrating label alone', () => {
    const p = page(renderBoot(ready));
    bindBootView(p.root);
    setBootProgress(p.root, { kind: 'entering' });
    p.procedure.value = 'plan-1';
    p.fire('change');
    expect(p.label.textContent).toBe('Entering AR');
    setBootProgress(p.root, { kind: 'idle' });
    expect(p.label.textContent).toBe('Start saved lesson');
  });

  it('starts with the choice as it stands, not while starting or without AR', () => {
    const p = page(renderBoot({ ...ready, goal: '  fold a shirt ', calibrate: true }));
    const onStart = vi.fn();
    bindBootView(p.root, onStart);
    expect(p.fire('submit').preventDefault).toHaveBeenCalled();
    expect(onStart).toHaveBeenLastCalledWith({
      goal: 'fold a shirt',
      procedureId: null,
      calibrate: true,
      record: false,
    });
    setBootProgress(p.root, { kind: 'permissions' });
    p.fire('submit');
    expect(onStart).toHaveBeenCalledTimes(1);
    setBootProgress(p.root, { kind: 'error', message: 'no session' });
    p.goal.value = '';
    p.fire('submit');
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(readBootChoice(p.root).goal).toBeNull();

    const noAr = page(renderBoot({ ...ready, ar: false }));
    const never = vi.fn();
    bindBootView(noAr.root, never);
    noAr.fire('submit');
    expect(never).not.toHaveBeenCalled();
  });
});
