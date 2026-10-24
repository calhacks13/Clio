import { describe, expect, it } from 'vitest';
import { ApiClient, isAccessDenied } from '../../src/adapters/net/api-client';

const replying = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

async function failure(f: typeof fetch): Promise<unknown> {
  try {
    await new ApiClient('http://server', f).procedures();
  } catch (err) {
    return err;
  }
  throw new Error('expected a failure');
}

describe('isAccessDenied', () => {
  it('spots the 401 a server with an access key gives a page opened without ?key=', async () => {
    const err = await failure(
      replying(401, { error: { code: 'unauthorized', message: 'open the link with ?key=' } }),
    );
    expect(isAccessDenied(err)).toBe(true);
  });

  it('is false for other failures', async () => {
    expect(isAccessDenied(await failure(replying(404, {})))).toBe(false);
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    expect(isAccessDenied(await failure(offline))).toBe(false);
    expect(isAccessDenied(new Error('401'))).toBe(false);
  });
});
