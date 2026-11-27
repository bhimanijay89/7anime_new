import { applyProfileToHlsInstance, PROFILE_TUNINGS } from './hlsConfig.ts';
import type {
  BufferSnapshot,
  HlsInstanceLike,
  HlsProfileTuning,
  NetworkConnectionHint,
  NetworkProfile,
  NetworkSnapshot,
} from './types.ts';

const UPGRADE_COOLDOWN_MS = 10_000;
const DOWNGRADE_COOLDOWN_MS = 4_000;
const MIN_SAMPLES_FOR_UPGRADE = 3;

const SLOW_TO_NORMAL_BPS = 2_200_000;
const NORMAL_TO_SLOW_BPS = 1_250_000;
const NORMAL_TO_FAST_BPS = 7_500_000;
const FAST_TO_NORMAL_BPS = 5_000_000;

export interface AdaptiveEvaluationInput {
  network: NetworkSnapshot;
  buffer: BufferSnapshot;
  recentRebufferCount: number;
  connectionHint?: NetworkConnectionHint;
  nowMs: number;
}

export interface AdaptiveProfileChange {
  previous: NetworkProfile;
  next: NetworkProfile;
  tuning: HlsProfileTuning;
  reason: string;
}

/**
 * Hysteresis-guarded dynamic profile selector (SLOW, NORMAL, FAST, UNSTABLE).
 * Adjusts HLS.js runtime parameters in place without destroying or recreating Hls.
 */
export class AdaptiveNetworkController {
  private activeProfile: NetworkProfile;
  private lastTransitionAtMs = 0;

  constructor(initialProfile: NetworkProfile = 'normal', createdAtMs = 0) {
    this.activeProfile = initialProfile;
    this.lastTransitionAtMs = createdAtMs;
  }

  getProfile(): NetworkProfile {
    return this.activeProfile;
  }

  getTuning(): HlsProfileTuning {
    return PROFILE_TUNINGS[this.activeProfile];
  }

  reset(initialProfile: NetworkProfile = 'normal', nowMs = 0): void {
    this.activeProfile = initialProfile;
    this.lastTransitionAtMs = nowMs;
  }

  evaluate(
    input: AdaptiveEvaluationInput,
    hls?: Pick<HlsInstanceLike, 'config'> | null
  ): AdaptiveProfileChange | null {
    const { network, buffer, recentRebufferCount, connectionHint, nowMs } = input;
    const current = this.activeProfile;
    const elapsed = nowMs - this.lastTransitionAtMs;

    const candidate = this.computeCandidateProfile(
      current,
      network,
      buffer,
      recentRebufferCount,
      connectionHint
    );

    if (!candidate || candidate.next === current) {
      return null;
    }

    const isDowngradeOrUnstable =
      candidate.next === 'unstable' ||
      candidate.next === 'slow' ||
      (current === 'fast' && candidate.next === 'normal');

    const requiredCooldown = isDowngradeOrUnstable
      ? DOWNGRADE_COOLDOWN_MS
      : UPGRADE_COOLDOWN_MS;

    if (this.lastTransitionAtMs > 0 && elapsed < requiredCooldown) {
      return null;
    }

    this.activeProfile = candidate.next;
    this.lastTransitionAtMs = nowMs;

    const tuning = hls
      ? applyProfileToHlsInstance(hls, candidate.next)
      : PROFILE_TUNINGS[candidate.next];

    return {
      previous: current,
      next: candidate.next,
      tuning,
      reason: candidate.reason,
    };
  }

  private computeCandidateProfile(
    current: NetworkProfile,
    network: NetworkSnapshot,
    buffer: BufferSnapshot,
    recentRebufferCount: number,
    connectionHint?: NetworkConnectionHint
  ): { next: NetworkProfile; reason: string } | null {
    const bw = network.smoothedBandwidthBps;
    const hasEnoughSamples = network.sampleCount >= MIN_SAMPLES_FOR_UPGRADE;

    // Prioritize continuity when requests fail frequently or playback stutters repeatedly.
    if (
      network.recentFailureRate >= 0.25 ||
      recentRebufferCount >= 2 ||
      (network.unstableScore >= 0.65 && recentRebufferCount >= 1)
    ) {
      if (current !== 'unstable') {
        return {
          next: 'unstable',
          reason:
            network.recentFailureRate >= 0.25
              ? 'Elevated segment failure rate'
              : 'Repeated buffer stalls / throughput variance',
        };
      }
      return null;
    }

    if (current === 'unstable') {
      if (
        hasEnoughSamples &&
        network.recentFailureRate < 0.08 &&
        network.unstableScore < 0.4 &&
        recentRebufferCount === 0 &&
        buffer.bufferAheadSec >= 10
      ) {
        if (bw >= SLOW_TO_NORMAL_BPS) {
          return { next: 'normal', reason: 'Connection stabilized above 2.2 Mbps' };
        }
        return { next: 'slow', reason: 'Errors cleared; staying conservative for low bandwidth' };
      }
      return null;
    }

    if (current === 'fast') {
      if (bw > 0 && bw < NORMAL_TO_SLOW_BPS) {
        return { next: 'slow', reason: 'Bandwidth dropped sharply below 1.25 Mbps' };
      }
      if ((bw > 0 && bw < FAST_TO_NORMAL_BPS) || (buffer.bufferAheadSec > 0 && buffer.bufferAheadSec < 12 && !buffer.nearEnd)) {
        return { next: 'normal', reason: 'Throughput or buffer fell below fast threshold' };
      }
      return null;
    }

    if (current === 'normal') {
      if (
        (bw > 0 && bw < NORMAL_TO_SLOW_BPS) ||
        (recentRebufferCount >= 1 && bw > 0 && bw < SLOW_TO_NORMAL_BPS)
      ) {
        return { next: 'slow', reason: 'Sustained low throughput (<1.25 Mbps)' };
      }
      if (
        hasEnoughSamples &&
        bw >= NORMAL_TO_FAST_BPS &&
        network.recentFailureRate === 0 &&
        network.unstableScore < 0.35 &&
        buffer.bufferAheadSec >= 18 &&
        !connectionHint?.saveData
      ) {
        return { next: 'fast', reason: 'Sustained high throughput (>=7.5 Mbps) with healthy buffer' };
      }
      return null;
    }

    // Current === 'slow'
    if (
      hasEnoughSamples &&
      bw >= SLOW_TO_NORMAL_BPS &&
      network.recentFailureRate < 0.08 &&
      network.unstableScore < 0.45 &&
      buffer.bufferAheadSec >= 10 &&
      !connectionHint?.saveData
    ) {
      return { next: 'normal', reason: 'Throughput recovered above 2.2 Mbps' };
    }

    return null;
  }
}
