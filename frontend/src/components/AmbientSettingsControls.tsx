import React from 'react';
import { RotateCcw } from 'lucide-react';
import { useApp } from '@/src/context/AppContext';
import {
  AMBIENT_LIMITS,
  DEFAULT_AMBIENT_SETTINGS,
  isAmbientAllLayoutsEnabled,
  normalizeAmbientSettings,
} from '@/src/services/player/ambientSettings';
import type { AmbientLayoutMode } from '@/src/types/settings';

interface AmbientSettingsControlsProps {
  variant?: 'card' | 'popover';
}

const VIEW_MODE_OPTIONS: { id: AmbientLayoutMode; label: string }[] = [
  { id: 'small', label: 'Small' },
  { id: 'theater', label: 'Theater' },
  { id: 'fullscreen', label: 'Fullscreen' },
];

/**
 * Shared controls for Blur, Spread, Fade duration, and View modes backed by
 * AppContext playerPrefs.ambientSettings. Leaves the player's single master
 * Ambient mode toggle owned by the Watch toolbar.
 */
export const AmbientSettingsControls: React.FC<AmbientSettingsControlsProps> = ({
  variant = 'card',
}) => {
  const { playerPrefs, setPlayerPrefs } = useApp();
  const ambient = playerPrefs.ambientSettings ?? DEFAULT_AMBIENT_SETTINGS;
  const allViewsActive = isAmbientAllLayoutsEnabled(ambient.enabledLayouts);

  const updateAmbient = (patch: Partial<typeof ambient>) => {
    setPlayerPrefs((prev) => {
      const current = prev.ambientSettings ?? DEFAULT_AMBIENT_SETTINGS;
      const merged = normalizeAmbientSettings(
        {
          ...current,
          ...patch,
          enabled: prev.ambientMode,
        },
        prev.ambientMode
      );
      return {
        ...prev,
        ambientMode: merged.enabled,
        ambientSettings: merged,
      };
    });
  };

  const toggleAllViews = () => {
    updateAmbient({
      enabledLayouts: {
        small: true,
        theater: true,
        fullscreen: true,
      },
    });
  };

  const toggleSingleView = (mode: AmbientLayoutMode) => {
    const nextLayouts = {
      ...ambient.enabledLayouts,
      [mode]: !ambient.enabledLayouts[mode],
    };
    if (!nextLayouts.small && !nextLayouts.theater && !nextLayouts.fullscreen) {
      nextLayouts[mode] = true;
    }
    updateAmbient({ enabledLayouts: nextLayouts });
  };

  const isCompact = variant === 'popover';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: isCompact ? 12 : 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: isCompact ? 13 : 15.5, fontWeight: 650 }}>
            Ambient light
          </h3>
          {!isCompact && (
            <div style={{ fontSize: 12.5, color: 'rgb(var(--c-text2))', marginTop: 3 }}>
              Real-time WebGL edge lighting powered by the current video frame
            </div>
          )}
        </div>
        <button
          type="button"
          className="watch-pill"
          style={{ height: 28, padding: '0 10px', fontSize: 11.5 }}
          title="Reset ambient controls to defaults"
          onClick={() =>
            updateAmbient({
              blur: DEFAULT_AMBIENT_SETTINGS.blur,
              spread: DEFAULT_AMBIENT_SETTINGS.spread,
              fadeDuration: DEFAULT_AMBIENT_SETTINGS.fadeDuration,
              enabledLayouts: { ...DEFAULT_AMBIENT_SETTINGS.enabledLayouts },
            })
          }
        >
          <RotateCcw size={12} />
          <span>Reset</span>
        </button>
      </div>

      {/* Blur (0-100%) */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: isCompact ? 12 : 13.5 }}>
          <span style={{ fontWeight: 600 }}>Blur</span>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
            {ambient.blur}%
          </strong>
        </div>
        <input
          type="range"
          min={AMBIENT_LIMITS.blur.min}
          max={AMBIENT_LIMITS.blur.max}
          step={AMBIENT_LIMITS.blur.step}
          value={ambient.blur}
          aria-label="Ambient light blur"
          onChange={(e) => updateAmbient({ blur: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
      </label>

      {/* Spread (0-400%) */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: isCompact ? 12 : 13.5 }}>
          <span style={{ fontWeight: 600 }}>Spread</span>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
            {ambient.spread}%
          </strong>
        </div>
        <input
          type="range"
          min={AMBIENT_LIMITS.spread.min}
          max={AMBIENT_LIMITS.spread.max}
          step={AMBIENT_LIMITS.spread.step}
          value={ambient.spread}
          aria-label="Ambient light spread"
          onChange={(e) => updateAmbient({ spread: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
      </label>

      {/* Fade duration (0-2000ms) */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: isCompact ? 12 : 13.5 }}>
          <span style={{ fontWeight: 600 }}>Fade duration</span>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
            {ambient.fadeDuration <= 0 ? 'Off' : `${ambient.fadeDuration} ms`}
          </strong>
        </div>
        <input
          type="range"
          min={AMBIENT_LIMITS.fadeDuration.min}
          max={AMBIENT_LIMITS.fadeDuration.max}
          step={AMBIENT_LIMITS.fadeDuration.step}
          value={ambient.fadeDuration}
          aria-label="Ambient light fade duration"
          onChange={(e) => updateAmbient({ fadeDuration: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
      </label>

      {/* View modes */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: isCompact ? 12 : 13.5 }}>
          <span style={{ fontWeight: 600 }}>View modes</span>
          <span style={{ fontSize: 11.5, color: 'rgb(var(--c-text2))' }}>
            {allViewsActive
              ? 'All views'
              : VIEW_MODE_OPTIONS.filter((v) => ambient.enabledLayouts[v.id])
                  .map((v) => v.label)
                  .join(' · ')}
          </span>
        </div>
        <div className="watch-audio-switch" style={{ width: '100%', justifyContent: 'space-between' }}>
          <button
            type="button"
            aria-pressed={allViewsActive}
            onClick={toggleAllViews}
            style={{ flex: '0.85 1 auto', justifyContent: 'center', fontSize: isCompact ? 11.5 : 12, padding: '0 8px' }}
          >
            All
          </button>
          {VIEW_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              aria-pressed={ambient.enabledLayouts[opt.id]}
              onClick={() => toggleSingleView(opt.id)}
              style={{
                flex: opt.id === 'fullscreen' ? '1.35 1 auto' : '1 1 auto',
                justifyContent: 'center',
                fontSize: isCompact ? 11.5 : 12,
                padding: '0 8px',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
