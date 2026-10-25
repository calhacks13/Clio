import { describe, expect, it } from 'vitest';
import { DESK_DEFAULTS, readDeskConfig } from '../../src/desk/config';

describe('readDeskConfig', () => {
  it('defaults to the Gemini voice over the relay, 640 px frames, the action focus on', () => {
    expect(readDeskConfig('')).toEqual(DESK_DEFAULTS);
    expect(DESK_DEFAULTS).toMatchObject({ coach: 'gemini', frameWidth: 640, focus: true });
  });

  it('reads every option', () => {
    expect(
      readDeskConfig(
        '?coach=scripted&transport=direct&goal=+water+the+basil+&procedure=ph-indicator&frame=480&tracker=8794&focus=0&mic=0&voice=Kore&showRefresh=0',
      ),
    ).toEqual({
      coach: 'scripted',
      transport: 'direct',
      goal: 'water the basil',
      procedureId: 'ph-indicator',
      frameWidth: 480,
      trackerPort: 8794,
      focus: false,
      muted: true,
      voice: 'Kore',
      showRefreshMs: 0,
    });
  });

  it('falls back to the default on a bad value', () => {
    expect(
      readDeskConfig('?coach=robot&frame=1000&tracker=-1&focus=maybe&mic=x&showRefresh=soon&goal='),
    ).toEqual(DESK_DEFAULTS);
  });
});
