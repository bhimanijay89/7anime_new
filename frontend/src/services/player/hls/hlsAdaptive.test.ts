import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptiveNetworkController,
  BufferMonitor,
  ErrorRecoveryManager,
  NetworkMonitor,
  PROFILE_TUNINGS,
  PlaybackTelemetryCollector,
  QualityController,
  applyProfileToHlsInstance,
  createHlsConfig,
  createHlsPlaybackController,
  getInitialNetworkProfile,
  inspectBufferedTimeRanges,
  sanitizeUrlForTelemetry,
  type HlsConstructorLike,
  type HlsInstanceLike,
} from './index.ts';
import {
  resetAniVaultApiCache,
  resolveAniVaultStream,
} from '../anivaultApi.ts';

function ensureWindowGlobals() {
  const g = globalThis as unknown as {
    window?: Record<string, unknown>;
  };
  if (!g.window) {
    g.window = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    };
  }
}

class MockTimeRanges {
  private readonly ranges: Array<[number, number]>;
  constructor(ranges: Array<[number, number]>) {
    this.ranges = ranges;
  }
  get length() {
    return this.ranges.length;
  }
  start(i: number) {
    return this.ranges[i][0];
  }
  end(i: number) {
    return this.ranges[i][1];
  }
}

class MockVideo {
  buffered = new MockTimeRanges([]);
  currentTime = 0;
  duration = 1440;
  paused = false;
  src = '';
  nativeSupported = false;
  playedCount = 0;
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, cb: EventListenerOrEventListenerObject) {
    const fn = typeof cb === 'function' ? cb : cb.handleEvent.bind(cb);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, cb: EventListenerOrEventListenerObject) {
    const fn = typeof cb === 'function' ? cb : cb.handleEvent.bind(cb);
    this.listeners.get(type)?.delete(fn);
  }
  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
  emit(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      fn({ type } as Event);
    }
  }
  canPlayType(mime: string) {
    return this.nativeSupported && mime.includes('mpegurl') ? 'maybe' : '';
  }
  play() {
    this.playedCount += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(attr: string) {
    if (attr === 'src') this.src = '';
  }
  load() {}
  getVideoPlaybackQuality() {
    return {
      droppedVideoFrames: 2,
      totalVideoFrames: 600,
      creationTime: 0,
      corruptedVideoFrames: 0,
    };
  }
}

function createMockHlsClass(supported = true): {
  Ctor: HlsConstructorLike;
  instances: Array<MockHlsInstance>;
} {
  const instances: MockHlsInstance[] = [];

  class MockHlsInstance implements HlsInstanceLike {
    config: Record<string, unknown>;
    levels = [
      { height: 360, width: 640, bitrate: 650_000, frameRate: 24, codecs: 'avc1' },
      { height: 720, width: 1280, bitrate: 2_500_000, frameRate: 24, codecs: 'avc1' },
      { height: 1080, width: 1920, bitrate: 5_500_000, frameRate: 24, codecs: 'avc1' },
    ];
    currentLevel = 1;
    nextLevel = -1;
    loadLevel = -1;
    nextLoadLevel = -1;
    nextAutoLevel = -1;
    autoLevelCapping = -1;
    capLevelToPlayerSize = true;
    maxAutoLevel = 2;
    autoLevelEnabled = true;
    bandwidthEstimate = 3_200_000;
    attachedMedia: HTMLMediaElement | null = null;
    loadedSource: string | null = null;
    destroyed = false;
    startLoadCalls = 0;
    recoverMediaCalls = 0;
    swapAudioCalls = 0;
    handlers = new Map<string, Array<(event: string, data: unknown) => void>>();

    constructor(config: Record<string, unknown> = {}) {
      this.config = { ...config };
      instances.push(this);
    }
    attachMedia(media: HTMLMediaElement) {
      this.attachedMedia = media;
    }
    loadSource(url: string) {
      this.loadedSource = url;
    }
    startLoad() {
      this.startLoadCalls += 1;
    }
    recoverMediaError() {
      this.recoverMediaCalls += 1;
    }
    swapAudioCodec() {
      this.swapAudioCalls += 1;
    }
    destroy() {
      this.destroyed = true;
      this.handlers.clear();
    }
    on<T = unknown>(event: string, cb: (event: string, data: T) => void) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)!.push(cb as (event: string, data: unknown) => void);
    }
    emit(event: string, data: unknown) {
      for (const cb of [...(this.handlers.get(event) ?? [])]) {
        cb(event, data);
      }
    }
  }

  const Ctor = MockHlsInstance as unknown as HlsConstructorLike;
  Ctor.isSupported = () => supported;
  Ctor.Events = {
    ERROR: 'hlsError',
    MANIFEST_PARSED: 'hlsManifestParsed',
    LEVEL_SWITCHED: 'hlsLevelSwitched',
    FRAG_LOADING: 'hlsFragLoading',
    FRAG_LOADED: 'hlsFragLoaded',
    FRAG_BUFFERED: 'hlsFragBuffered',
    BUFFER_APPENDED: 'hlsBufferAppended',
  };
  Ctor.ErrorTypes = {
    NETWORK_ERROR: 'networkError',
    MEDIA_ERROR: 'mediaError',
    KEY_SYSTEM_ERROR: 'keySystemError',
  };

  return { Ctor, instances };
}

test('createHlsConfig configures non-deprecated hls.js 1.6.15 LoadPolicy and ABR limits', () => {
  const cfg = createHlsConfig('normal');
  assert.equal(cfg.enableWorker, true);
  assert.equal(cfg.lowLatencyMode, false);
  assert.equal(cfg.startLevel, -1);
  assert.equal(cfg.capLevelToPlayerSize, true);
  assert.equal(cfg.abrBandWidthFactor, 0.95);
  assert.equal(cfg.abrBandWidthUpFactor, 0.7);
  assert.equal(cfg.maxBufferLength, 28);
  assert.equal(cfg.maxMaxBufferLength, 60);
  assert.equal(cfg.maxBufferSize, 60 * 1024 * 1024);
  assert.equal(cfg.maxBufferHole, 0.5);
  assert.equal(cfg.backBufferLength, 30);
  assert.equal(cfg.fragLoadPolicy.default.maxLoadTimeMs, 30_000);
  assert.equal(cfg.manifestLoadPolicy.default.maxLoadTimeMs, 20_000);
  assert.equal('fragLoadingTimeOut' in cfg, false);

  assert.equal(getInitialNetworkProfile({ saveData: true }), 'slow');
  assert.equal(getInitialNetworkProfile({ effectiveType: '2g' }), 'slow');
  assert.equal(getInitialNetworkProfile({ rttMs: 750 }), 'unstable');
  assert.equal(getInitialNetworkProfile({ effectiveType: '4g', downlinkMbps: 25 }), 'normal');
});

test('NetworkMonitor rejects invalid/0ms cached fragments and tracks rolling EWMA + instability', () => {
  const monitor = new NetworkMonitor();
  monitor.recordFragLoading('0:1', 1000);
  assert.equal(
    monitor.recordFragLoaded('0:1', 500_000, { loaded: 500_000, loading: { start: 1000, end: 1000 } }, 1000),
    null
  );
  assert.equal(monitor.getSnapshot().sampleCount, 0);

  // Valid ~2.4 Mbps fragment (300,000 bytes in 1000ms)
  monitor.recordFragLoading('0:2', 2000);
  const bps = monitor.recordFragLoaded(
    '0:2',
    300_000,
    { loaded: 300_000, loading: { start: 2000, first: 2120, end: 3000 } },
    3000
  );
  assert.equal(bps, 2_400_000);
  const snap = monitor.getSnapshot();
  assert.equal(snap.lastTtfbMs, 120);
  assert.equal(snap.smoothedBandwidthBps, 2_400_000);

  monitor.recordFragError('0:3');
  assert.ok(monitor.getSnapshot().recentFailureRate > 0);
});

test('BufferMonitor safely inspects non-continuous ranges, seeks, and stall recovery', () => {
  const info = inspectBufferedTimeRanges(
    new MockTimeRanges([
      [0, 12],
      [12.3, 25], // gap 0.3s <= 0.5s hole tolerance -> stitched!
      [40, 52],   // separate seeked range
    ]),
    10,
    120
  );
  assert.equal(info.bufferAheadSec, 15);
  assert.equal(info.bufferBehindSec, 10);
  assert.equal(info.rangesCount, 3);

  const emptyInfo = inspectBufferedTimeRanges(new MockTimeRanges([]), 10, 120);
  assert.equal(emptyInfo.bufferAheadSec, 0);

  const bm = new BufferMonitor();
  bm.markPlaybackStarted(1000);
  bm.markWaiting(new MockTimeRanges([[0, 10.1]]), 10, 120, 2000);
  assert.equal(bm.getMetrics(2500).rebufferCount, 1);
  assert.equal(bm.getMetrics(2500).totalRebufferMs, 500);
  bm.sample(new MockTimeRanges([[0, 16]]), 10, 120, false, 3000);
  assert.equal(bm.getMetrics(3500).totalRebufferMs, 1000);
});

test('AdaptiveNetworkController transitions across Slow, Normal, Fast, and Unstable profiles with hysteresis and zero Hls recreation', () => {
  const adaptive = new AdaptiveNetworkController('normal', 0);
  const mockHls = { config: { ...createHlsConfig('normal') } };

  // Throttled SLOW network (~700 kbps) -> transitions normal -> slow cleanly
  const toSlow = adaptive.evaluate(
    {
      network: {
        smoothedBandwidthBps: 700_000,
        ewmaFastBps: 650_000,
        ewmaSlowBps: 800_000,
        lastSampleBps: 650_000,
        lastTtfbMs: 420,
        sampleCount: 3,
        recentFailureRate: 0,
        unstableScore: 0.1,
      },
      buffer: {
        bufferAheadSec: 8,
        bufferBehindSec: 4,
        currentTimeSec: 12,
        durationSec: 1400,
        rangesCount: 1,
        isStalled: false,
        nearEnd: false,
        targetBufferSec: 28,
      },
      recentRebufferCount: 0,
      nowMs: 5_000,
    },
    mockHls
  );
  assert.equal(toSlow?.next, 'slow');
  assert.equal(mockHls.config.maxBufferLength, PROFILE_TUNINGS.slow.maxBufferLength);

  // Hysteresis cooldown blocks rapid ping-pong back to normal within 10s
  const blockedUpgrade = adaptive.evaluate(
    {
      network: {
        smoothedBandwidthBps: 3_000_000,
        ewmaFastBps: 3_000_000,
        ewmaSlowBps: 2_500_000,
        lastSampleBps: 3_000_000,
        lastTtfbMs: 90,
        sampleCount: 4,
        recentFailureRate: 0,
        unstableScore: 0.05,
      },
      buffer: {
        bufferAheadSec: 15,
        bufferBehindSec: 8,
        currentTimeSec: 20,
        durationSec: 1400,
        rangesCount: 1,
        isStalled: false,
        nearEnd: false,
        targetBufferSec: 18,
      },
      recentRebufferCount: 0,
      nowMs: 8_000,
    },
    mockHls
  );
  assert.equal(blockedUpgrade, null);

  // After upgrade cooldown: slow -> normal -> fast
  const toNormal = adaptive.evaluate(
    {
      network: {
        smoothedBandwidthBps: 3_000_000,
        ewmaFastBps: 3_000_000,
        ewmaSlowBps: 2_500_000,
        lastSampleBps: 3_000_000,
        lastTtfbMs: 90,
        sampleCount: 5,
        recentFailureRate: 0,
        unstableScore: 0.05,
      },
      buffer: {
        bufferAheadSec: 16,
        bufferBehindSec: 8,
        currentTimeSec: 25,
        durationSec: 1400,
        rangesCount: 1,
        isStalled: false,
        nearEnd: false,
        targetBufferSec: 18,
      },
      recentRebufferCount: 0,
      nowMs: 16_000,
    },
    mockHls
  );
  assert.equal(toNormal?.next, 'normal');

  const toFast = adaptive.evaluate(
    {
      network: {
        smoothedBandwidthBps: 12_000_000,
        ewmaFastBps: 12_500_000,
        ewmaSlowBps: 9_500_000,
        lastSampleBps: 13_000_000,
        lastTtfbMs: 45,
        sampleCount: 8,
        recentFailureRate: 0,
        unstableScore: 0.05,
      },
      buffer: {
        bufferAheadSec: 24,
        bufferBehindSec: 12,
        currentTimeSec: 40,
        durationSec: 1400,
        rangesCount: 1,
        isStalled: false,
        nearEnd: false,
        targetBufferSec: 28,
      },
      recentRebufferCount: 0,
      nowMs: 28_000,
    },
    mockHls
  );
  assert.equal(toFast?.next, 'fast');
  assert.equal(mockHls.config.maxBufferLength, PROFILE_TUNINGS.fast.maxBufferLength);

  // Packet loss / stalls trigger unstable profile
  const toUnstable = adaptive.evaluate(
    {
      network: {
        smoothedBandwidthBps: 4_000_000,
        ewmaFastBps: 2_000_000,
        ewmaSlowBps: 6_000_000,
        lastSampleBps: 1_500_000,
        lastTtfbMs: 950,
        sampleCount: 10,
        recentFailureRate: 0.35,
        unstableScore: 0.85,
      },
      buffer: {
        bufferAheadSec: 4,
        bufferBehindSec: 12,
        currentTimeSec: 50,
        durationSec: 1400,
        rangesCount: 1,
        isStalled: true,
        nearEnd: false,
        targetBufferSec: 40,
      },
      recentRebufferCount: 2,
      nowMs: 33_000,
    },
    mockHls
  );
  assert.equal(toUnstable?.next, 'unstable');
  assert.equal(mockHls.config.abrBandWidthUpFactor, PROFILE_TUNINGS.unstable.abrBandWidthUpFactor);

  // In-place tuning retains exact config object identity
  const ref = mockHls.config;
  applyProfileToHlsInstance(mockHls, 'normal');
  assert.equal(mockHls.config, ref);
});

test('ErrorRecoveryManager enforces bounded network/media retries and 401/403 expired URL re-resolve', () => {
  const errMgr = new ErrorRecoveryManager();
  const types = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', KEY_SYSTEM_ERROR: 'keySystemError' };

  const d1 = errMgr.decide({ fatal: true, type: 'networkError', details: 'fragLoadError' }, types, 1000);
  const d2 = errMgr.decide({ fatal: true, type: 'networkError', details: 'fragLoadError' }, types, 3000);
  const d3 = errMgr.decide({ fatal: true, type: 'networkError', details: 'fragLoadError' }, types, 6000);
  const d4 = errMgr.decide({ fatal: true, type: 'networkError', details: 'fragLoadError' }, types, 10000);
  assert.equal(d1.action, 'retry_load');
  assert.equal(d2.action, 'retry_load');
  assert.equal(d3.action, 'retry_load');
  assert.ok(d2.delayMs > d1.delayMs);
  assert.equal(d4.action, 'fail');

  const mediaMgr = new ErrorRecoveryManager();
  assert.equal(mediaMgr.decide({ fatal: true, type: 'mediaError' }, types, 1000).action, 'recover_media');
  assert.equal(mediaMgr.decide({ fatal: true, type: 'mediaError' }, types, 2500).action, 'swap_audio_and_recover');
  assert.equal(mediaMgr.decide({ fatal: true, type: 'mediaError' }, types, 4000).action, 'fail');

  const expMgr = new ErrorRecoveryManager();
  assert.equal(expMgr.decide({ fatal: true, type: 'networkError', response: { code: 403 } }, types, 1000).action, 're_resolve');
  assert.equal(expMgr.decide({ fatal: true, type: 'networkError', response: { code: 401 } }, types, 4000).action, 're_resolve');
  assert.equal(expMgr.decide({ fatal: true, type: 'networkError', response: { code: 403 } }, types, 7000).action, 'fail');
});

test('QualityController selects levels smoothly and warns when manual level exceeds measured bandwidth', () => {
  const { Ctor, instances } = createMockHlsClass(true);
  const hls = new Ctor();
  const qc = new QualityController();
  const state = qc.setLevels(hls.levels, 1);
  assert.equal(state.levels.length, 3);
  assert.equal(state.autoMode, true);

  const manualHigh = qc.selectQuality(hls, 2, {
    bufferAheadSec: 12,
    network: {
      smoothedBandwidthBps: 1_500_000,
      ewmaFastBps: 1_500_000,
      ewmaSlowBps: 1_500_000,
      lastSampleBps: 1_500_000,
      lastTtfbMs: 80,
      sampleCount: 3,
      recentFailureRate: 0,
      unstableScore: 0,
    },
  });
  assert.equal(manualHigh.applied, true);
  assert.equal(hls.nextLevel, 2);
  assert.ok(manualHigh.warning?.includes('1080p'));

  const backToAuto = qc.selectQuality(hls, -1);
  assert.equal(backToAuto.selectedLevel, -1);
  assert.equal(hls.nextLevel, -1);
  assert.equal(instances.length, 1);
});

test('PlaybackTelemetryCollector strips signed query strings and records startup/rebuffer/frame metrics', () => {
  assert.equal(
    sanitizeUrlForTelemetry('https://cdn.example.com/hls/ep1/master.m3u8?token=SECRET_KEY&exp=9999'),
    'https://cdn.example.com/hls/ep1/master.m3u8'
  );

  const telemetry = new PlaybackTelemetryCollector();
  telemetry.startSession({
    engine: 'hlsjs',
    sourceUrl: 'https://proxy.example.com/stream/abc?sig=PRIVATE',
    resolutionLatencyMs: 220,
    startedAtMs: 1000,
    profile: 'normal',
  });
  telemetry.markFirstPlayable(1350);
  telemetry.markFirstFrame(1420);
  telemetry.updateMetrics({
    segmentThroughputBps: 4_500_000,
    avgBufferAheadSec: 22.4,
    currentBufferAheadSec: 24.1,
    rebufferCount: 0,
    totalRebufferMs: 0,
    videoElement: new MockVideo() as unknown as HTMLVideoElement,
  });

  const snap = telemetry.getSnapshot();
  assert.equal(snap.sourceOrigin, 'https://proxy.example.com/stream/abc');
  assert.equal(snap.resolutionLatencyMs, 220);
  assert.equal(snap.timeToFirstPlayableMs, 350);
  assert.equal(snap.timeToFirstFrameMs, 420);
  assert.equal(snap.startupMs, 640);
  assert.equal(snap.droppedFrames, 2);
  assert.equal(snap.totalVideoFrames, 600);
});

test('createHlsPlaybackController integrates full lifecycle, expired re-resolve, native fallback, and clean destroy', async () => {
  ensureWindowGlobals();

  let now = 1000;
  const video = new MockVideo();
  const { Ctor, instances } = createMockHlsClass(true);
  let loadedCount = 0;
  let expiredResumeAt = -1;

  const controller = createHlsPlaybackController({
    video: video as unknown as HTMLVideoElement,
    source: 'https://anivault.example/proxy/ep1.m3u8?token=abc',
    autoplay: true,
    getNow: () => now,
    loadHls: async () => Ctor,
    onLoad: () => {
      loadedCount += 1;
    },
    onStreamExpired: (resumeAt) => {
      expiredResumeAt = resumeAt;
    },
  });

  await controller.start();
  assert.equal(instances.length, 1);
  const hls = instances[0];
  assert.equal(hls.loadedSource, 'https://anivault.example/proxy/ep1.m3u8?token=abc');

  hls.emit(Ctor.Events.MANIFEST_PARSED, { levels: hls.levels, firstLevel: 1 });
  assert.equal(video.playedCount, 1);
  assert.equal(controller.getQualityState().levels.length, 3);

  now = 1250;
  video.emit('loadeddata');
  video.emit('playing');
  assert.equal(loadedCount, 1);

  video.currentTime = 142.7;
  hls.emit(Ctor.Events.ERROR, {
    fatal: true,
    type: Ctor.ErrorTypes.NETWORK_ERROR,
    details: 'manifestLoadError',
    response: { code: 403 },
  });
  assert.equal(expiredResumeAt, 142);

  controller.destroy();
  assert.equal(hls.destroyed, true);
  assert.equal(video.listenerCount('loadeddata'), 0);
  assert.equal(video.listenerCount('playing'), 0);

  // Verify Native HLS fallback when Hls.isSupported() returns false
  const nativeVideo = new MockVideo();
  nativeVideo.nativeSupported = true;
  const { Ctor: UnsupportedCtor } = createMockHlsClass(false);
  const nativeController = createHlsPlaybackController({
    video: nativeVideo as unknown as HTMLVideoElement,
    source: 'https://anivault.example/proxy/native.m3u8',
    resumePositionSec: 45,
    loadHls: async () => UnsupportedCtor,
  });
  await nativeController.start();
  assert.equal(nativeVideo.src, 'https://anivault.example/proxy/native.m3u8');
  nativeVideo.emit('loadedmetadata');
  assert.equal(nativeVideo.currentTime, 45);
  nativeController.destroy();
});

test('resolveAniVaultStream deduplicates concurrent calls, caches, retries 5xx once, and supports bypassCache', async () => {
  resetAniVaultApiCache();
  let calls = 0;

  const mockFetch: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: 'temporary outage' }), { status: 503 });
    }
    return new Response(
      JSON.stringify({
        hlsProxyUrl: 'https://anivault.example/proxy/sub.m3u8',
        subtitles: [{ url: 'https://anivault.example/sub.vtt', lang: 'en', label: 'English', default: true }],
        serverName: 'MegaPlay Direct',
      }),
      { status: 200 }
    );
  };

  // First two concurrent calls collapse into one network sequence (with 1 transient 503 retry -> calls becomes 2)
  const [r1, r2] = await Promise.all([
    resolveAniVaultStream({
      server: 'default',
      anilistId: 21,
      episodeNumber: 5,
      audioMode: 'sub',
      fetchImpl: mockFetch,
    }),
    resolveAniVaultStream({
      server: 'default',
      anilistId: 21,
      episodeNumber: 5,
      audioMode: 'sub',
      fetchImpl: mockFetch,
    }),
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(calls, 2);

  // Cached hit avoids network call
  const r3 = await resolveAniVaultStream({
    server: 'default',
    anilistId: 21,
    episodeNumber: 5,
    audioMode: 'sub',
    fetchImpl: mockFetch,
  });
  assert.equal(r3.ok, true);
  assert.equal(calls, 2);

  // bypassCache refreshes immediately
  const r4 = await resolveAniVaultStream({
    server: 'default',
    anilistId: 21,
    episodeNumber: 5,
    audioMode: 'sub',
    bypassCache: true,
    fetchImpl: mockFetch,
  });
  assert.equal(r4.ok, true);
  assert.equal(calls, 3);
  resetAniVaultApiCache();
});
