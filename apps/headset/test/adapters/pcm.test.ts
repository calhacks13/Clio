import { describe, expect, it } from 'vitest';
import {
  base64ToInt16,
  floatToInt16,
  int16ToBase64,
  int16ToFloat32,
} from '../../src/adapters/audio/pcm';

describe('PCM16 conversion', () => {
  it('maps floats to 16-bit samples, clamping out-of-range input', () => {
    expect([...floatToInt16(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]))]).toEqual([
      0, 16384, -16384, 32767, -32768, 32767, -32768,
    ]);
  });

  it('round-trips through base64 (little-endian bytes)', () => {
    const pcm = new Int16Array([1, -1, 256, -32768, 32767]);
    const b64 = int16ToBase64(pcm);
    expect(b64).toBe('AQD//wABAID/fw==');
    expect([...base64ToInt16(b64)]).toEqual([...pcm]);
  });

  it('converts samples back to floats in [-1, 1]', () => {
    expect(
      [...int16ToFloat32(new Int16Array([0, 32767, -32768]))].map(
        (v) => Math.round(v * 1000) / 1000,
      ),
    ).toEqual([0, 1, -1]);
  });
});
