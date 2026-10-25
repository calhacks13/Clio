import { describe, expect, it } from 'vitest';
import type { DeskObject, DeskTrackerStats } from '../../src/desk/desk-tracker';
import { ToolLog } from '../../src/desk/logs';
import {
  clockText,
  erHtml,
  esc,
  lessonHtml,
  statsHtml,
  toolsHtml,
  transcriptHtml,
} from '../../src/desk/panel';
import { ACCENTS } from '../../src/domain/overlay/accents';
import type { PlanView } from '../../src/domain/plan/recital';

// What the side panel shows, as HTML from plain data.

const plan: PlanView = {
  goal: 'water the basil',
  title: 'Water the basil',
  rev: 3,
  steps: [
    { id: 'fill', instruction: 'Fill the can.', status: 'done', uses: [], demo: false },
    {
      id: 'pour',
      instruction: 'Pour at the base.',
      doneWhen: 'The soil is dark.',
      status: 'todo',
      uses: [],
      demo: false,
    },
    { id: 'wipe', instruction: 'Wipe <the> spill.', status: 'todo', uses: [], demo: false },
  ],
  focusId: 'pour',
  materials: [],
};

const object = (id: string, lit: boolean): DeskObject => ({
  id,
  label: `${id} label`,
  phrase: id,
  query: id,
  lit,
  rank: lit ? 0 : null,
  style: null,
  accent: { color: ACCENTS.act, opacity: 1 },
  detection: null,
});

describe('lessonHtml', () => {
  it('without a lesson, says how to start one', () => {
    const html = lessonHtml({ plan: null, phase: 'idle', detail: null, objects: [], watch: null });
    expect(html).toContain('No lesson');
  });

  it('lists the steps with their status and the focus, and what the step lights', () => {
    const html = lessonHtml({
      plan,
      phase: 'lesson',
      detail: null,
      objects: [object('can', true), object('pot', false)],
      watch: { t: 0, stepId: 'pour', verdict: 'not_done', progress: 0.4, observation: 'dry' },
      next: 'can',
    });
    expect(html).toContain('(ER: next)');
    expect(html).toContain('class="step done"');
    expect(html).toContain('class="step todo focus"');
    expect(html).toContain('Done when: The soil is dark.');
    expect(html).toContain('Wipe &lt;the&gt; spill.');
    expect(html).toContain('can label');
    expect(html).not.toContain('pot label');
    expect(html).toContain('#24d4ed');
    expect(html).toContain('<b>not_done</b> 40%');
  });
});

describe('transcriptHtml', () => {
  it('names who spoke and dims a line still being transcribed', () => {
    const html = transcriptHtml([
      { t: 1000, role: 'user', text: 'hi', final: true, typed: true },
      { t: 2000, role: 'coach', text: 'Hello', final: false },
      { t: 3000, role: 'app', text: '[app] <Plan>', final: true },
    ]);
    expect(html).toContain('you (typed)');
    expect(html).toContain('line coach partial');
    expect(html).toContain('[app] &lt;Plan&gt;');
  });
});

describe('toolsHtml', () => {
  it('warns while the coach has never called highlight', () => {
    const log = new ToolLog();
    log.call(1, 'c1', 'start_lesson', { goal: 'basil' });
    expect(toolsHtml(log.entries, log.counts())).toContain('highlight 0');
    log.call(2, 'c2', 'highlight', { object_id: 'pot' });
    log.result(3, 'c2', true, { shown: true });
    const html = toolsHtml(log.entries, log.counts());
    expect(html).not.toContain('highlight 0');
    expect(html).toContain('call ok hot');
    expect(html).toContain('{&quot;shown&quot;:true}');
    expect(html).toContain('call pending');
  });
});

describe('erHtml', () => {
  it('says when the action focus is off, and lists its looks', () => {
    expect(erHtml([], false)).toContain('?focus=0');
    expect(erHtml([], true)).toContain('No looks yet');
    const html = erHtml(
      [
        {
          t: 0,
          stepId: 'pour',
          model: 'gemini-robotics-er-2-preview',
          latencyMs: 1234,
          frameAgeMs: 1500,
          action: { label: 'red button', id: null, declared: false, found: true },
          objects: [
            { id: 'can', label: 'can', found: true, confidence: 0.9, description: 'green can' },
          ],
        },
      ],
      true,
    );
    expect(html).toContain('next: <b>red button</b>');
    expect(html).toContain('not in the plan');
    expect(html).toContain('1234 ms');
    expect(html).toContain('frame 1500 ms old');
    const declared = erHtml(
      [
        {
          t: 0,
          stepId: null,
          model: 'er',
          latencyMs: 1,
          frameAgeMs: 1,
          action: { label: 'red button', id: 'red-button', declared: true, found: true },
          objects: [],
        },
      ],
      true,
    );
    expect(declared).toContain('declared now');
    expect(html).toContain('green can');
  });
});

describe('statsHtml', () => {
  const stats: DeskTrackerStats = {
    connected: true,
    model: 'yoloe-26l-seg',
    streaming: true,
    fps: 24.5,
    sendToAnswerMs: 41.2,
    encodeMs: 3.4,
    trackMs: 30,
    frame: { width: 640, height: 360 },
    followed: 3,
    lit: 1,
    found: 2,
    sources: { jev: 1, er: 1, none: 0 },
  };

  it('shows the connection, the stream and who placed what', () => {
    const html = statsHtml(stats, {
      t: 0,
      source: 'jev',
      found: ['can'],
      missing: ['pot'],
      latencyMs: 900,
    });
    expect(html).toContain('connected');
    expect(html).toContain('24.5 fps');
    expect(html).toContain('640×360');
    expect(html).toContain('jev 1 · er 1');
    expect(html).toContain('missing pot');
  });

  it('says how to start a tracker that is not there', () => {
    expect(statsHtml({ ...stats, connected: false, streaming: false }, null)).toContain(
      'pnpm tracker',
    );
    expect(statsHtml({ ...stats, connected: false }, null, false)).toContain('connects on Start');
  });
});

describe('helpers', () => {
  it('escapes HTML and writes page times as minutes and seconds', () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
    expect(clockText(127_400)).toBe('2:07.4');
    expect(clockText(3_000)).toBe('0:03.0');
  });
});
