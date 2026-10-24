import { Group, Quaternion } from 'three';
import { recentLogs } from '../../../core/log';
import { rotateVec } from '../../../core/math';
import type { PresentContext, Presenter } from '../presenter';
import { makeText, setText } from '../text';

/** Debug status line pinned below the line of sight: coach, recorder, frame rate, last warning. */
export class HudPresenter implements Presenter {
  readonly object = new Group();
  private readonly text = makeText({
    size: 0.012,
    color: 0x9fe8ff,
    maxWidth: 0.5,
    anchorX: 'center',
  });
  private fps = 0;

  constructor() {
    this.object.add(this.text);
  }

  update(ctx: PresentContext): void {
    this.object.visible = ctx.debug;
    if (!ctx.debug) return;
    this.fps = this.fps * 0.95 + (ctx.dt > 0 ? 1000 / ctx.dt : 0) * 0.05;
    const s = ctx.snapshot;
    const rec = s.recording
      ? `rec ${s.recording.episodeId ?? '…'} (${s.recording.queued} queued)`
      : 'not recording';
    const warn = [...recentLogs()].reverse().find((l) => l.level === 'warn' || l.level === 'error');
    setText(
      this.text,
      `${Math.round(this.fps)} fps · ${s.phase} · coach ${s.coach} · ${rec}${warn ? `\n${warn.ns}: ${warn.message}` : ''}`,
    );
    const offset = rotateVec(ctx.head.q, [0, -0.28, -0.55]);
    this.object.position.set(
      ctx.head.p[0] + offset[0],
      ctx.head.p[1] + offset[1],
      ctx.head.p[2] + offset[2],
    );
    this.object.quaternion.copy(new Quaternion(...ctx.head.q));
  }
}
