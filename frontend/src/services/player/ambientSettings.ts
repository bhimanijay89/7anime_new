import type {
  AmbientEnabledLayouts,
  AmbientLayoutMode,
  AmbientSettings,
} from '@/src/types/settings';
import type { WebAmbilightSettingsInput } from 'youtube-ambientlight';

export const AMBIENT_LIMITS = {
  blur: { min: 0, max: 100, step: 0.5, defaultValue: 15.5 },
  spread: { min: 0, max: 400, step: 1, defaultValue: 155 },
  fadeDuration: { min: 0, max: 2000, step: 1, defaultValue: 497 },
} as const;

export const DEFAULT_AMBIENT_LAYOUTS: AmbientEnabledLayouts = {
  small: true,
  theater: true,
  fullscreen: true,
};

export const DEFAULT_AMBIENT_SETTINGS: AmbientSettings = {
  enabled: true,
  blur: AMBIENT_LIMITS.blur.defaultValue,
  spread: AMBIENT_LIMITS.spread.defaultValue,
  fadeDuration: AMBIENT_LIMITS.fadeDuration.defaultValue,
  enabledLayouts: { ...DEFAULT_AMBIENT_LAYOUTS },
};

function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function normalizeAmbientSettings(
  raw?: Partial<AmbientSettings> | null,
  legacyAmbientMode?: boolean
): AmbientSettings {
  const baseEnabled =
    typeof raw?.enabled === 'boolean'
      ? raw.enabled
      : typeof legacyAmbientMode === 'boolean'
        ? legacyAmbientMode
        : DEFAULT_AMBIENT_SETTINGS.enabled;

  const rawLayouts = raw?.enabledLayouts;
  return {
    enabled: baseEnabled,
    blur:
      Math.round(
        clampFinite(
          raw?.blur,
          AMBIENT_LIMITS.blur.min,
          AMBIENT_LIMITS.blur.max,
          DEFAULT_AMBIENT_SETTINGS.blur
        ) * 10
      ) / 10,
    spread: Math.round(
      clampFinite(
        raw?.spread,
        AMBIENT_LIMITS.spread.min,
        AMBIENT_LIMITS.spread.max,
        DEFAULT_AMBIENT_SETTINGS.spread
      )
    ),
    fadeDuration: Math.round(
      clampFinite(
        raw?.fadeDuration,
        AMBIENT_LIMITS.fadeDuration.min,
        AMBIENT_LIMITS.fadeDuration.max,
        DEFAULT_AMBIENT_SETTINGS.fadeDuration
      )
    ),
    enabledLayouts: {
      small:
        typeof rawLayouts?.small === 'boolean'
          ? rawLayouts.small
          : DEFAULT_AMBIENT_LAYOUTS.small,
      theater:
        typeof rawLayouts?.theater === 'boolean'
          ? rawLayouts.theater
          : DEFAULT_AMBIENT_LAYOUTS.theater,
      fullscreen:
        typeof rawLayouts?.fullscreen === 'boolean'
          ? rawLayouts.fullscreen
          : DEFAULT_AMBIENT_LAYOUTS.fullscreen,
    },
  };
}

export function getCurrentPlayerLayout(state: {
  isFullscreen: boolean;
  theaterMode: boolean;
}): AmbientLayoutMode {
  if (state.isFullscreen) return 'fullscreen';
  if (state.theaterMode) return 'theater';
  return 'small';
}

export function isAmbientAllLayoutsEnabled(layouts: AmbientEnabledLayouts): boolean {
  return layouts.small && layouts.theater && layouts.fullscreen;
}

export function isAmbientActiveForLayout(
  settings: AmbientSettings,
  state: { isFullscreen: boolean; theaterMode: boolean }
): boolean {
  if (!settings.enabled) return false;
  const activeLayout = getCurrentPlayerLayout(state);
  return Boolean(settings.enabledLayouts[activeLayout]);
}

export function toWebAmbilightSettings(
  settings: AmbientSettings,
  masterEnabled: boolean
): WebAmbilightSettingsInput {
  return {
    enabled: Boolean(masterEnabled && settings.enabled),
    blur: settings.blur,
    spread: settings.spread,
    fadeDurationMs: settings.fadeDuration,
    enabledLayouts: settings.enabledLayouts,
  };
}
