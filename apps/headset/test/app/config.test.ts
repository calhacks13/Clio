import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/app/config';

describe('readConfig', () => {
  it('defaults to a Gemini coach over the relay, learning, with automatic demos', () => {
    expect(readConfig('')).toEqual({
      coach: 'gemini',
      transport: 'relay',
      mode: 'learn',
      procedureId: null,
      goal: null,
      emulate: false,
      debug: false,
      camera: true,
      autoDemo: true,
      calibrate: false,
      table: 'auto',
      voice: null,
      showRefreshMs: 3000,
      live: true,
      trackerPort: null,
      frameWidth: null,
      liveHeld: true,
      widgets: true,
      widgetDemo: null,
      foveation: null,
    });
  });

  it('reads options from the URL', () => {
    const c = readConfig(
      '?coach=scripted&mode=record_demo&procedure=shirt-fold&goal=fold%20a%20shirt&debug=1&emulate=1&calibrate=1&camera=0&autoDemo=0&voice=Kore&transport=direct&showRefresh=5000&table=off&live=0&tracker=8791&frame=640&liveHeld=0&widgets=0&widgetDemo=timer,value&foveation=0.5',
    );
    expect(c).toEqual({
      coach: 'scripted',
      transport: 'direct',
      mode: 'record_demo',
      procedureId: 'shirt-fold',
      goal: 'fold a shirt',
      emulate: true,
      debug: true,
      camera: false,
      autoDemo: false,
      calibrate: true,
      table: 'off',
      voice: 'Kore',
      showRefreshMs: 5000,
      live: false,
      trackerPort: 8791,
      frameWidth: 640,
      liveHeld: false,
      widgets: false,
      widgetDemo: ['timer', 'value'],
      foveation: 0.5,
    });
  });

  it('falls back to defaults for invalid values instead of failing to boot', () => {
    const c = readConfig('?coach=telepathy&mode=sideways&debug=maybe&showRefresh=soon&table=on');
    expect([c.coach, c.mode, c.debug, c.showRefreshMs, c.table]).toEqual([
      'gemini',
      'learn',
      false,
      3000,
      'auto',
    ]);
    expect(readConfig('?showRefresh=-5').showRefreshMs).toBe(3000);
    expect(readConfig('?showRefresh=0').showRefreshMs).toBe(0);
    const tracker = readConfig('?tracker=localhost&frame=-1&live=maybe');
    expect([tracker.trackerPort, tracker.frameWidth, tracker.live]).toEqual([null, null, true]);
  });

  it('reads the widget options: on by default, demo kinds in order, foveation from 0 to 1', () => {
    expect(readConfig('?widgets=1').widgets).toBe(true);
    expect(readConfig('?widgets=maybe').widgets).toBe(true);
    expect(readConfig('?widgets=false').widgets).toBe(false);

    expect(readConfig('?widgetDemo=all').widgetDemo).toEqual([
      'timer',
      'progress',
      'checklist',
      'choices',
      'value',
      'caution',
    ]);
    expect(readConfig('?widgetDemo=caution,%20timer,banner,timer').widgetDemo).toEqual([
      'caution',
      'timer',
    ]);
    expect(readConfig('?widgetDemo=banner').widgetDemo).toBeNull();
    expect(readConfig('?widgetDemo=').widgetDemo).toBeNull();

    expect(readConfig('?foveation=0').foveation).toBe(0);
    expect(readConfig('?foveation=1').foveation).toBe(1);
    expect(readConfig('?foveation=0.25').foveation).toBe(0.25);
    for (const bad of ['-0.1', '1.5', 'full', '']) {
      expect(readConfig(`?foveation=${bad}`).foveation).toBeNull();
    }
  });
});
