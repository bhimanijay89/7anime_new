import type { HlsConstructorLike } from './types.ts';

export const HLS_CDN_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js';
const DEFAULT_SCRIPT_TIMEOUT_MS = 12_000;

declare global {
  interface Window {
    Hls?: HlsConstructorLike;
  }
}

let hlsScriptPromise: Promise<void> | null = null;

/**
 * Dynamically loads hls.js 1.6.15 from CDN once and shares the in-flight promise.
 * Resets cached promise on failure so manual or automatic retries can recover.
 */
export function loadHlsLibrary(timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('HLS playback requires a browser environment.'));
  }

  if (window.Hls) return Promise.resolve();
  if (hlsScriptPromise) return hlsScriptPromise;

  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: number | null = null;

    const cleanup = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (window.Hls) {
        resolve();
      } else {
        reject(new Error('HLS library loaded without exposing window.Hls.'));
      }
    };

    const finishReject = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    timer = window.setTimeout(() => {
      finishReject('Timed out while loading HLS playback engine.');
    }, timeoutMs);

    const existing = document.querySelector<HTMLScriptElement>('script[data-hlsjs-loader]');
    if (existing) {
      if (existing.dataset.hlsjsFailed === 'true') {
        existing.remove();
      } else if (window.Hls) {
        finishResolve();
        return;
      } else {
        existing.addEventListener('load', finishResolve, { once: true });
        existing.addEventListener(
          'error',
          () => finishReject('Unable to load HLS playback engine.'),
          { once: true }
        );
        return;
      }
    }

    const script = document.createElement('script');
    script.src = HLS_CDN_URL;
    script.async = true;
    script.dataset.hlsjsLoader = 'true';
    script.addEventListener('load', finishResolve, { once: true });
    script.addEventListener(
      'error',
      () => {
        script.dataset.hlsjsFailed = 'true';
        finishReject('Unable to load HLS playback engine.');
      },
      { once: true }
    );
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    hlsScriptPromise = null;
    throw error;
  });

  hlsScriptPromise = promise;
  return promise;
}

export function canPlayNativeHls(video: HTMLMediaElement): boolean {
  if (typeof video.canPlayType !== 'function') return false;
  return Boolean(
    video.canPlayType('application/vnd.apple.mpegurl') ||
      video.canPlayType('application/x-mpegURL')
  );
}
