import { describe, expect, it, vi } from 'vitest';
import { FrameGuard, frameGuard } from '../../src/adapters/render/frame-guard';
import type {
  depthUniforms,
  XrDepthOcclusion,
} from '../../src/adapters/render/glow/depth-occlusion';
import { ObjectHighlight } from '../../src/adapters/render/object-highlight';

/**
 * three's WebGLAnimation: the next frame is asked for only after the callback returns, so a
 * callback that throws is never called again.
 */
function animationLoop(callback: (time: number) => void) {
  let next: ((time: number) => void) | null = null;
  const onFrame = (time: number) => {
    callback(time);
    next = onFrame;
  };
  next = onFrame;
  return {
    /** Runs the pending frame; false when none was asked for. */
    step(time: number): boolean {
      const frame = next;
      next = null;
      if (!frame) return false;
      try {
        frame(time);
      } catch {
        // The browser reports it; the loop is over.
      }
      return true;
    },
  };
}

describe('FrameGuard', () => {
  it('shows the failure it prevents: one throw ends an unguarded loop for good', () => {
    let calls = 0;
    const raw = animationLoop((t) => {
      calls++;
      if (t === 2) throw new Error('too close');
    });
    for (let t = 1; t <= 4; t++) raw.step(t);
    expect(calls).toBe(2);
  });

  it('keeps the loop going, and still renders a frame whose update threw', () => {
    const report = vi.fn();
    const guard = new FrameGuard(report);
    const rendered: number[] = [];
    let ticks = 0;
    const loop = animationLoop(
      guard.loop(
        (t) => {
          ticks++;
          if (t === 2 || t === 3) throw new Error('too close');
        },
        () => rendered.push(ticks),
      ),
    );
    for (let t = 1; t <= 5; t++) expect(loop.step(t)).toBe(true);
    expect(ticks).toBe(5);
    expect(rendered).toEqual([1, 2, 3, 4, 5]);
    expect(guard.health.frames).toBe(5);
    expect(guard.health.errors).toBe(2);
    expect(guard.health.byStep).toEqual({ tick: 2 });
    expect(guard.health.lastError).toBe('tick: Error: too close');
    expect(guard.health.lastErrorFrame).toBe(3);
    // Logged once: the repeat is only counted.
    expect(report).toHaveBeenCalledOnce();
  });

  it('tries the next frame again after a render that threw', () => {
    const guard = new FrameGuard(() => {});
    let renders = 0;
    const loop = animationLoop(
      guard.loop(
        () => {},
        () => {
          renders++;
          if (renders === 1) throw new TypeError('bad matrix');
        },
      ),
    );
    loop.step(1);
    loop.step(2);
    expect(renders).toBe(2);
    expect(guard.health.byStep).toEqual({ render: 1 });
  });

  it('logs each distinct message once, and only so many of them', () => {
    const report = vi.fn();
    const guard = new FrameGuard(report);
    for (let i = 0; i < 20; i++) {
      expect(
        guard.run('tick', () => {
          throw new Error(`error ${i % 12}`);
        }),
      ).toBe(false);
    }
    expect(guard.run('tick', () => {})).toBe(true);
    expect(report).toHaveBeenCalledTimes(8);
    expect(guard.health.errors).toBe(20);
  });
});

describe("the glow's onBeforeRender", () => {
  it('draws without its depth map instead of ending the frame when the binder throws', () => {
    const highlight = new ObjectHighlight();
    const occlusion = {
      bind: () => {
        throw new Error('no depth');
      },
    } as unknown as XrDepthOcclusion;
    highlight.setOcclusion(occlusion);
    const glow = highlight.children[1] as unknown as {
      onBeforeRender: (...args: unknown[]) => void;
      material: { uniforms: ReturnType<typeof depthUniforms> };
    };
    const u = glow.material.uniforms;
    u.depthOn.value = 1;
    u.depthMap.value.sourceTexture = {} as WebGLTexture;
    const before = frameGuard.health.byStep.glow ?? 0;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => glow.onBeforeRender({}, {}, {})).not.toThrow();
    error.mockRestore();
    expect(u.depthOn.value).toBe(0);
    expect(u.depthMap.value.sourceTexture).toBeNull();
    expect(frameGuard.health.byStep.glow).toBe(before + 1);
  });
});
