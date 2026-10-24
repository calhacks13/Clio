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
      voice: null,
    });
  });

  it('reads options from the URL', () => {
    const c = readConfig(
      '?coach=scripted&mode=record_demo&procedure=shirt-fold&goal=fold%20a%20shirt&debug=1&emulate=1&calibrate=1&camera=0&autoDemo=0&voice=Kore&transport=direct',
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
      voice: 'Kore',
    });
  });

  it('falls back to defaults for invalid values instead of failing to boot', () => {
    const c = readConfig('?coach=telepathy&mode=sideways&debug=maybe');
    expect([c.coach, c.mode, c.debug]).toEqual(['gemini', 'learn', false]);
  });
});
