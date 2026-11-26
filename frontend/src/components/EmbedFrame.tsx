import React, { useEffect, useRef } from 'react';
import type { ResolvedEmbedResult } from '@/src/services/player';

export interface EmbedFrameProps {
  resolved: ResolvedEmbedResult;
  title: string;
  reloadKey: number;
  onLoad?: () => void;
  onError?: () => void;
}

interface HlsInstance {
  loadSource: (url: string) => void;
  attachMedia: (media: HTMLMediaElement) => void;
  destroy: () => void;
  startLoad: () => void;
  recoverMediaError: () => void;
  on: (event: string, callback: (_event: string, data: { fatal?: boolean; type?: string }) => void) => void;
}

interface HlsConstructor {
  new (config?: Record<string, unknown>): HlsInstance;
  isSupported: () => boolean;
  Events: { ERROR: string; MANIFEST_PARSED: string };
  ErrorTypes: { NETWORK_ERROR: string; MEDIA_ERROR: string };
}

declare global {
  interface Window {
    Hls?: HlsConstructor;
  }
}

let hlsScriptPromise: Promise<void> | null = null;

function loadHlsLibrary(): Promise<void> {
  if (window.Hls) return Promise.resolve();
  if (hlsScriptPromise) return hlsScriptPromise;

  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-hlsjs-loader]');
    if (existing) {
      existing.addEventListener('load', () => resolve(undefined), { once: true });
      existing.addEventListener('error', () => reject(new Error('Unable to load HLS playback engine.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js';
    script.async = true;
    script.dataset.hlsjsLoader = 'true';
    script.onload = () => resolve(undefined);
    script.onerror = () => reject(new Error('Unable to load HLS playback engine.'));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    hlsScriptPromise = null;
    throw error;
  });

  hlsScriptPromise = promise;
  return promise;
}

export const EmbedFrame: React.FC<EmbedFrameProps> = ({ resolved, title, reloadKey, onLoad, onError }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    const source = resolved.hlsProxyUrl || resolved.embedUrl;
    if (!video || !resolved.ok || !source) return;

    let disposed = false;
    let hls: HlsInstance | null = null;

    const handleLoaded = () => onLoad?.();
    const handleVideoError = () => onError?.();
    video.addEventListener('loadeddata', handleLoaded);
    video.addEventListener('error', handleVideoError);

    const start = async () => {
      // Prefer hls.js on browsers with MediaSource. Some Android browsers report
      // native HLS support but fail to load provider playlists through it.
      try {
        await loadHlsLibrary();
      } catch (error) {
        console.warn('[AniVault HLS] hls.js could not be loaded; trying native HLS:', error);
      }
      if (disposed) return;
      const Hls = window.Hls;

      if (Hls?.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 30,
          manifestLoadingTimeOut: 20000,
          levelLoadingTimeOut: 20000,
          fragLoadingTimeOut: 30000,
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || disposed || !hls) return;
          console.error('[AniVault HLS] Fatal playback error:', data);
          // Match the API tester's recovery behavior: transient playlist/segment
          // network failures and decode errors should recover before failing the player.
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          onError?.();
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // Let browser autoplay policy decide; controls remain available if blocked.
          video.play().catch(() => {});
        });
        hls.attachMedia(video);
        hls.loadSource(source);
        return;
      }

      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = source;
        video.load();
        return;
      }

      throw new Error('This browser does not support HLS playback.');
    };

    start().catch((error) => {
      console.error('[AniVault HLS] Playback initialization failed:', error);
      if (!disposed) onError?.();
    });

    return () => {
      disposed = true;
      video.removeEventListener('loadeddata', handleLoaded);
      video.removeEventListener('error', handleVideoError);
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [resolved.ok, resolved.hlsProxyUrl, resolved.embedUrl, reloadKey, onLoad, onError]);

  if (!resolved.ok || !(resolved.hlsProxyUrl || resolved.embedUrl)) return null;

  return (
    <video
      key={reloadKey}
      ref={videoRef}
      className="glassplayer__embed-iframe"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        border: 0,
        background: '#06070b',
        zIndex: 1,
        objectFit: 'contain',
      }}
      controls
      crossOrigin="anonymous"
      playsInline
      preload="metadata"
      aria-label={title}
    >
      {(resolved.subtitles || []).map((track, index) => (
        <track
          key={track.url || track.src || index}
          kind="subtitles"
          src={track.url || track.src}
          srcLang={track.lang || 'und'}
          label={track.label}
          default={Boolean(track.default)}
        />
      ))}
    </video>
  );
};

EmbedFrame.displayName = 'EmbedFrame';
