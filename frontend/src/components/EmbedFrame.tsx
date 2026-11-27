import React, { useCallback, useEffect, useRef } from 'react';
import type { ResolvedEmbedResult } from '@/src/services/player';
import {
  createHlsPlaybackController,
  type HlsPlaybackControllerHandle,
  type PlaybackTelemetrySnapshot,
  type QualityState,
} from '@/src/services/player/hls';

export interface EmbedFrameProps {
  resolved: ResolvedEmbedResult;
  title: string;
  reloadKey: number;
  autoplay?: boolean;
  resumePositionSec?: number;
  controllerRef?: React.MutableRefObject<HlsPlaybackControllerHandle | null>;
  onLoad?: () => void;
  onError?: (reason?: string) => void;
  onStreamExpired?: (resumeAtSec: number, reason: string) => void;
  onQualityStateChange?: (state: QualityState) => void;
  onQualityWarning?: (warning: string) => void;
  onTelemetryChange?: (snapshot: PlaybackTelemetrySnapshot) => void;
  onVideoElement?: (video: HTMLVideoElement | null) => void;
}

export const EmbedFrame: React.FC<EmbedFrameProps> = ({
  resolved,
  title,
  reloadKey,
  autoplay = true,
  resumePositionSec = 0,
  controllerRef,
  onLoad,
  onError,
  onStreamExpired,
  onQualityStateChange,
  onQualityWarning,
  onTelemetryChange,
  onVideoElement,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const autoplayRef = useRef(autoplay);
  const resumePosRef = useRef(resumePositionSec);
  const onLoadRef = useRef(onLoad);
  const onErrorRef = useRef(onError);
  const onStreamExpiredRef = useRef(onStreamExpired);
  const onQualityStateChangeRef = useRef(onQualityStateChange);
  const onQualityWarningRef = useRef(onQualityWarning);
  const onTelemetryChangeRef = useRef(onTelemetryChange);
  const onVideoElementRef = useRef(onVideoElement);

  useEffect(() => {
    autoplayRef.current = autoplay;
    resumePosRef.current = resumePositionSec;
    onLoadRef.current = onLoad;
    onErrorRef.current = onError;
    onStreamExpiredRef.current = onStreamExpired;
    onQualityStateChangeRef.current = onQualityStateChange;
    onQualityWarningRef.current = onQualityWarning;
    onTelemetryChangeRef.current = onTelemetryChange;
    onVideoElementRef.current = onVideoElement;
  });

  const handleVideoRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    onVideoElementRef.current?.(node);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const source = resolved.hlsProxyUrl || resolved.embedUrl;
    if (!video || !resolved.ok || !source) return;

    const controller = createHlsPlaybackController({
      video,
      source,
      autoplay: autoplayRef.current,
      resumePositionSec: resumePosRef.current,
      resolutionLatencyMs: resolved.resolutionLatencyMs ?? null,
      onLoad: () => onLoadRef.current?.(),
      onError: (reason) => onErrorRef.current?.(reason),
      onStreamExpired: (resumeAtSec, reason) =>
        onStreamExpiredRef.current?.(resumeAtSec, reason),
      onQualityStateChange: (state) => onQualityStateChangeRef.current?.(state),
      onQualityWarning: (warning) => onQualityWarningRef.current?.(warning),
      onTelemetryChange: (snapshot) => onTelemetryChangeRef.current?.(snapshot),
    });

    if (controllerRef) {
      controllerRef.current = controller;
    }

    controller.start().catch((error) => {
      console.error('[AniVault HLS] Playback initialization failed:', error);
      onErrorRef.current?.(
        error instanceof Error ? error.message : 'Unable to initialize HLS playback.'
      );
    });

    return () => {
      if (controllerRef && controllerRef.current === controller) {
        controllerRef.current = null;
      }
      controller.destroy();
    };
  }, [
    resolved.ok,
    resolved.hlsProxyUrl,
    resolved.embedUrl,
    resolved.resolutionLatencyMs,
    reloadKey,
    controllerRef,
  ]);

  if (!resolved.ok || !(resolved.hlsProxyUrl || resolved.embedUrl)) return null;

  return (
    <video
      key={reloadKey}
      ref={handleVideoRef}
      className="glassplayer__embed-iframe"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        border: 0,
        background: 'transparent',
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
