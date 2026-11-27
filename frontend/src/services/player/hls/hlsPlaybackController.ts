import { AdaptiveNetworkController } from './adaptiveController.ts';
import { BufferMonitor } from './bufferMonitor.ts';
import { ErrorRecoveryManager } from './errorRecovery.ts';
import {
  PROFILE_TUNINGS,
  createHlsConfig,
  getInitialNetworkProfile,
  readNavigatorConnectionHint,
} from './hlsConfig.ts';
import { canPlayNativeHls, loadHlsLibrary } from './hlsLoader.ts';
import { NetworkMonitor } from './networkMonitor.ts';
import { PlaybackTelemetryCollector } from './playbackTelemetry.ts';
import { QualityController, type QualitySelectionResult } from './qualityController.ts';
import type {
  HlsAdaptiveConfig,
  HlsConstructorLike,
  HlsErrorPayload,
  HlsFragPayload,
  HlsInstanceLike,
  HlsLevelSwitchedPayload,
  HlsManifestParsedPayload,
  PlaybackTelemetrySnapshot,
  QualityState,
} from './types.ts';

export interface HlsPlaybackControllerOptions {
  video: HTMLVideoElement;
  source: string;
  autoplay?: boolean;
  resumePositionSec?: number;
  resolutionLatencyMs?: number | null;
  getNow?: () => number;
  loadHls?: () => Promise<HlsConstructorLike | null>;
  onLoad?: () => void;
  onError?: (reason?: string) => void;
  onStreamExpired?: (resumeAtSec: number, reason: string) => void;
  onQualityStateChange?: (state: QualityState) => void;
  onQualityWarning?: (warning: string) => void;
  onTelemetryChange?: (snapshot: PlaybackTelemetrySnapshot) => void;
}

export interface HlsPlaybackControllerHandle {
  start: () => Promise<void>;
  selectQuality: (levelIndex: number) => QualitySelectionResult;
  getQualityState: () => QualityState;
  getTelemetry: () => PlaybackTelemetrySnapshot;
  destroy: () => void;
}

function getFragKey(payload: HlsFragPayload | undefined): string {
  const frag = payload?.frag;
  if (!frag) return 'unknown';
  return `${frag.level ?? 0}:${String(frag.sn ?? '0')}`;
}

export function createHlsPlaybackController(
  options: HlsPlaybackControllerOptions
): HlsPlaybackControllerHandle {
  const { video, source } = options;
  const autoplay = options.autoplay ?? true;
  const getNow = options.getNow ?? (() => performance.now());

  const initialHint = readNavigatorConnectionHint();
  const initialProfile = getInitialNetworkProfile(initialHint);

  const networkMonitor = new NetworkMonitor();
  const bufferMonitor = new BufferMonitor();
  const adaptiveController = new AdaptiveNetworkController(initialProfile, getNow());
  const qualityController = new QualityController();
  const errorRecovery = new ErrorRecoveryManager();
  const telemetry = new PlaybackTelemetryCollector();

  let hls: HlsInstanceLike | null = null;
  let disposed = false;
  let recoveryTimer: number | null = null;
  let heartbeatTimer: number | null = null;
  let unsubTelemetry: (() => void) | null = null;

  if (options.onTelemetryChange) {
    unsubTelemetry = telemetry.subscribe(options.onTelemetryChange);
  }

  bufferMonitor.reset(PROFILE_TUNINGS[initialProfile].targetBufferSec);

  const clearRecoveryTimer = () => {
    if (recoveryTimer !== null) {
      window.clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
  };

  const clearHeartbeatTimer = () => {
    if (heartbeatTimer !== null) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const syncMetricsAndAdapt = () => {
    if (disposed) return;
    const now = getNow();
    const netSnap = networkMonitor.getSnapshot();
    const bufSnap = bufferMonitor.sample(
      video.buffered,
      video.currentTime,
      video.duration,
      video.paused,
      now
    );

    const profileChange = adaptiveController.evaluate(
      {
        network: netSnap,
        buffer: bufSnap,
        recentRebufferCount: bufferMonitor.getRecentRebufferCount(now),
        connectionHint: readNavigatorConnectionHint(),
        nowMs: now,
      },
      hls
    );

    if (profileChange) {
      bufferMonitor.setTargetBufferSec(profileChange.tuning.targetBufferSec);
      telemetry.recordProfileChange(
        profileChange.next,
        profileChange.reason,
        now
      );
    }

    if (hls) {
      qualityController.applyAdaptiveGuidance(
        hls,
        adaptiveController.getProfile(),
        netSnap,
        bufSnap,
        now
      );
    }

    const bufMetrics = bufferMonitor.getMetrics(now);
    telemetry.updateMetrics({
      segmentThroughputBps: netSnap.smoothedBandwidthBps,
      hlsBandwidthEstimateBps: hls ? hls.bandwidthEstimate : null,
      avgBufferAheadSec: bufMetrics.averageBufferAheadSec,
      currentBufferAheadSec: bufMetrics.snapshot.bufferAheadSec,
      currentBufferBehindSec: bufMetrics.snapshot.bufferBehindSec,
      rebufferCount: bufMetrics.rebufferCount,
      totalRebufferMs: bufMetrics.totalRebufferMs,
      videoElement: video,
    });
  };

  const handleLoadedData = () => {
    if (disposed) return;
    telemetry.markFirstPlayable(getNow());
    options.onLoad?.();
    syncMetricsAndAdapt();
  };

  const handleCanPlay = () => {
    if (disposed) return;
    telemetry.markFirstPlayable(getNow());
  };

  const handlePlaying = () => {
    if (disposed) return;
    const now = getNow();
    bufferMonitor.markPlaybackStarted(now);
    telemetry.markFirstFrame(now);
    syncMetricsAndAdapt();
  };

  const handleWaiting = () => {
    if (disposed) return;
    bufferMonitor.markWaiting(
      video.buffered,
      video.currentTime,
      video.duration,
      getNow()
    );
    syncMetricsAndAdapt();
  };

  const handleSeeked = () => {
    if (disposed) return;
    bufferMonitor.markSeeked();
    syncMetricsAndAdapt();
  };

  const handleNativeVideoError = () => {
    if (disposed) return;
    // When HLS.js is attached, HLS.js handles media/network errors via Events.ERROR first.
    if (hls) return;
    telemetry.recordFatalError('HTMLMediaElement error', getNow());
    options.onError?.('Playback error occurred.');
  };

  video.addEventListener('loadeddata', handleLoadedData);
  video.addEventListener('canplay', handleCanPlay);
  video.addEventListener('playing', handlePlaying);
  video.addEventListener('waiting', handleWaiting);
  video.addEventListener('seeked', handleSeeked);
  video.addEventListener('error', handleNativeVideoError);

  const loadEngine = async (): Promise<HlsConstructorLike | null> => {
    if (options.loadHls) return options.loadHls();
    try {
      await loadHlsLibrary();
      return window.Hls ?? null;
    } catch (err) {
      console.warn('[AniVault HLS] hls.js could not be loaded; trying native HLS:', err);
      return null;
    }
  };

  const start = async () => {
    const resolvedHls = await loadEngine();
    if (disposed) return;

    if (resolvedHls && resolvedHls.isSupported()) {
      const startPos =
        typeof options.resumePositionSec === 'number' && options.resumePositionSec > 1
          ? options.resumePositionSec
          : -1;

      const hlsConfig: Partial<HlsAdaptiveConfig> & { startPosition?: number } = {
        ...createHlsConfig(initialProfile),
        ...(startPos > 0 ? { startPosition: startPos } : {}),
      };

      const instance = new resolvedHls(hlsConfig);
      hls = instance;

      telemetry.startSession({
        engine: 'hlsjs',
        sourceUrl: source,
        resolutionLatencyMs: options.resolutionLatencyMs,
        startedAtMs: getNow(),
        profile: initialProfile,
      });

      const { Events, ErrorTypes } = resolvedHls;

      instance.on<HlsManifestParsedPayload>(Events.MANIFEST_PARSED, (_evt, data) => {
        if (disposed || hls !== instance) return;
        const levels = data?.levels ?? instance.levels ?? [];
        const qState = qualityController.setLevels(levels, data?.firstLevel ?? -1);
        options.onQualityStateChange?.(qState);

        if (autoplay) {
          video.play().catch(() => {});
        }
      });

      instance.on<HlsLevelSwitchedPayload>(Events.LEVEL_SWITCHED, (_evt, data) => {
        if (disposed || hls !== instance) return;
        const lvlIdx = typeof data?.level === 'number' ? data.level : instance.currentLevel;
        const qState = qualityController.onLevelSwitched(lvlIdx, instance);
        const info = qState.levels.find((l) => l.index === lvlIdx);
        telemetry.recordQualitySwitch(lvlIdx, info?.height || null, getNow());
        options.onQualityStateChange?.(qState);
      });

      instance.on<HlsFragPayload>(Events.FRAG_LOADING, (_evt, data) => {
        if (disposed || hls !== instance) return;
        networkMonitor.recordFragLoading(getFragKey(data), getNow());
      });

      instance.on<HlsFragPayload>(Events.FRAG_LOADED, (_evt, data) => {
        if (disposed || hls !== instance) return;
        const now = getNow();
        const stats = data?.frag?.stats ?? data?.stats;
        networkMonitor.recordFragLoaded(
          getFragKey(data),
          data?.payload?.byteLength,
          stats,
          now
        );
        errorRecovery.markHealthyPlayback(now);
        syncMetricsAndAdapt();
      });

      instance.on(Events.BUFFER_APPENDED, () => {
        if (disposed || hls !== instance) return;
        syncMetricsAndAdapt();
      });

      instance.on<HlsErrorPayload>(Events.ERROR, (_evt, data) => {
        if (disposed || hls !== instance || !data) return;

        if (!data.fatal) {
          if (data.frag) {
            networkMonitor.recordFragError(getFragKey({ frag: data.frag }));
          }
          return;
        }

        const now = getNow();
        networkMonitor.recordFragError(data.frag ? getFragKey({ frag: data.frag }) : undefined);
        const decision = errorRecovery.decide(data, ErrorTypes, now);
        telemetry.recordFatalError(
          `${data.type ?? 'unknown'}:${data.details ?? 'error'}`,
          now
        );
        console.error('[AniVault HLS] Fatal playback error:', {
          type: data.type,
          details: data.details,
          code: data.response?.code,
          action: decision.action,
          attempt: decision.attempt,
        });

        clearRecoveryTimer();

        if (decision.action === 're_resolve') {
          const resumeAt = Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : 0;
          telemetry.recordRecoveryAttempt(decision.action, decision.attempt, now);
          const trigger = () => {
            if (!disposed) {
              options.onStreamExpired?.(resumeAt, decision.reason);
            }
          };
          if (decision.delayMs > 0) {
            recoveryTimer = window.setTimeout(trigger, decision.delayMs);
          } else {
            trigger();
          }
          return;
        }

        if (decision.action === 'retry_load') {
          telemetry.recordRecoveryAttempt(decision.action, decision.attempt, now);
          recoveryTimer = window.setTimeout(() => {
            if (!disposed && hls === instance) {
              instance.startLoad();
            }
          }, decision.delayMs);
          return;
        }

        if (
          decision.action === 'recover_media' ||
          decision.action === 'swap_audio_and_recover'
        ) {
          telemetry.recordRecoveryAttempt(decision.action, decision.attempt, now);
          const runMediaRecovery = () => {
            if (disposed || hls !== instance) return;
            if (decision.action === 'swap_audio_and_recover') {
              instance.swapAudioCodec?.();
            }
            instance.recoverMediaError();
          };
          if (decision.delayMs > 0) {
            recoveryTimer = window.setTimeout(runMediaRecovery, decision.delayMs);
          } else {
            runMediaRecovery();
          }
          return;
        }

        options.onError?.(decision.reason);
      });

      heartbeatTimer = window.setInterval(() => {
        if (!disposed) syncMetricsAndAdapt();
      }, 1500);

      instance.attachMedia(video);
      instance.loadSource(source);
      return;
    }

    if (canPlayNativeHls(video)) {
      telemetry.startSession({
        engine: 'native',
        sourceUrl: source,
        resolutionLatencyMs: options.resolutionLatencyMs,
        startedAtMs: getNow(),
        profile: initialProfile,
      });

      const handleLoadedMeta = () => {
        if (disposed) return;
        if (
          typeof options.resumePositionSec === 'number' &&
          options.resumePositionSec > 1 &&
          Number.isFinite(video.duration) &&
          options.resumePositionSec < video.duration - 2
        ) {
          video.currentTime = options.resumePositionSec;
        }
        if (autoplay) {
          video.play().catch(() => {});
        }
      };

      video.addEventListener('loadedmetadata', handleLoadedMeta, { once: true });
      video.src = source;
      video.load();
      heartbeatTimer = window.setInterval(() => {
        if (!disposed) syncMetricsAndAdapt();
      }, 1500);
      return;
    }

    throw new Error('This browser does not support HLS playback.');
  };

  return {
    start,
    selectQuality(levelIndex: number): QualitySelectionResult {
      const result = qualityController.selectQuality(hls, levelIndex, {
        network: networkMonitor.getSnapshot(),
        bufferAheadSec: bufferMonitor.getMetrics(getNow()).snapshot.bufferAheadSec,
      });
      if (result.warning) {
        options.onQualityWarning?.(result.warning);
      }
      options.onQualityStateChange?.(qualityController.getState(hls));
      return result;
    },
    getQualityState(): QualityState {
      return qualityController.getState(hls);
    },
    getTelemetry(): PlaybackTelemetrySnapshot {
      return telemetry.getSnapshot();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      clearRecoveryTimer();
      clearHeartbeatTimer();
      unsubTelemetry?.();
      unsubTelemetry = null;

      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('error', handleNativeVideoError);

      if (hls) {
        try {
          hls.destroy();
        } catch {
          // Ignore teardown errors on already-detached media.
        }
        hls = null;
      }

      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        // Ignore DOM cleanup noise during teardown.
      }
    },
  };
}
