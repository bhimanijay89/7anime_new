import type {
  BufferSnapshot,
  HlsInstanceLike,
  HlsLevelInfo,
  HlsRawLevel,
  NetworkProfile,
  NetworkSnapshot,
  QualityState,
} from './types.ts';

const EMERGENCY_DOWNSHIFT_COOLDOWN_MS = 6_000;

export function formatLevelLabel(level: HlsRawLevel, index: number): string {
  if (typeof level.height === 'number' && level.height > 0) {
    const fpsSuffix =
      typeof level.frameRate === 'number' && level.frameRate >= 50
        ? ` ${Math.round(level.frameRate)}fps`
        : '';
    return `${level.height}p${fpsSuffix}`;
  }
  if (typeof level.name === 'string' && level.name.trim()) {
    return level.name.trim();
  }
  if (typeof level.bitrate === 'number' && level.bitrate > 0) {
    return `${Math.round(level.bitrate / 1000)} kbps`;
  }
  return `Level ${index + 1}`;
}

export function normalizeHlsLevels(rawLevels: readonly HlsRawLevel[]): HlsLevelInfo[] {
  return rawLevels.map((lvl, index) => ({
    index,
    width: typeof lvl.width === 'number' ? lvl.width : 0,
    height: typeof lvl.height === 'number' ? lvl.height : 0,
    bitrate: typeof lvl.bitrate === 'number' ? lvl.bitrate : 0,
    frameRate: typeof lvl.frameRate === 'number' ? lvl.frameRate : 0,
    codecs: typeof lvl.codecs === 'string' ? lvl.codecs : '',
    name: typeof lvl.name === 'string' ? lvl.name : '',
    label: formatLevelLabel(lvl, index),
  }));
}

export interface QualitySelectionResult {
  applied: boolean;
  selectedLevel: number;
  warning: string | null;
}

/**
 * Manages automatic ABR capping, safe emergency downshifts, and non-disruptive
 * manual quality switches without recreating the Hls instance.
 */
export class QualityController {
  private levels: HlsLevelInfo[] = [];
  private selectedLevel = -1;
  private activeLevel = -1;
  private lastEmergencyDownshiftMs = 0;

  setLevels(rawLevels: readonly HlsRawLevel[], initialLevel = -1): QualityState {
    this.levels = normalizeHlsLevels(rawLevels);
    this.selectedLevel = -1;
    this.activeLevel = initialLevel;
    return this.getState(null);
  }

  onLevelSwitched(levelIndex: number, hls?: HlsInstanceLike | null): QualityState {
    this.activeLevel = levelIndex;
    return this.getState(hls ?? null);
  }

  selectQuality(
    hls: HlsInstanceLike | null,
    levelIndex: number,
    options: {
      network?: NetworkSnapshot;
      bufferAheadSec?: number;
      allowCapToPlayerSize?: boolean;
    } = {}
  ): QualitySelectionResult {
    if (!hls || this.levels.length === 0) {
      return { applied: false, selectedLevel: -1, warning: null };
    }

    if (levelIndex < 0) {
      this.selectedLevel = -1;
      hls.capLevelToPlayerSize = options.allowCapToPlayerSize ?? true;
      hls.autoLevelCapping = -1;
      hls.nextLevel = -1;
      hls.loadLevel = -1;
      return { applied: true, selectedLevel: -1, warning: null };
    }

    const target = this.levels.find((lvl) => lvl.index === levelIndex);
    if (!target) {
      return { applied: false, selectedLevel: this.selectedLevel, warning: null };
    }

    let warning: string | null = null;
    const measuredBps = options.network?.smoothedBandwidthBps ?? 0;
    if (
      measuredBps > 0 &&
      target.bitrate > 0 &&
      options.network &&
      options.network.sampleCount >= 2 &&
      target.bitrate > measuredBps * 1.4
    ) {
      warning = `${target.label} exceeds estimated bandwidth; playback may buffer.`;
    }

    this.selectedLevel = target.index;
    hls.capLevelToPlayerSize = false;

    // Switch at next segment boundary when forward buffer exists to avoid flushing and stalling playback.
    if ((options.bufferAheadSec ?? 0) >= 4) {
      hls.nextLevel = target.index;
    } else {
      hls.currentLevel = target.index;
    }

    return { applied: true, selectedLevel: target.index, warning };
  }

  /**
   * Nudges ABR down smoothly during buffer starvation or unstable playback without locking manual choice.
   */
  applyAdaptiveGuidance(
    hls: HlsInstanceLike | null,
    profile: NetworkProfile,
    network: NetworkSnapshot,
    buffer: BufferSnapshot,
    nowMs: number
  ): void {
    if (!hls || this.levels.length <= 1) return;
    if (this.selectedLevel !== -1 || !hls.autoLevelEnabled) return;

    // Never cap away the lowest level (index 0).
    if (profile === 'unstable' && network.sampleCount >= 2 && network.smoothedBandwidthBps > 0) {
      const safeCap = this.findHighestFittingLevel(network.smoothedBandwidthBps * 0.85);
      hls.autoLevelCapping = safeCap;
    } else if (profile === 'slow' && network.sampleCount >= 2 && network.smoothedBandwidthBps > 0) {
      const safeCap = this.findHighestFittingLevel(network.smoothedBandwidthBps * 0.95);
      hls.autoLevelCapping = safeCap;
    } else {
      hls.autoLevelCapping = -1;
    }

    const currentIdx = this.activeLevel >= 0 ? this.activeLevel : hls.currentLevel;
    if (
      currentIdx > 0 &&
      !buffer.nearEnd &&
      buffer.bufferAheadSec > 0 &&
      buffer.bufferAheadSec < 3.5 &&
      nowMs - this.lastEmergencyDownshiftMs >= EMERGENCY_DOWNSHIFT_COOLDOWN_MS
    ) {
      this.lastEmergencyDownshiftMs = nowMs;
      hls.nextAutoLevel = Math.max(0, currentIdx - 1);
    }
  }

  reset(): void {
    this.levels = [];
    this.selectedLevel = -1;
    this.activeLevel = -1;
    this.lastEmergencyDownshiftMs = 0;
  }

  getState(hls: HlsInstanceLike | null): QualityState {
    return {
      levels: this.levels,
      autoMode: this.selectedLevel === -1,
      selectedLevel: this.selectedLevel,
      activeLevel: this.activeLevel,
      maxAutoLevel: hls ? hls.maxAutoLevel : this.levels.length - 1,
      autoLevelCapping: hls ? hls.autoLevelCapping : -1,
    };
  }

  private findHighestFittingLevel(budgetBps: number): number {
    if (this.levels.length === 0) return -1;
    let bestIndex = 0;
    let bestBitrate = -1;
    for (const lvl of this.levels) {
      if (lvl.bitrate > 0 && lvl.bitrate <= budgetBps && lvl.bitrate >= bestBitrate) {
        bestBitrate = lvl.bitrate;
        bestIndex = lvl.index;
      }
    }
    return bestIndex;
  }
}
