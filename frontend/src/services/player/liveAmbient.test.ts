import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AMBIENT_LIMITS,
  DEFAULT_AMBIENT_LAYOUTS,
  DEFAULT_AMBIENT_SETTINGS,
  getCurrentPlayerLayout,
  isAmbientActiveForLayout,
  isAmbientAllLayoutsEnabled,
  normalizeAmbientSettings,
  toWebAmbilightSettings,
} from './ambientSettings.ts';

test('normalizeAmbientSettings enforces full reference range 0-100% blur, 0-400% spread, and 0-2000ms fade', () => {
  const defaults = normalizeAmbientSettings(undefined, undefined);
  assert.deepEqual(defaults, DEFAULT_AMBIENT_SETTINGS);
  assert.equal(AMBIENT_LIMITS.spread.max, 400);

  const clamped = normalizeAmbientSettings({
    enabled: true,
    blur: 140,
    spread: 450,
    fadeDuration: -50,
    enabledLayouts: { small: true, theater: false, fullscreen: true },
  });
  assert.equal(clamped.blur, 100);
  assert.equal(clamped.spread, 400);
  assert.equal(clamped.fadeDuration, 0);
  assert.deepEqual(clamped.enabledLayouts, {
    small: true,
    theater: false,
    fullscreen: true,
  });

  const zeroBlur = normalizeAmbientSettings({ blur: 0, spread: 400, fadeDuration: 2000 });
  assert.equal(zeroBlur.blur, 0);
  assert.equal(zeroBlur.spread, 400);
  assert.equal(zeroBlur.fadeDuration, 2000);
});

test('layout visibility respects small, theater, and fullscreen modes independently', () => {
  assert.equal(getCurrentPlayerLayout({ isFullscreen: false, theaterMode: false }), 'small');
  assert.equal(getCurrentPlayerLayout({ isFullscreen: false, theaterMode: true }), 'theater');
  assert.equal(getCurrentPlayerLayout({ isFullscreen: true, theaterMode: true }), 'fullscreen');
  assert.equal(isAmbientAllLayoutsEnabled(DEFAULT_AMBIENT_LAYOUTS), true);

  const theaterDisabled = normalizeAmbientSettings({
    enabled: true,
    enabledLayouts: { small: true, theater: false, fullscreen: true },
  });
  assert.equal(isAmbientAllLayoutsEnabled(theaterDisabled.enabledLayouts), false);
  assert.equal(isAmbientActiveForLayout(theaterDisabled, { isFullscreen: false, theaterMode: false }), true);
  assert.equal(isAmbientActiveForLayout(theaterDisabled, { isFullscreen: false, theaterMode: true }), false);
  assert.equal(isAmbientActiveForLayout(theaterDisabled, { isFullscreen: true, theaterMode: false }), true);

  const disabledMaster = normalizeAmbientSettings({ enabled: false }, false);
  assert.equal(isAmbientActiveForLayout(disabledMaster, { isFullscreen: false, theaterMode: false }), false);
});

test('toWebAmbilightSettings maps 7Anime AmbientSettings to reference web engine payload', () => {
  const settings = normalizeAmbientSettings({
    enabled: true,
    blur: 32.5,
    spread: 360,
    fadeDuration: 650,
    enabledLayouts: { small: true, theater: true, fullscreen: false },
  });

  const mappedActive = toWebAmbilightSettings(settings, true);
  assert.deepEqual(mappedActive, {
    enabled: true,
    blur: 32.5,
    spread: 360,
    fadeDurationMs: 650,
    enabledLayouts: { small: true, theater: true, fullscreen: false },
  });

  const mappedOff = toWebAmbilightSettings(settings, false);
  assert.equal(mappedOff.enabled, false);
});
