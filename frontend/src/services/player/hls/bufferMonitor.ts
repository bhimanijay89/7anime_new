import type { BufferSnapshot } from './types.ts';

export interface BufferedRangesLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

const DEFAULT_HOLE_TOLERANCE_SEC = 0.5;

/**
 * Computes forward and backward buffered distances across non-contiguous TimeRanges.
 */
export function inspectBufferedTimeRanges(
  buffered: BufferedRangesLike | null | undefined,
  currentTimeSec: number,
  durationSec: number,
  holeToleranceSec = DEFAULT_HOLE_TOLERANCE_SEC
): Omit<BufferSnapshot, 'isStalled' | 'targetBufferSec'> {
  const safeCurrent =
    Number.isFinite(currentTimeSec) && currentTimeSec >= 0 ? currentTimeSec : 0;
  const safeDuration =
    Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const nearEnd = safeDuration > 0 && safeDuration - safeCurrent <= 1.5;

  if (!buffered || buffered.length === 0) {
    return {
      bufferAheadSec: 0,
      bufferBehindSec: 0,
      currentTimeSec: safeCurrent,
      durationSec: safeDuration,
      rangesCount: 0,
      nearEnd,
    };
  }

  let bufferAheadSec = 0;
  let bufferBehindSec = 0;

  for (let i = 0; i < buffered.length; i += 1) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      continue;
    }

    if (safeCurrent >= start - holeToleranceSec && safeCurrent <= end) {
      bufferAheadSec = Math.max(0, end - safeCurrent);
      bufferBehindSec = Math.max(0, safeCurrent - start);

      // Stitch contiguous segments separated only by small muxer gaps <= holeToleranceSec.
      let stitchedEnd = end;
      for (let j = i + 1; j < buffered.length; j += 1) {
        const nextStart = buffered.start(j);
        const nextEnd = buffered.end(j);
        if (nextStart - stitchedEnd <= holeToleranceSec && nextEnd > stitchedEnd) {
          stitchedEnd = nextEnd;
          bufferAheadSec = Math.max(0, stitchedEnd - safeCurrent);
        } else {
          break;
        }
      }
      break;
    }
  }

  return {
    bufferAheadSec,
    bufferBehindSec,
    currentTimeSec: safeCurrent,
    durationSec: safeDuration,
    rangesCount: buffered.length,
    nearEnd,
  };
}

/**
 * Tracks video buffer cushion, stalls, and rebuffer timings safely across seeks and source switches.
 */
export class BufferMonitor {
  private targetBufferSec = 28;
  private hasEnteredPlayback = false;
  private waitingSinceMs: number | null = null;
  private rebufferCount = 0;
  private totalRebufferMs = 0;
  private sampleCount = 0;
  private bufferAheadSumSec = 0;
  private lastSnapshot: BufferSnapshot = {
    bufferAheadSec: 0,
    bufferBehindSec: 0,
    currentTimeSec: 0,
    durationSec: 0,
    rangesCount: 0,
    isStalled: false,
    nearEnd: false,
    targetBufferSec: 28,
  };
  private readonly rebufferTimestamps: number[] = [];

  setTargetBufferSec(targetSec: number): void {
    this.targetBufferSec = targetSec;
    this.lastSnapshot = { ...this.lastSnapshot, targetBufferSec: targetSec };
  }

  markPlaybackStarted(nowMs: number): void {
    this.hasEnteredPlayback = true;
    this.closeWaitWindow(nowMs);
  }

  markWaiting(
    buffered: BufferedRangesLike | null | undefined,
    currentTimeSec: number,
    durationSec: number,
    nowMs: number
  ): void {
    const info = inspectBufferedTimeRanges(buffered, currentTimeSec, durationSec);
    const stalled = this.hasEnteredPlayback && !info.nearEnd && info.bufferAheadSec < 0.75;
    if (stalled && this.waitingSinceMs === null) {
      this.waitingSinceMs = nowMs;
      this.rebufferCount += 1;
      this.rebufferTimestamps.push(nowMs);
      if (this.rebufferTimestamps.length > 10) {
        this.rebufferTimestamps.shift();
      }
    }
    this.lastSnapshot = {
      ...info,
      isStalled: stalled,
      targetBufferSec: this.targetBufferSec,
    };
  }

  markSeeked(): void {
    // Seeking naturally clears ahead buffer briefly; never count user seeks as stalls.
    this.waitingSinceMs = null;
  }

  sample(
    buffered: BufferedRangesLike | null | undefined,
    currentTimeSec: number,
    durationSec: number,
    paused: boolean,
    nowMs: number
  ): BufferSnapshot {
    const info = inspectBufferedTimeRanges(buffered, currentTimeSec, durationSec);
    if (info.bufferAheadSec >= 0.75) {
      this.closeWaitWindow(nowMs);
    }

    const isStalled =
      this.hasEnteredPlayback &&
      !paused &&
      !info.nearEnd &&
      (this.waitingSinceMs !== null || info.bufferAheadSec < 0.25);

    this.sampleCount += 1;
    this.bufferAheadSumSec += info.bufferAheadSec;

    this.lastSnapshot = {
      ...info,
      isStalled,
      targetBufferSec: this.targetBufferSec,
    };
    return this.lastSnapshot;
  }

  getRecentRebufferCount(nowMs: number, windowMs = 45_000): number {
    return this.rebufferTimestamps.filter((ts) => nowMs - ts <= windowMs).length;
  }

  getMetrics(nowMs: number): {
    averageBufferAheadSec: number;
    rebufferCount: number;
    totalRebufferMs: number;
    snapshot: BufferSnapshot;
  } {
    const activeWaitMs =
      this.waitingSinceMs !== null ? Math.max(0, nowMs - this.waitingSinceMs) : 0;
    return {
      averageBufferAheadSec:
        this.sampleCount > 0 ? this.bufferAheadSumSec / this.sampleCount : 0,
      rebufferCount: this.rebufferCount,
      totalRebufferMs: this.totalRebufferMs + activeWaitMs,
      snapshot: this.lastSnapshot,
    };
  }

  reset(targetBufferSec = 28): void {
    this.targetBufferSec = targetBufferSec;
    this.hasEnteredPlayback = false;
    this.waitingSinceMs = null;
    this.rebufferCount = 0;
    this.totalRebufferMs = 0;
    this.sampleCount = 0;
    this.bufferAheadSumSec = 0;
    this.rebufferTimestamps.length = 0;
    this.lastSnapshot = {
      bufferAheadSec: 0,
      bufferBehindSec: 0,
      currentTimeSec: 0,
      durationSec: 0,
      rangesCount: 0,
      isStalled: false,
      nearEnd: false,
      targetBufferSec,
    };
  }

  private closeWaitWindow(nowMs: number): void {
    if (this.waitingSinceMs !== null) {
      this.totalRebufferMs += Math.max(0, nowMs - this.waitingSinceMs);
      this.waitingSinceMs = null;
    }
  }
}
