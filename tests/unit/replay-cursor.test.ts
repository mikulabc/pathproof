import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import {
  moveReplayPointer,
  pointerInterpolationFrameCount,
  replayPointerPosition,
  replayCursorScriptSource,
} from '../../server/replay-cursor';

describe('replay pointer interpolation', () => {
  it('targets approximately 60 updates per second and caps pathological segments', () => {
    expect(pointerInterpolationFrameCount(0)).toBe(1);
    expect(pointerInterpolationFrameCount(100)).toBe(6);
    expect(pointerInterpolationFrameCount(750)).toBe(45);
    expect(pointerInterpolationFrameCount(60_000)).toBe(45);
    expect(pointerInterpolationFrameCount(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('retains the actual last pointer coordinate for the next segment', async () => {
    const mouseMove = vi.fn(async () => undefined);
    const page = {
      viewportSize: () => ({ width: 1200, height: 800 }),
      mouse: { move: mouseMove },
      waitForTimeout: vi.fn(async () => undefined),
    } as unknown as Page;

    expect(replayPointerPosition(page)).toEqual({ x: 600, y: 400 });
    await moveReplayPointer(page, { x: 80, y: 120 }, 0);
    expect(mouseMove).toHaveBeenLastCalledWith(80, 120);
    expect(replayPointerPosition(page)).toEqual({ x: 80, y: 120 });

    await moveReplayPointer(page, { x: 100, y: 140 }, 0);
    expect(mouseMove).toHaveBeenLastCalledWith(100, 140);
    expect(replayPointerPosition(page)).toEqual({ x: 100, y: 140 });
  });

  it('provides the helper required by tsx-serialized init functions', () => {
    const source = replayCursorScriptSource();
    expect(source).toContain('const __name = (target) => target');
    expect(() => new Function(source)).not.toThrow();
  });
});
