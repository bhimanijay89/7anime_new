import type {
  HlsConstructorLike,
  HlsErrorPayload,
  RecoveryAction,
  RecoveryClassification,
} from './types.ts';

const MAX_RE_RESOLVES = 2;
const RE_RESOLVE_WINDOW_MS = 60_000;
const RE_RESOLVE_COOLDOWN_MS = 2_000;

const MAX_NETWORK_RECOVERIES = 3;
const NETWORK_COOLDOWN_MS = 600;
const NETWORK_BASE_DELAY_MS = 800;

const MAX_MEDIA_RECOVERIES = 2;
const MEDIA_COOLDOWN_MS = 1_000;

const HEALTHY_PLAYBACK_RESET_MS = 25_000;

const EXPIRED_HTTP_CODES = new Set([401, 403, 410]);

/**
 * Bounded HLS.js fatal error classifier and recovery state machine.
 * Prevents infinite retry storms while cleanly handling transient network drops,
 * media codec hiccups, and expired proxy/signed stream URLs.
 */
export class ErrorRecoveryManager {
  private networkAttempts = 0;
  private mediaAttempts = 0;
  private lastRecoveryAtMs = 0;
  private lastErrorAtMs = 0;
  private readonly reResolveTimestamps: number[] = [];

  classify(
    data: HlsErrorPayload,
    errorTypes: HlsConstructorLike['ErrorTypes']
  ): RecoveryClassification {
    const statusCode = data.response?.code;
    if (typeof statusCode === 'number' && EXPIRED_HTTP_CODES.has(statusCode)) {
      return 'expired_url';
    }

    if (data.details === 'manifestIncompatibleCodecsError') {
      return 'fatal_unrecoverable';
    }

    if (data.type === errorTypes.KEY_SYSTEM_ERROR) {
      return 'fatal_unrecoverable';
    }

    if (data.type === errorTypes.NETWORK_ERROR) {
      return 'network_transient';
    }

    if (data.type === errorTypes.MEDIA_ERROR) {
      return 'media_decode';
    }

    return 'fatal_unrecoverable';
  }

  /**
   * Resets transient retry budgets once playback remains healthy long enough.
   */
  markHealthyPlayback(nowMs: number): void {
    if (this.lastErrorAtMs > 0 && nowMs - this.lastErrorAtMs >= HEALTHY_PLAYBACK_RESET_MS) {
      this.networkAttempts = 0;
      this.mediaAttempts = 0;
    }
  }

  decide(
    data: HlsErrorPayload,
    errorTypes: HlsConstructorLike['ErrorTypes'],
    nowMs: number
  ): RecoveryAction {
    this.lastErrorAtMs = nowMs;
    const classification = this.classify(data, errorTypes);

    if (classification === 'expired_url') {
      this.pruneReResolveHistory(nowMs);
      const lastReResolve =
        this.reResolveTimestamps[this.reResolveTimestamps.length - 1] ?? 0;
      if (this.reResolveTimestamps.length >= MAX_RE_RESOLVES) {
        return {
          action: 'fail',
          delayMs: 0,
          reason: `Stream authorization expired (${data.response?.code ?? 'auth'}) and re-resolve budget exhausted.`,
          classification,
          attempt: this.reResolveTimestamps.length,
          maxAttempts: MAX_RE_RESOLVES,
        };
      }
      const waitMs =
        lastReResolve > 0 ? Math.max(0, RE_RESOLVE_COOLDOWN_MS - (nowMs - lastReResolve)) : 0;
      this.reResolveTimestamps.push(nowMs);
      return {
        action: 're_resolve',
        delayMs: waitMs,
        reason: `Upstream URL returned HTTP ${data.response?.code}; refreshing stream session.`,
        classification,
        attempt: this.reResolveTimestamps.length,
        maxAttempts: MAX_RE_RESOLVES,
      };
    }

    if (classification === 'network_transient') {
      if (this.networkAttempts >= MAX_NETWORK_RECOVERIES) {
        return {
          action: 'fail',
          delayMs: 0,
          reason: 'Network error recovery limit reached.',
          classification,
          attempt: this.networkAttempts,
          maxAttempts: MAX_NETWORK_RECOVERIES,
        };
      }
      this.networkAttempts += 1;
      const exponentialDelay = NETWORK_BASE_DELAY_MS * 2 ** (this.networkAttempts - 1);
      const sinceLast = this.lastRecoveryAtMs > 0 ? nowMs - this.lastRecoveryAtMs : Infinity;
      const delayMs =
        sinceLast < NETWORK_COOLDOWN_MS
          ? Math.max(exponentialDelay, NETWORK_COOLDOWN_MS)
          : exponentialDelay;
      this.lastRecoveryAtMs = nowMs;
      return {
        action: 'retry_load',
        delayMs,
        reason: data.details ? `Recovering from ${data.details}` : 'Recovering from network error',
        classification,
        attempt: this.networkAttempts,
        maxAttempts: MAX_NETWORK_RECOVERIES,
      };
    }

    if (classification === 'media_decode') {
      if (this.mediaAttempts >= MAX_MEDIA_RECOVERIES) {
        return {
          action: 'fail',
          delayMs: 0,
          reason: 'Media decode recovery limit reached.',
          classification,
          attempt: this.mediaAttempts,
          maxAttempts: MAX_MEDIA_RECOVERIES,
        };
      }
      this.mediaAttempts += 1;
      const sinceLast = this.lastRecoveryAtMs > 0 ? nowMs - this.lastRecoveryAtMs : Infinity;
      const delayMs = sinceLast < MEDIA_COOLDOWN_MS ? MEDIA_COOLDOWN_MS - sinceLast : 0;
      this.lastRecoveryAtMs = nowMs;

      if (this.mediaAttempts === 1) {
        return {
          action: 'recover_media',
          delayMs,
          reason: 'Recovering media decoder pipeline',
          classification,
          attempt: this.mediaAttempts,
          maxAttempts: MAX_MEDIA_RECOVERIES,
        };
      }

      return {
        action: 'swap_audio_and_recover',
        delayMs,
        reason: 'Swapping audio codec and recovering media pipeline',
        classification,
        attempt: this.mediaAttempts,
        maxAttempts: MAX_MEDIA_RECOVERIES,
      };
    }

    return {
      action: 'fail',
      delayMs: 0,
      reason: data.details || data.reason || 'Unrecoverable playback error.',
      classification: 'fatal_unrecoverable',
      attempt: 0,
      maxAttempts: 0,
    };
  }

  resetForNewSource(): void {
    this.networkAttempts = 0;
    this.mediaAttempts = 0;
    this.lastRecoveryAtMs = 0;
    this.lastErrorAtMs = 0;
  }

  resetAll(): void {
    this.resetForNewSource();
    this.reResolveTimestamps.length = 0;
  }

  private pruneReResolveHistory(nowMs: number): void {
    while (
      this.reResolveTimestamps.length > 0 &&
      nowMs - this.reResolveTimestamps[0] > RE_RESOLVE_WINDOW_MS
    ) {
      this.reResolveTimestamps.shift();
    }
  }
}
