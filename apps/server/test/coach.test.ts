import { ApiErrorSchema, ApiPaths, CoachTokenResponseSchema } from '@clio/protocol';
import type { AuthToken, CreateAuthTokenParameters } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { createGeminiTokenMinter, type TokenMinter } from '../src/services/token-minter';
import { harness } from './harness';

function recordingMinter(): TokenMinter & { models: string[] } {
  const models: string[] = [];
  return {
    models,
    async mint(model) {
      models.push(model);
      return { token: 'auth_tokens/fake', expiresAt: '2026-10-24T03:45:02.123Z' };
    },
  };
}

describe('POST /api/coach/token', () => {
  it('answers 503 when no Gemini key is configured', async () => {
    const h = await harness();
    const res = await h.request('POST', ApiPaths.coachToken, {});
    expect(res.status).toBe(503);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('gemini_not_configured');
  });

  it('mints a token for the configured live model', async () => {
    const minter = recordingMinter();
    const h = await harness({ tokenMinter: minter });
    const res = await h.request('POST', ApiPaths.coachToken, {});
    expect(res.status).toBe(200);
    expect(CoachTokenResponseSchema.parse(await res.json())).toEqual({
      token: 'auth_tokens/fake',
      expiresAt: '2026-10-24T03:45:02.123Z',
      model: 'live-test',
    });
    expect(minter.models).toEqual(['live-test']);
  });

  it('accepts an empty body and a model override', async () => {
    const minter = recordingMinter();
    const h = await harness({ tokenMinter: minter });
    expect((await h.request('POST', ApiPaths.coachToken)).status).toBe(200);
    const res = await h.request('POST', ApiPaths.coachToken, { model: 'other-live' });
    expect(CoachTokenResponseSchema.parse(await res.json()).model).toBe('other-live');
    expect(minter.models).toEqual(['live-test', 'other-live']);
  });

  it('rejects an invalid body', async () => {
    const h = await harness({ tokenMinter: recordingMinter() });
    expect((await h.request('POST', ApiPaths.coachToken, { model: 5 })).status).toBe(400);
  });

  it('answers 502 when Gemini refuses', async () => {
    const h = await harness({
      tokenMinter: {
        mint: async () => {
          throw new Error('quota exceeded');
        },
      },
    });
    const res = await h.request('POST', ApiPaths.coachToken, {});
    expect(res.status).toBe(502);
    expect(ApiErrorSchema.parse(await res.json()).error).toEqual({
      code: 'upstream_failed',
      message: 'Could not mint a Gemini Live token: quota exceeded',
    });
  });
});

describe('createGeminiTokenMinter', () => {
  it('asks for a single-use token valid for 30 minutes, with 60 s to open a session', async () => {
    const calls: CreateAuthTokenParameters[] = [];
    const ai = {
      authTokens: {
        create: async (params: CreateAuthTokenParameters): Promise<AuthToken> => {
          calls.push(params);
          return { name: 'auth_tokens/abc123' };
        },
      },
    };
    const minter = createGeminiTokenMinter(ai, () => new Date('2026-10-24T03:15:00.000Z'));
    expect(await minter.mint('gemini-3.8-live')).toEqual({
      token: 'auth_tokens/abc123',
      expiresAt: '2026-10-24T03:45:00.000Z',
    });
    expect(calls).toEqual([
      {
        config: {
          uses: 1,
          expireTime: '2026-10-24T03:45:00.000Z',
          newSessionExpireTime: '2026-10-24T03:16:00.000Z',
        },
      },
    ]);
  });

  it('fails loudly when Gemini returns no token', async () => {
    const ai = { authTokens: { create: async (): Promise<AuthToken> => ({}) } };
    await expect(createGeminiTokenMinter(ai).mint('m')).rejects.toThrow(/no token/);
  });
});
