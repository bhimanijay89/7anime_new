import type {
  NetworkProfile,
  PlaybackTelemetryEvent,
  PlaybackTelemetrySnapshot,
} from './types.ts';

const MAX_RECENT_EVENTS = 16;

export function sanitizeUrlForTelemetry(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export class PlaybackTelemetryCollector {
  private engine: 'hlsjs' | 'native' | 'idle' = 'idle';
  private sourceOrigin: string | null = null;
  private resolutionLatencyMs: number | null = null;
  private attachAtMs: number | null = null;
  private firstPlayableMs: number | null = null;
  private firstFrameMs: number | null = null;
  private segmentThroughputBps = 0;
  private hlsBandwidthEstimateBps: number | null = null;
  private avgBufferAheadSec = 0;
  private currentBufferAheadSec = 0;
  private currentBufferBehindSec = 0;
  private rebufferCount = 0;
  private totalRebufferMs = 0;
  private qualitySwitchCount = 0;
  private droppedFrames = 0;
  private totalVideoFrames = 0;
  private fatalErrorCount = 0;
  private recoveryAttemptCount = 0;
  private activeProfile: NetworkProfile = 'normal';
  private activeLevelIndex = -1;
  private activeLevelHeight: number | null = null;
  private readonly recentEvents: PlaybackTelemetryEvent[] = [];
  private readonly listeners = new Set<(snap: PlaybackTelemetrySnapshot) => void>();

  startSession(options: {
    engine: 'hlsjs' | 'native';
    sourceUrl: string;
    resolutionLatencyMs?: number | null;
    startedAtMs: number;
    profile: NetworkProfile;
  }): void {
    this.engine = options.engine;
    this.sourceOrigin = sanitizeUrlForTelemetry(options.sourceUrl);
    this.resolutionLatencyMs =
      typeof options.resolutionLatencyMs === 'number' &&
      Number.isFinite(options.resolutionLatencyMs)
        ? Math.round(options.resolutionLatencyMs)
        : null;
    this.attachAtMs = options.startedAtMs;
    this.firstPlayableMs = null;
    this.firstFrameMs = null;
    this.segmentThroughputBps = 0;
    this.hlsBandwidthEstimateBps = null;
    this.avgBufferAheadSec = 0;
    this.currentBufferAheadSec = 0;
    this.currentBufferBehindSec = 0;
    this.rebufferCount = 0;
    this.totalRebufferMs = 0;
    this.qualitySwitchCount = 0;
    this.droppedFrames = 0;
    this.totalVideoFrames = 0;
    this.fatalErrorCount = 0;
    this.recoveryAttemptCount = 0;
    this.activeProfile = options.profile;
    this.activeLevelIndex = -1;
    this.activeLevelHeight = null;
    this.recentEvents.length = 0;
    this.pushEvent(options.startedAtMs, 'session_start', `engine=${options.engine}`);
  }

  markFirstPlayable(nowMs: number): void {
    if (this.firstPlayableMs === null && this.attachAtMs !== null) {
      this.firstPlayableMs = Math.max(0, Math.round(nowMs - this.attachAtMs));
      this.pushEvent(nowMs, 'first_playable', `${this.firstPlayableMs}ms`);
    }
  }

  markFirstFrame(nowMs: number): void {
    if (this.firstFrameMs === null && this.attachAtMs !== null) {
      this.firstFrameMs = Math.max(0, Math.round(nowMs - this.attachAtMs));
      this.pushEvent(nowMs, 'first_frame', `${this.firstFrameMs}ms`);
    }
  }

  recordQualitySwitch(levelIndex: number, height: number | null, nowMs: number): void {
    if (this.activeLevelIndex !== -1 && this.activeLevelIndex !== levelIndex) {
      this.qualitySwitchCount += 1;
      this.pushEvent(
        nowMs,
        'level_switched',
        height ? `${height}p (idx ${levelIndex})` : `idx ${levelIndex}`
      );
    }
    this.activeLevelIndex = levelIndex;
    this.activeLevelHeight = height;
    this.emit();
  }

  recordProfileChange(profile: NetworkProfile, reason: string, nowMs: number): void {
    this.activeProfile = profile;
    this.pushEvent(nowMs, 'profile_change', `${profile}: ${reason}`);
  }

  recordFatalError(detail: string, nowMs: number): void {
    this.fatalErrorCount += 1;
    this.pushEvent(nowMs, 'fatal_error', detail);
  }

  recordRecoveryAttempt(action: string, attempt: number, nowMs: number): void {
    this.recoveryAttemptCount += 1;
    this.pushEvent(nowMs, 'recovery', `${action} (#${attempt})`);
  }

  updateMetrics(input: {
    segmentThroughputBps?: number;
    hlsBandwidthEstimateBps?: number | null;
    avgBufferAheadSec?: number;
    currentBufferAheadSec?: number;
    currentBufferBehindSec?: number;
    rebufferCount?: number;
    totalRebufferMs?: number;
    videoElement?: HTMLVideoElement | null;
  }): void {
    if (input.segmentThroughputBps !== undefined) {
      this.segmentThroughputBps = input.segmentThroughputBps;
    }
    if (input.hlsBandwidthEstimateBps !== undefined) {
      this.hlsBandwidthEstimateBps = input.hlsBandwidthEstimateBps;
    }
    if (input.avgBufferAheadSec !== undefined) {
      this.avgBufferAheadSec = input.avgBufferAheadSec;
    }
    if (input.currentBufferAheadSec !== undefined) {
      this.currentBufferAheadSec = input.currentBufferAheadSec;
    }
    if (input.currentBufferBehindSec !== undefined) {
      this.currentBufferBehindSec = input.currentBufferBehindSec;
    }
    if (input.rebufferCount !== undefined) {
      this.rebufferCount = input.rebufferCount;
    }
    if (input.totalRebufferMs !== undefined) {
      this.totalRebufferMs = input.totalRebufferMs;
    }

    const q = input.videoElement?.getVideoPlaybackQuality?.();
    if (q) {
      this.droppedFrames = q.droppedVideoFrames;
      this.totalVideoFrames = q.totalVideoFrames;
    }

    this.emit();
  }

  getSnapshot(): PlaybackTelemetrySnapshot {
    const playbackOffset = this.firstFrameMs ?? this.firstPlayableMs;
    const startupMs =
      playbackOffset !== null
        ? (this.resolutionLatencyMs ?? 0) + playbackOffset
        : null;

    return {
      engine: this.engine,
      sourceOrigin: this.sourceOrigin,
      resolutionLatencyMs: this.resolutionLatencyMs,
      timeToFirstPlayableMs: this.firstPlayableMs,
      timeToFirstFrameMs: this.firstFrameMs,
      startupMs,
      segmentThroughputBps: Math.round(this.segmentThroughputBps),
      hlsBandwidthEstimateBps:
        this.hlsBandwidthEstimateBps !== null &&
        Number.isFinite(this.hlsBandwidthEstimateBps)
          ? Math.round(this.hlsBandwidthEstimateBps)
          : null,
      avgBufferAheadSec: Number(this.avgBufferAheadSec.toFixed(2)),
      currentBufferAheadSec: Number(this.currentBufferAheadSec.toFixed(2)),
      currentBufferBehindSec: Number(this.currentBufferBehindSec.toFixed(2)),
      rebufferCount: this.rebufferCount,
      totalRebufferMs: Math.round(this.totalRebufferMs),
      qualitySwitchCount: this.qualitySwitchCount,
      droppedFrames: this.droppedFrames,
      totalVideoFrames: this.totalVideoFrames,
      fatalErrorCount: this.fatalErrorCount,
      recoveryAttemptCount: this.recoveryAttemptCount,
      activeProfile: this.activeProfile,
      activeLevelIndex: this.activeLevelIndex,
      activeLevelHeight: this.activeLevelHeight,
      recentEvents: [...this.recentEvents],
    };
  }

  subscribe(listener: (snap: PlaybackTelemetrySnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private pushEvent(atMs: number, type: string, detail: string): void {
    this.recentEvents.push({
      atMs: Math.round(atMs),
      type,
      detail,
    });
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.shift();
    }
    this.emit();
  }

  private emit(): void {
    if (this.listeners.size === 0 && !shouldPublishDebugGlobal()) return;
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
    if (shouldPublishDebugGlobal()) {
      (
        globalThis as typeof globalThis & {
          __sevenAnimeHlsTelemetry?: PlaybackTelemetrySnapshot;
        }
      ).__sevenAnimeHlsTelemetry = snap;
    }
  }
}

function shouldPublishDebugGlobal(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean(import.meta?.env?.DEV);
  } catch {
    return false;
  }
}
