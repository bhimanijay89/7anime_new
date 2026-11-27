import type {
  HlsAdaptiveConfig,
  HlsInstanceLike,
  HlsLoadPolicyConfig,
  HlsProfileTuning,
  NetworkConnectionHint,
  NetworkProfile,
} from './types.ts';

const MB = 1024 * 1024;

/**
 * Verified hls.js@1.6.15 runtime buffer and ABR tunings per adaptive network profile.
 */
export const PROFILE_TUNINGS: Record<NetworkProfile, HlsProfileTuning> = {
  slow: {
    profile: 'slow',
    targetBufferSec: 18,
    maxBufferLength: 18,
    maxMaxBufferLength: 36,
    maxBufferSize: 36 * MB,
    abrBandWidthFactor: 0.8,
    abrBandWidthUpFactor: 0.52,
    abrEwmaDefaultEstimate: 500_000,
    abrEwmaFastVoD: 3.5,
    abrEwmaSlowVoD: 10,
  },
  normal: {
    profile: 'normal',
    targetBufferSec: 28,
    maxBufferLength: 28,
    maxMaxBufferLength: 60,
    maxBufferSize: 60 * MB,
    abrBandWidthFactor: 0.95,
    abrBandWidthUpFactor: 0.7,
    abrEwmaDefaultEstimate: 1_500_000,
    abrEwmaFastVoD: 3,
    abrEwmaSlowVoD: 9,
  },
  fast: {
    profile: 'fast',
    targetBufferSec: 40,
    maxBufferLength: 40,
    maxMaxBufferLength: 75,
    maxBufferSize: 75 * MB,
    abrBandWidthFactor: 0.98,
    abrBandWidthUpFactor: 0.82,
    abrEwmaDefaultEstimate: 4_000_000,
    abrEwmaFastVoD: 2.5,
    abrEwmaSlowVoD: 7,
  },
  unstable: {
    profile: 'unstable',
    targetBufferSec: 24,
    maxBufferLength: 24,
    maxMaxBufferLength: 45,
    maxBufferSize: 48 * MB,
    abrBandWidthFactor: 0.78,
    abrBandWidthUpFactor: 0.45,
    abrEwmaDefaultEstimate: 900_000,
    abrEwmaFastVoD: 4,
    abrEwmaSlowVoD: 12,
  },
};

function createManifestPolicy(): HlsLoadPolicyConfig {
  return {
    maxTimeToFirstByteMs: 12_000,
    maxLoadTimeMs: 20_000,
    timeoutRetry: {
      maxNumRetry: 2,
      retryDelayMs: 750,
      maxRetryDelayMs: 4_000,
      backoff: 'exponential',
    },
    errorRetry: {
      maxNumRetry: 3,
      retryDelayMs: 750,
      maxRetryDelayMs: 5_000,
      backoff: 'exponential',
    },
  };
}

function createFragmentPolicy(): HlsLoadPolicyConfig {
  return {
    maxTimeToFirstByteMs: 15_000,
    maxLoadTimeMs: 30_000,
    timeoutRetry: {
      maxNumRetry: 3,
      retryDelayMs: 800,
      maxRetryDelayMs: 6_000,
      backoff: 'exponential',
    },
    errorRetry: {
      maxNumRetry: 4,
      retryDelayMs: 800,
      maxRetryDelayMs: 6_000,
      backoff: 'exponential',
    },
  };
}

export function readNavigatorConnectionHint(): NetworkConnectionHint {
  if (typeof navigator === 'undefined') return {};
  const nav = navigator as Navigator & {
    connection?: {
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
      saveData?: boolean;
    };
  };
  const conn = nav.connection;
  if (!conn) return {};
  return {
    effectiveType: typeof conn.effectiveType === 'string' ? conn.effectiveType : undefined,
    downlinkMbps: typeof conn.downlink === 'number' && Number.isFinite(conn.downlink) ? conn.downlink : undefined,
    rttMs: typeof conn.rtt === 'number' && Number.isFinite(conn.rtt) ? conn.rtt : undefined,
    saveData: typeof conn.saveData === 'boolean' ? conn.saveData : undefined,
  };
}

/**
 * Uses NetworkInformation purely as a conservative startup hint; actual segment
 * measurements take over immediately once playback starts.
 */
export function getInitialNetworkProfile(hint: NetworkConnectionHint): NetworkProfile {
  if (hint.saveData) return 'slow';
  if (hint.effectiveType === 'slow-2g' || hint.effectiveType === '2g') {
    return 'slow';
  }
  if (
    hint.effectiveType === '3g' &&
    hint.downlinkMbps !== undefined &&
    hint.downlinkMbps < 1.5
  ) {
    return 'slow';
  }
  if (hint.rttMs !== undefined && hint.rttMs > 600) {
    return 'unstable';
  }
  return 'normal';
}

export function createHlsConfig(
  profile: NetworkProfile = 'normal',
  overrides: Partial<HlsAdaptiveConfig> = {}
): HlsAdaptiveConfig {
  const tuning = PROFILE_TUNINGS[profile];

  return {
    enableWorker: true,
    lowLatencyMode: false,
    progressive: true,
    startLevel: -1,
    startFragPrefetch: true,
    capLevelToPlayerSize: true,
    abrBandWidthFactor: tuning.abrBandWidthFactor,
    abrBandWidthUpFactor: tuning.abrBandWidthUpFactor,
    abrEwmaDefaultEstimate: tuning.abrEwmaDefaultEstimate,
    abrEwmaFastVoD: tuning.abrEwmaFastVoD,
    abrEwmaSlowVoD: tuning.abrEwmaSlowVoD,
    maxBufferLength: tuning.maxBufferLength,
    maxMaxBufferLength: tuning.maxMaxBufferLength,
    maxBufferSize: tuning.maxBufferSize,
    maxBufferHole: 0.5,
    backBufferLength: 30,
    manifestLoadPolicy: { default: createManifestPolicy() },
    playlistLoadPolicy: { default: createManifestPolicy() },
    fragLoadPolicy: { default: createFragmentPolicy() },
    ...overrides,
  };
}

/**
 * Updates documented hls.js@1.6.15 runtime buffer and ABR configuration in place
 * without tearing down or recreating the Hls instance.
 */
export function applyProfileToHlsInstance(
  hls: Pick<HlsInstanceLike, 'config'>,
  profile: NetworkProfile
): HlsProfileTuning {
  const tuning = PROFILE_TUNINGS[profile];
  hls.config.maxBufferLength = tuning.maxBufferLength;
  hls.config.maxMaxBufferLength = tuning.maxMaxBufferLength;
  hls.config.maxBufferSize = tuning.maxBufferSize;
  hls.config.abrBandWidthFactor = tuning.abrBandWidthFactor;
  hls.config.abrBandWidthUpFactor = tuning.abrBandWidthUpFactor;
  hls.config.abrEwmaFastVoD = tuning.abrEwmaFastVoD;
  hls.config.abrEwmaSlowVoD = tuning.abrEwmaSlowVoD;
  return tuning;
}
