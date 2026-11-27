import type { HlsFragmentStats, NetworkSnapshot } from './types.ts';

const RECENT_OUTCOMES_WINDOW = 16;
const RECENT_SAMPLES_WINDOW = 8;
const FAST_EWMA_ALPHA = 0.35;
const SLOW_EWMA_ALPHA = 0.14;
const MIN_VALID_DURATION_MS = 4;

/**
 * Estimates rolling smoothed segment throughput and instability from real HLS.js
 * fragment requests. Rejects invalid or zero-duration cache hits.
 */
export class NetworkMonitor {
  private readonly pendingStarts = new Map<string, number>();
  private readonly recentOutcomes: boolean[] = [];
  private readonly recentThroughputs: number[] = [];
  private ewmaFastBps = 0;
  private ewmaSlowBps = 0;
  private lastSampleBps = 0;
  private lastTtfbMs: number | null = null;
  private sampleCount = 0;

  recordFragLoading(fragKey: string, startedAtMs: number): void {
    this.pendingStarts.set(fragKey, startedAtMs);
  }

  recordFragLoaded(
    fragKey: string,
    payloadByteLength: number | undefined,
    stats: HlsFragmentStats | undefined,
    endedAtMs: number
  ): number | null {
    const trackedStart = this.pendingStarts.get(fragKey);
    this.pendingStarts.delete(fragKey);

    if (stats?.aborted) {
      return null;
    }

    const bytes =
      typeof stats?.loaded === 'number' && stats.loaded > 0
        ? stats.loaded
        : typeof payloadByteLength === 'number' && payloadByteLength > 0
          ? payloadByteLength
          : 0;

    if (bytes <= 0) {
      return null;
    }

    const statsStart = stats?.loading?.start;
    const statsEnd = stats?.loading?.end;
    const rawDurationMs =
      typeof statsStart === 'number' &&
      typeof statsEnd === 'number' &&
      statsEnd > statsStart
        ? statsEnd - statsStart
        : trackedStart !== undefined && endedAtMs > trackedStart
          ? endedAtMs - trackedStart
          : 0;

    if (!Number.isFinite(rawDurationMs) || rawDurationMs < MIN_VALID_DURATION_MS) {
      // Ignore near-zero duration cache hits so ABR is never skewed upward artificially.
      return null;
    }

    const bps = (bytes * 8 * 1000) / rawDurationMs;
    if (!Number.isFinite(bps) || bps <= 0) {
      return null;
    }

    if (
      typeof statsStart === 'number' &&
      typeof stats?.loading?.first === 'number' &&
      stats.loading.first >= statsStart
    ) {
      this.lastTtfbMs = stats.loading.first - statsStart;
    }

    this.pushOutcome(true);
    this.lastSampleBps = bps;
    this.sampleCount += 1;

    if (this.sampleCount === 1) {
      this.ewmaFastBps = bps;
      this.ewmaSlowBps = bps;
    } else {
      this.ewmaFastBps = FAST_EWMA_ALPHA * bps + (1 - FAST_EWMA_ALPHA) * this.ewmaFastBps;
      this.ewmaSlowBps = SLOW_EWMA_ALPHA * bps + (1 - SLOW_EWMA_ALPHA) * this.ewmaSlowBps;
    }

    this.recentThroughputs.push(bps);
    if (this.recentThroughputs.length > RECENT_SAMPLES_WINDOW) {
      this.recentThroughputs.shift();
    }

    return bps;
  }

  recordFragError(fragKey?: string): void {
    if (fragKey) {
      this.pendingStarts.delete(fragKey);
    }
    this.pushOutcome(false);
  }

  reset(): void {
    this.pendingStarts.clear();
    this.recentOutcomes.length = 0;
    this.recentThroughputs.length = 0;
    this.ewmaFastBps = 0;
    this.ewmaSlowBps = 0;
    this.lastSampleBps = 0;
    this.lastTtfbMs = null;
    this.sampleCount = 0;
  }

  getSnapshot(): NetworkSnapshot {
    const failureCount = this.recentOutcomes.filter((ok) => !ok).length;
    const recentFailureRate =
      this.recentOutcomes.length > 0 ? failureCount / this.recentOutcomes.length : 0;

    // React conservatively to sharp bandwidth drops while blending steady throughput smoothly.
    const smoothedBandwidthBps =
      this.sampleCount === 0
        ? 0
        : this.ewmaFastBps < this.ewmaSlowBps * 0.85
          ? this.ewmaFastBps
          : this.ewmaFastBps * 0.6 + this.ewmaSlowBps * 0.4;

    return {
      smoothedBandwidthBps,
      ewmaFastBps: this.ewmaFastBps,
      ewmaSlowBps: this.ewmaSlowBps,
      lastSampleBps: this.lastSampleBps,
      lastTtfbMs: this.lastTtfbMs,
      sampleCount: this.sampleCount,
      recentFailureRate,
      unstableScore: this.computeUnstableScore(recentFailureRate),
    };
  }

  private pushOutcome(success: boolean): void {
    this.recentOutcomes.push(success);
    if (this.recentOutcomes.length > RECENT_OUTCOMES_WINDOW) {
      this.recentOutcomes.shift();
    }
  }

  private computeUnstableScore(recentFailureRate: number): number {
    let varianceFactor = 0;
    if (this.recentThroughputs.length >= 4) {
      const mean =
        this.recentThroughputs.reduce((acc, v) => acc + v, 0) /
        this.recentThroughputs.length;
      if (mean > 0) {
        const variance =
          this.recentThroughputs.reduce((acc, v) => acc + (v - mean) ** 2, 0) /
          this.recentThroughputs.length;
        const cv = Math.sqrt(variance) / mean;
        varianceFactor = Math.min(1, Math.max(0, (cv - 0.35) / 0.85));
      }
    }
    const score = Math.min(1, recentFailureRate * 2.2 + varianceFactor * 0.6);
    return Number(score.toFixed(3));
  }
}
