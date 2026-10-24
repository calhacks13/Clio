import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/emitter';

type Events = { ping: { n: number }; pong: { s: string } };

describe('Emitter', () => {
  it('delivers payloads to subscribers in subscription order', () => {
    const e = new Emitter<Events>();
    const seen: string[] = [];
    e.on('ping', ({ n }) => seen.push(`a${n}`));
    e.on('ping', ({ n }) => seen.push(`b${n}`));
    e.emit('ping', { n: 1 });
    expect(seen).toEqual(['a1', 'b1']);
  });

  it('stops delivering after unsubscribe', () => {
    const e = new Emitter<Events>();
    let count = 0;
    const off = e.on('ping', () => count++);
    e.emit('ping', { n: 1 });
    off();
    e.emit('ping', { n: 2 });
    expect(count).toBe(1);
  });

  it('keeps delivering when one handler throws, and reports the error', () => {
    const errors: string[] = [];
    const e = new Emitter<Events>((err, type) =>
      errors.push(`${String(type)}:${(err as Error).message}`),
    );
    let delivered = false;
    e.on('ping', () => {
      throw new Error('boom');
    });
    e.on('ping', () => {
      delivered = true;
    });
    e.emit('ping', { n: 1 });
    expect(delivered).toBe(true);
    expect(errors).toEqual(['ping:boom']);
  });

  it('lets a wildcard subscriber see every event type', () => {
    const e = new Emitter<Events>();
    const seen: string[] = [];
    e.onAny((type) => seen.push(String(type)));
    e.emit('ping', { n: 1 });
    e.emit('pong', { s: 'x' });
    expect(seen).toEqual(['ping', 'pong']);
  });

  it('shows wildcard observers an event before any handler reacts to it', () => {
    const e = new Emitter<Events>();
    const observed: string[] = [];
    e.onAny((type) => observed.push(String(type)));
    e.on('ping', () => e.emit('pong', { s: 'reaction' }));
    e.emit('ping', { n: 1 });
    expect(observed).toEqual(['ping', 'pong']);
  });
});
