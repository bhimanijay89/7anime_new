export type NetworkProfile = 'slow' | 'normal' | 'fast' | 'unstable';

export interface NetworkConnectionHint {
  effectiveType?: string;
  downlinkMbps?: number;
  rttMs?: number;
  saveData?: boolean;
}

export interface HlsRetryConfig {
  maxNumRetry: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  backoff?: 'exponential' | 'linear';
}

export interface HlsLoadPolicyConfig {
  maxTimeToFirstByteMs: number;
  maxLoadTimeMs: number;
  timeoutRetry: HlsRetryConfig | null;
  errorRetry: HlsRetryConfig | null;
}

export interface HlsAdaptiveConfig {
  enableWorker: boolean;
  lowLatencyMode: boolean;
  progressive: boolean;
  startLevel: number;
  startFragPrefetch: boolean;
  capLevelToPlayerSize: boolean;
  abrBandWidthFactor: number;
  abrBandWidthUpFactor: number;
  abrEwmaDefaultEstimate: number;
  abrEwmaFastVoD: number;
  abrEwmaSlowVoD: number;
  maxBufferLength: number;
  maxMaxBufferLength: number;
  maxBufferSize: number;
  maxBufferHole: number;
  backBufferLength: number;
  fragLoadPolicy: { default: HlsLoadPolicyConfig };
  manifestLoadPolicy: { default: HlsLoadPolicyConfig };
  playlistLoadPolicy: { default: HlsLoadPolicyConfig };
}

export interface HlsProfileTuning {
  profile: NetworkProfile;
  targetBufferSec: number;
  maxBufferLength: number;
  maxMaxBufferLength: number;
  maxBufferSize: number;
  abrBandWidthFactor: number;
  abrBandWidthUpFactor: number;
  abrEwmaDefaultEstimate: number;
  abrEwmaFastVoD: number;
  abrEwmaSlowVoD: number;
}

export interface HlsLevelInfo {
  index: number;
  width: number;
  height: number;
  bitrate: number;
  frameRate: number;
  codecs: string;
  name: string;
  label: string;
}

export interface BufferSnapshot {
  bufferAheadSec: number;
  bufferBehindSec: number;
  currentTimeSec: number;
  durationSec: number;
  rangesCount: number;
  isStalled: boolean;
  nearEnd: boolean;
  targetBufferSec: number;
}

export interface NetworkSnapshot {
  smoothedBandwidthBps: number;
  ewmaFastBps: number;
  ewmaSlowBps: number;
  lastSampleBps: number;
  lastTtfbMs: number | null;
  sampleCount: number;
  recentFailureRate: number;
  unstableScore: number;
}

export interface QualityState {
  levels: HlsLevelInfo[];
  autoMode: boolean;
  selectedLevel: number;
  activeLevel: number;
  maxAutoLevel: number;
  autoLevelCapping: number;
}

export type RecoveryClassification =
  | 'expired_url'
  | 'network_transient'
  | 'media_decode'
  | 'fatal_unrecoverable';

export interface RecoveryAction {
  action: 're_resolve' | 'retry_load' | 'recover_media' | 'swap_audio_and_recover' | 'fail';
  delayMs: number;
  reason: string;
  classification: RecoveryClassification;
  attempt: number;
  maxAttempts: number;
}

export interface HlsFragmentStats {
  aborted?: boolean;
  loaded?: number;
  total?: number;
  retry?: number;
  bwEstimate?: number;
  loading?: {
    start?: number;
    first?: number;
    end?: number;
  };
}

export interface HlsRawLevel {
  width?: number;
  height?: number;
  bitrate?: number;
  frameRate?: number;
  codecs?: string;
  name?: string;
}

export interface HlsFragPayload {
  frag?: {
    sn?: number | string;
    level?: number;
    url?: string;
    stats?: HlsFragmentStats;
  };
  payload?: ArrayBuffer;
  stats?: HlsFragmentStats;
}

export interface HlsErrorPayload {
  fatal?: boolean;
  type?: string;
  details?: string;
  reason?: string;
  url?: string;
  error?: { message?: string };
  response?: {
    code?: number;
    text?: string;
    url?: string;
  };
  frag?: {
    sn?: number | string;
    level?: number;
    url?: string;
  };
}

export interface HlsManifestParsedPayload {
  levels?: HlsRawLevel[];
  firstLevel?: number;
}

export interface HlsLevelSwitchedPayload {
  level?: number;
}

export interface HlsInstanceLike {
  config: Partial<HlsAdaptiveConfig> & Record<string, unknown>;
  levels: HlsRawLevel[];
  currentLevel: number;
  nextLevel: number;
  loadLevel: number;
  nextLoadLevel: number;
  nextAutoLevel: number;
  autoLevelCapping: number;
  capLevelToPlayerSize: boolean;
  maxAutoLevel: number;
  readonly autoLevelEnabled: boolean;
  readonly bandwidthEstimate: number;
  readonly ttfbEstimate?: number;
  loadSource: (url: string) => void;
  attachMedia: (media: HTMLMediaElement) => void;
  detachMedia?: () => void;
  destroy: () => void;
  startLoad: (startPosition?: number, skipSeekToStartPosition?: boolean) => void;
  stopLoad?: () => void;
  recoverMediaError: () => void;
  swapAudioCodec?: () => void;
  on: <T = unknown>(event: string, callback: (event: string, data: T) => void) => void;
  off?: <T = unknown>(event: string, callback: (event: string, data: T) => void) => void;
}

export interface HlsConstructorLike {
  new (config?: Partial<HlsAdaptiveConfig>): HlsInstanceLike;
  isSupported: () => boolean;
  version?: string;
  Events: {
    ERROR: string;
    MANIFEST_PARSED: string;
    LEVEL_SWITCHED: string;
    FRAG_LOADING: string;
    FRAG_LOADED: string;
    FRAG_BUFFERED: string;
    BUFFER_APPENDED: string;
    STALL_RESOLVED?: string;
  };
  ErrorTypes: {
    NETWORK_ERROR: string;
    MEDIA_ERROR: string;
    KEY_SYSTEM_ERROR?: string;
    MUX_ERROR?: string;
    OTHER_ERROR?: string;
  };
  ErrorDetails?: Record<string, string>;
}

export interface PlaybackTelemetryEvent {
  atMs: number;
  type: string;
  detail: string;
}

export interface PlaybackTelemetrySnapshot {
  engine: 'hlsjs' | 'native' | 'idle';
  sourceOrigin: string | null;
  resolutionLatencyMs: number | null;
  timeToFirstPlayableMs: number | null;
  timeToFirstFrameMs: number | null;
  startupMs: number | null;
  segmentThroughputBps: number;
  hlsBandwidthEstimateBps: number | null;
  avgBufferAheadSec: number;
  currentBufferAheadSec: number;
  currentBufferBehindSec: number;
  rebufferCount: number;
  totalRebufferMs: number;
  qualitySwitchCount: number;
  droppedFrames: number;
  totalVideoFrames: number;
  fatalErrorCount: number;
  recoveryAttemptCount: number;
  activeProfile: NetworkProfile;
  activeLevelIndex: number;
  activeLevelHeight: number | null;
  recentEvents: PlaybackTelemetryEvent[];
}
