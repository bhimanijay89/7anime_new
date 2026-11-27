import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AnimeTitle, EpisodeItem } from '@/src/types/anime';
import { useApp } from '@/src/context/AppContext';
import { discordPresenceService } from '@/src/services/discordPresenceService';
import { discordPresenceCoordinator } from '@/src/services/discordPresenceCoordinator';
import {
  ORDERED_SERVER_IDS,
  SERVER_DESCRIPTORS,
  parseEmbedProgressMessage,
  type PlayerServerId,
  type ResolvedEmbedResult,
} from '@/src/services/player';
import {
  DEFAULT_AMBIENT_SETTINGS,
  isAmbientActiveForLayout,
} from '@/src/services/player/ambientSettings';
import { useLiveAmbient } from '@/src/hooks/useLiveAmbient';
import type {
  HlsPlaybackControllerHandle,
  PlaybackTelemetrySnapshot,
  QualityState,
} from '@/src/services/player/hls';
import { EmbedFrame } from './EmbedFrame';

interface GlassPlayerProps {
  anime: AnimeTitle;
  episode: EpisodeItem;
  audioMode: 'sub' | 'dub';
  server: PlayerServerId;
  resolvedEmbed: ResolvedEmbedResult;
  onRetryResolve?: () => void;
  onSelectServer?: (next: PlayerServerId) => void;
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}

const IFRAME_LOAD_TIMEOUT_MS = 24000;

export const GlassPlayer: React.FC<GlassPlayerProps> = ({
  anime,
  episode,
  audioMode,
  server,
  resolvedEmbed,
  onRetryResolve,
  onSelectServer,
  onNextEpisode,
  hasNext,
}) => {
  const { playerPrefs, privacyPrefs, logWatchProgress } = useApp();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const hlsControllerRef = useRef<HlsPlaybackControllerHandle | null>(null);
  const streamExpireRefreshCountRef = useRef<number>(0);

  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const [resumePositionSec, setResumePositionSec] = useState<number>(0);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(() =>
    typeof document !== 'undefined' ? Boolean(document.fullscreenElement) : false
  );
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [iframeError, setIframeError] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [streamErrorReason, setStreamErrorReason] = useState<string | null>(null);
  const [qualityState, setQualityState] = useState<QualityState | null>(null);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [telemetry, setTelemetry] = useState<PlaybackTelemetrySnapshot | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [osd, setOsd] = useState<string | null>(null);

  const lastLoggedRef = useRef<{ sec: number; at: number }>({ sec: -1, at: 0 });
  const hasStartedPresenceRef = useRef(false);
  const presenceSessionRef = useRef<{
    key: string;
    startTimestamp: number;
    lastPosSec: number;
    isPaused: boolean;
  }>({ key: '', startTimestamp: 0, lastPosSec: 0, isPaused: false });

  const presenceArtworkUrl = useMemo(() => {
    const candidates = [anime.poster, anime.cover, anime.banner];
    for (const raw of candidates) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (trimmed.startsWith('https://') && trimmed.length <= 256) {
        return trimmed;
      }
    }
    return undefined;
  }, [anime.poster, anime.cover, anime.banner]);

  const activeEmbedKey = useMemo(
    () => `${resolvedEmbed.serverId}::${resolvedEmbed.embedUrl ?? 'none'}::${reloadKey}`,
    [resolvedEmbed.serverId, resolvedEmbed.embedUrl, reloadKey]
  );
  const activeEmbedKeyRef = useRef(activeEmbedKey);
  useEffect(() => {
    activeEmbedKeyRef.current = activeEmbedKey;
  }, [activeEmbedKey]);

  const flashOsd = useCallback(
    (label: string) => {
      setOsd(label);
      window.setTimeout(
        () => setOsd((curr) => (curr === label ? null : curr)),
        playerPrefs.toastDurationSec * 1000
      );
    },
    [playerPrefs.toastDurationSec]
  );

  // Reset stream-expire re-resolve guards and resume position when anime/episode/server changes
  useEffect(() => {
    setResumePositionSec(0);
    streamExpireRefreshCountRef.current = 0;
  }, [anime.routeId, episode.number, server, audioMode]);

  // Reset iframe lifecycle state cleanly whenever anime, episode, server, or embed URL changes
  useEffect(() => {
    setIframeLoaded(false);
    setIframeError(false);
    setTimedOut(false);
    setProviderError(null);
    setStreamErrorReason(null);
    setQualityState(null);
    setQualityMenuOpen(false);
    lastLoggedRef.current = { sec: -1, at: 0 };

    if (!resolvedEmbed.ok || !resolvedEmbed.embedUrl) {
      return;
    }

    const capturedKey = activeEmbedKey;
    const timer = window.setTimeout(() => {
      if (activeEmbedKeyRef.current !== capturedKey) return;
      setIframeLoaded((loaded) => {
        if (!loaded) {
          setTimedOut(true);
        }
        return loaded;
      });
    }, IFRAME_LOAD_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeEmbedKey, resolvedEmbed.ok, resolvedEmbed.embedUrl]);

  // Listen to cross-origin postMessage events from the currently active iframe only
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const raw = event.data;
      if (raw && typeof raw === 'object') {
        const record = raw as Record<string, unknown>;
        if (record.source === 'animetvplus-embed') {
          if (record.type === 'ready') {
            setIframeLoaded(true);
            setTimedOut(false);
            setProviderError(null);
          } else if (record.type === 'error') {
            setIframeLoaded(true);
            setTimedOut(false);
            if (record.error === 'unknown_title') {
              setProviderError(
                `Title not found on Server 1 (AniList ID ${resolvedEmbed.resolvedIdentifiers.anilistId}). Please switch to Beta server or Backup server.`
              );
            } else if (record.error === 'no_episode') {
              setProviderError(
                `Episode ${episode.number} is not available on Server 1 yet. Please try Beta server or Backup server.`
              );
            }
          }
          return;
        }
      }

      if (!resolvedEmbed.capabilities.progressPostMessage) {
        return;
      }

      const progress = parseEmbedProgressMessage(event);
      if (!progress) return;

      setIframeLoaded(true);
      setTimedOut(false);

      const dur =
        progress.durationSeconds > 0
          ? progress.durationSeconds
          : episode.durationSec || 1440;
      const pos = Math.max(0, Math.min(dur, progress.progressSeconds));
      const now = Date.now();

      const shouldPersist =
        progress.completed ||
        progress.isPaused ||
        now - lastLoggedRef.current.at >= 10000 ||
        Math.abs(pos - lastLoggedRef.current.sec) >= 15;

      if (shouldPersist) {
        lastLoggedRef.current = { sec: pos, at: now };
        logWatchProgress(anime.routeId, episode.number, pos, dur, audioMode);
      }

      const prevSession = presenceSessionRef.current;
      const sessionKey = `${anime.routeId}::${episode.number}`;
      const isPausedNow = Boolean(progress.isPaused || progress.completed);
      const jumpedSignificantly =
        Math.abs(pos - prevSession.lastPosSec) > 4 ||
        (prevSession.isPaused && !isPausedNow);

      if (
        prevSession.key !== sessionKey ||
        prevSession.isPaused !== isPausedNow ||
        jumpedSignificantly
      ) {
        const nextStart = isPausedNow
          ? prevSession.startTimestamp
          : jumpedSignificantly || prevSession.key !== sessionKey || prevSession.startTimestamp <= 0
            ? Date.now() - Math.floor(pos * 1000)
            : prevSession.startTimestamp;

        presenceSessionRef.current = {
          key: sessionKey,
          startTimestamp: nextStart,
          lastPosSec: pos,
          isPaused: isPausedNow,
        };

        hasStartedPresenceRef.current = true;
        discordPresenceCoordinator.claimLeadership(anime.routeId);
        discordPresenceService.updatePlayback({
          animeTitle: anime.title,
          routeId: anime.routeId,
          episodeNumber: episode.number,
          seasonNumber: episode.season || 1,
          isPlaying: !isPausedNow,
          currentTimeSec: Math.floor(pos),
          durationSec: dur,
          startTimestamp: !isPausedNow ? nextStart : undefined,
          artworkUrl: presenceArtworkUrl,
          serverLabel: SERVER_DESCRIPTORS[resolvedEmbed.serverId].label,
        });
      } else {
        presenceSessionRef.current.lastPosSec = pos;
      }

      if (
        progress.completed &&
        resolvedEmbed.capabilities.autoNext &&
        playerPrefs.autoplayNext &&
        hasNext &&
        onNextEpisode
      ) {
        onNextEpisode();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [
    anime.routeId,
    anime.title,
    audioMode,
    episode.durationSec,
    episode.number,
    episode.season,
    hasNext,
    logWatchProgress,
    onNextEpisode,
    playerPrefs.autoplayNext,
    presenceArtworkUrl,
    resolvedEmbed.capabilities.autoNext,
    resolvedEmbed.capabilities.progressPostMessage,
    resolvedEmbed.resolvedIdentifiers.anilistId,
    resolvedEmbed.serverId,
  ]);

  // Synchronize Discord Rich Presence when embed stream finishes loading or server switches
  useEffect(() => {
    const blocking = !resolvedEmbed.ok || iframeError || timedOut || Boolean(providerError);
    if (blocking) {
      if (hasStartedPresenceRef.current) {
        hasStartedPresenceRef.current = false;
        discordPresenceService.clearActivity();
        discordPresenceCoordinator.releaseLeadership();
      }
      return;
    }

    if (iframeLoaded) {
      const sessionKey = `${anime.routeId}::${episode.number}`;
      const existing = presenceSessionRef.current;
      const initialPos = Math.max(0, lastLoggedRef.current.sec);
      const startTs =
        existing.key === sessionKey && existing.startTimestamp > 0
          ? existing.startTimestamp
          : Date.now() - Math.floor(initialPos * 1000);

      presenceSessionRef.current = {
        key: sessionKey,
        startTimestamp: startTs,
        lastPosSec: initialPos,
        isPaused: false,
      };

      hasStartedPresenceRef.current = true;
      discordPresenceCoordinator.claimLeadership(anime.routeId);
      discordPresenceService.updatePlayback({
        animeTitle: anime.title,
        routeId: anime.routeId,
        episodeNumber: episode.number,
        seasonNumber: episode.season || 1,
        isPlaying: true,
        currentTimeSec: Math.floor(initialPos),
        durationSec: episode.durationSec || 1440,
        startTimestamp: startTs,
        artworkUrl: presenceArtworkUrl,
        serverLabel: SERVER_DESCRIPTORS[resolvedEmbed.serverId].label,
      });
    }
  }, [
    iframeLoaded,
    resolvedEmbed.ok,
    resolvedEmbed.serverId,
    iframeError,
    timedOut,
    providerError,
    anime.title,
    anime.routeId,
    episode.number,
    episode.season,
    episode.durationSec,
    presenceArtworkUrl,
  ]);

  // Sync native HTMLVideoElement playback time, pause/resume, Rich Presence, and autoplayNext
  useEffect(() => {
    if (!videoElement || !resolvedEmbed.ok) return;

    const syncProgress = (forcePersist = false, completed = false) => {
      const rawDur =
        Number.isFinite(videoElement.duration) && videoElement.duration > 0
          ? videoElement.duration
          : episode.durationSec || 1440;
      const pos = Math.max(0, Math.min(rawDur, videoElement.currentTime || 0));
      const now = Date.now();
      const isPausedNow = Boolean(videoElement.paused || completed);

      const shouldPersist =
        forcePersist ||
        completed ||
        now - lastLoggedRef.current.at >= 10000 ||
        Math.abs(pos - lastLoggedRef.current.sec) >= 15;

      if (shouldPersist) {
        lastLoggedRef.current = { sec: pos, at: now };
        logWatchProgress(anime.routeId, episode.number, pos, rawDur, audioMode);
      }

      const prevSession = presenceSessionRef.current;
      const sessionKey = `${anime.routeId}::${episode.number}`;
      const jumped =
        Math.abs(pos - prevSession.lastPosSec) > 4 ||
        prevSession.isPaused !== isPausedNow ||
        prevSession.key !== sessionKey;

      if (jumped) {
        const nextStart = isPausedNow
          ? prevSession.startTimestamp
          : now - Math.floor(pos * 1000);

        presenceSessionRef.current = {
          key: sessionKey,
          startTimestamp: nextStart,
          lastPosSec: pos,
          isPaused: isPausedNow,
        };

        hasStartedPresenceRef.current = true;
        discordPresenceCoordinator.claimLeadership(anime.routeId);
        discordPresenceService.updatePlayback({
          animeTitle: anime.title,
          routeId: anime.routeId,
          episodeNumber: episode.number,
          seasonNumber: episode.season || 1,
          isPlaying: !isPausedNow,
          currentTimeSec: Math.floor(pos),
          durationSec: rawDur,
          startTimestamp: !isPausedNow ? nextStart : undefined,
          artworkUrl: presenceArtworkUrl,
          serverLabel: SERVER_DESCRIPTORS[resolvedEmbed.serverId].label,
        });
      } else {
        presenceSessionRef.current.lastPosSec = pos;
      }
    };

    const onPlay = () => syncProgress(false, false);
    const onPause = () => syncProgress(true, false);
    const onTimeUpdate = () => syncProgress(false, false);
    const onEnded = () => {
      syncProgress(true, true);
      if (playerPrefs.autoplayNext && hasNext && onNextEpisode) {
        onNextEpisode();
      }
    };

    videoElement.addEventListener('play', onPlay);
    videoElement.addEventListener('pause', onPause);
    videoElement.addEventListener('timeupdate', onTimeUpdate);
    videoElement.addEventListener('ended', onEnded);

    return () => {
      videoElement.removeEventListener('play', onPlay);
      videoElement.removeEventListener('pause', onPause);
      videoElement.removeEventListener('timeupdate', onTimeUpdate);
      videoElement.removeEventListener('ended', onEnded);
    };
  }, [
    videoElement,
    resolvedEmbed.ok,
    resolvedEmbed.serverId,
    anime.routeId,
    anime.title,
    episode.number,
    episode.season,
    episode.durationSec,
    audioMode,
    hasNext,
    onNextEpisode,
    playerPrefs.autoplayNext,
    presenceArtworkUrl,
    logWatchProgress,
  ]);

  // Clean up Discord activity on episode change or unmount
  useEffect(() => {
    return () => {
      if (hasStartedPresenceRef.current) {
        hasStartedPresenceRef.current = false;
        discordPresenceService.clearActivity();
        discordPresenceCoordinator.releaseLeadership();
      }
    };
  }, [anime.routeId, episode.number]);

  const handleIframeLoad = useCallback(() => {
    if (activeEmbedKeyRef.current !== activeEmbedKey) return;
    setIframeLoaded(true);
    setTimedOut(false);
    setIframeError(false);

    // Record watch history entry once embed initializes (works for all providers)
    const dur = episode.durationSec || 1440;
    if (lastLoggedRef.current.at === 0) {
      lastLoggedRef.current = { sec: 0, at: Date.now() };
      logWatchProgress(anime.routeId, episode.number, 0, dur, audioMode);
    }
  }, [activeEmbedKey, anime.routeId, audioMode, episode.durationSec, episode.number, logWatchProgress]);

  const handleIframeError = useCallback((reason?: string) => {
    if (activeEmbedKeyRef.current !== activeEmbedKey) return;
    setIframeError(true);
    setIframeLoaded(false);
    if (reason) setStreamErrorReason(reason);
  }, [activeEmbedKey]);

  const handleStreamExpired = useCallback(
    (resumeAtSec: number, reason: string) => {
      if (activeEmbedKeyRef.current !== activeEmbedKey) return;
      if (onRetryResolve && streamExpireRefreshCountRef.current < 2) {
        streamExpireRefreshCountRef.current += 1;
        setResumePositionSec(resumeAtSec);
        flashOsd('Refreshing stream session...');
        onRetryResolve();
        return;
      }
      setStreamErrorReason(reason);
      setIframeError(true);
      setIframeLoaded(false);
    },
    [activeEmbedKey, flashOsd, onRetryResolve]
  );

  const handleRetry = useCallback(() => {
    setResumePositionSec(
      videoElement && Number.isFinite(videoElement.currentTime)
        ? Math.floor(videoElement.currentTime)
        : 0
    );
    setIframeLoaded(false);
    setIframeError(false);
    setTimedOut(false);
    setProviderError(null);
    setStreamErrorReason(null);
    if (onRetryResolve) {
      onRetryResolve();
    } else {
      setReloadKey((k) => k + 1);
    }
    flashOsd('Reloading stream');
  }, [flashOsd, onRetryResolve, videoElement]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => { });
    } else {
      el.requestFullscreen?.().catch(() => { });
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const heroArt = anime.banner ?? episode.thumbnail ?? anime.poster;
  const serverMeta = SERVER_DESCRIPTORS[server];
  const ambientConfig = playerPrefs.ambientSettings ?? DEFAULT_AMBIENT_SETTINGS;
  const ambientCapabilityActive =
    playerPrefs.ambientMode &&
    resolvedEmbed.capabilities.ambientMode &&
    isAmbientActiveForLayout(ambientConfig, {
      isFullscreen,
      theaterMode: playerPrefs.theaterMode,
    });

  const { status: liveAmbientStatus } = useLiveAmbient({
    videoElement,
    stageRef,
    videoContainerRef: containerRef,
    isFullscreen,
    theaterMode: playerPrefs.theaterMode,
    enabled: playerPrefs.ambientMode && resolvedEmbed.capabilities.ambientMode,
    settings: ambientConfig,
    sourceKey: activeEmbedKey,
  });

  const ambientFallbackVars = {
    '--ambient-fade': `${ambientConfig.fadeDuration}ms`,
  } as React.CSSProperties;

  const hasBlockingError =
    (!resolvedEmbed.ok && !resolvedEmbed.loading) || iframeError || timedOut || Boolean(providerError);
  const isWaitingForIframe =
    (resolvedEmbed.ok || resolvedEmbed.loading) && !iframeLoaded && !iframeError && !timedOut && !providerError;

  const displayErrorText =
    providerError ||
    streamErrorReason ||
    (!resolvedEmbed.ok ? resolvedEmbed.errorMessage : null) ||
    (timedOut
      ? `${serverMeta.label} timed out while loading the player. Please retry or switch servers.`
      : iframeError
        ? `Unable to load ${serverMeta.label}. Please retry or switch to another server.`
        : null);

  return (
    <div
      ref={stageRef}
      className="glassplayer-wrap"
      style={{ width: `${playerPrefs.playerSize}%`, maxWidth: '100%', marginInline: 'auto' }}
    >
      {ambientCapabilityActive && liveAmbientStatus !== 'live' && (
        <div
          className="glassplayer-ambient is-enabled"
          style={ambientFallbackVars}
          aria-hidden="true"
        >
          <div
            className="glassplayer-ambient__fallback"
            style={{ backgroundImage: `url(${heroArt})` }}
          />
        </div>
      )}

      <div
        ref={containerRef}
        className={`glassplayer ${playerPrefs.theaterMode ? 'is-theater' : ''}${isFullscreen ? ' is-fullscreen' : ''
          }`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key.toLowerCase() === 'f') {
            toggleFullscreen();
          }
        }}
      >
        <div
          className="glassplayer__blank-placeholder"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            background: isFullscreen && ambientCapabilityActive ? 'transparent' : '#06070b',
            zIndex: 1,
          }}
        >
          {resolvedEmbed.ok && !providerError ? (
            <EmbedFrame
              resolved={resolvedEmbed}
              title={`${anime.title} — Episode ${episode.number} (${serverMeta.label})`}
              reloadKey={reloadKey}
              autoplay={playerPrefs.autoplayNext}
              resumePositionSec={resumePositionSec}
              controllerRef={hlsControllerRef}
              onLoad={handleIframeLoad}
              onError={handleIframeError}
              onStreamExpired={handleStreamExpired}
              onQualityStateChange={setQualityState}
              onQualityWarning={flashOsd}
              onTelemetryChange={privacyPrefs.playbackDiagnostics ? setTelemetry : undefined}
              onVideoElement={setVideoElement}
            />
          ) : (
            <div
              className="glassplayer__poster-layer"
              style={{ backgroundImage: `url(${heroArt})`, opacity: 0.32 }}
              aria-hidden="true"
            />
          )}
        </div>

        {(isWaitingForIframe || hasBlockingError) && (
          <div
            className="glassplayer__poster-layer"
            style={{ backgroundImage: `url(${heroArt})`, zIndex: 2 }}
            aria-hidden="true"
          />
        )}

        {(isWaitingForIframe || hasBlockingError) && (
          <div
            className="glassplayer__pause-overlay"
            style={{
              zIndex: 3,
              pointerEvents: hasBlockingError ? 'auto' : 'none',
              justifyContent: 'center',
              alignItems: 'flex-start',
              padding: '28px 30px',
              background: hasBlockingError
                ? 'linear-gradient(180deg, rgba(6, 7, 11, 0.72) 0%, rgba(6, 7, 11, 0.9) 100%)'
                : 'linear-gradient(180deg, rgba(0, 0, 0, 0.25) 0%, rgba(0, 0, 0, 0.75) 100%)',
            }}
          >
            <span className="glassplayer__pause-eyebrow">
              {anime.title} · Episode {episode.number}
              {serverMeta.capabilities.supportsSubDub ? ` · ${audioMode.toUpperCase()}` : ''} · {serverMeta.label}
            </span>
            <h2 className="glassplayer__pause-title">{episode.title}</h2>
            {hasBlockingError ? (
              <>
                <p className="glassplayer__pause-sub" style={{ maxWidth: 560, marginTop: 6 }}>
                  {displayErrorText}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
                  {(resolvedEmbed.ok || resolvedEmbed.errorCode === 'api_error') && (
                    <button
                      type="button"
                      className="watch-pill"
                      onClick={resolvedEmbed.ok ? handleRetry : onRetryResolve}
                      aria-pressed="true"
                    >
                      <RefreshCw size={13} />
                      <span>Retry {serverMeta.label}</span>
                    </button>
                  )}
                  {onSelectServer &&
                    ORDERED_SERVER_IDS.filter((id) => id !== server).map((altId) => (
                      <button
                        key={altId}
                        type="button"
                        className="watch-pill"
                        onClick={() => onSelectServer(altId)}
                      >
                        <span>Switch to {SERVER_DESCRIPTORS[altId].label}</span>
                      </button>
                    ))}
                </div>
              </>
            ) : (
              <p className="glassplayer__pause-sub" style={{ marginTop: 6 }}>
                Connecting to {serverMeta.label} ({serverMeta.shortDescription})...
              </p>
            )}
          </div>
        )}

        {osd && (
          <div
            className={`glassplayer__osd ${playerPrefs.toastPosition === 'center' ? 'glassplayer__osd--center' : 'glassplayer__osd--top'
              }`}
            style={{ zIndex: 7 }}
          >
            {osd}
          </div>
        )}

        {iframeLoaded && !hasBlockingError && qualityState && qualityState.levels.length > 1 && (
          <div
            className="glassplayer__quality"
            style={{ position: 'absolute', top: 12, right: 12, zIndex: 8 }}
          >
            <button
              type="button"
              className="glassplayer__quality-btn"
              aria-haspopup="menu"
              aria-expanded={qualityMenuOpen}
              aria-label="Stream quality"
              onClick={() => setQualityMenuOpen((open) => !open)}
            >
              <span>
                {qualityState.autoMode
                  ? `Auto${
                      qualityState.activeLevel >= 0
                        ? ` · ${
                            qualityState.levels.find((l) => l.index === qualityState.activeLevel)
                              ?.label ?? ''
                          }`
                        : ''
                    }`
                  : qualityState.levels.find((l) => l.index === qualityState.selectedLevel)
                      ?.label ?? 'Quality'}
              </span>
            </button>
            {qualityMenuOpen && (
              <div className="glassplayer__quality-menu" role="menu">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={qualityState.autoMode}
                  className={`glassplayer__quality-option${qualityState.autoMode ? ' is-active' : ''}`}
                  onClick={() => {
                    hlsControllerRef.current?.selectQuality(-1);
                    setQualityMenuOpen(false);
                    flashOsd('Quality: Auto');
                  }}
                >
                  <span>Auto (Adaptive)</span>
                  <span className="glassplayer__quality-meta">ABR</span>
                </button>
                {[...qualityState.levels].reverse().map((lvl) => {
                  const selected = !qualityState.autoMode && qualityState.selectedLevel === lvl.index;
                  return (
                    <button
                      key={lvl.index}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={`glassplayer__quality-option${selected ? ' is-active' : ''}`}
                      onClick={() => {
                        hlsControllerRef.current?.selectQuality(lvl.index);
                        setQualityMenuOpen(false);
                        flashOsd(`Quality: ${lvl.label}`);
                      }}
                    >
                      <span>{lvl.label}</span>
                      <span className="glassplayer__quality-meta">
                        {lvl.bitrate > 0 ? `${Math.round(lvl.bitrate / 1000)}k` : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {privacyPrefs.playbackDiagnostics && iframeLoaded && !hasBlockingError && telemetry && (
          <div className="glassplayer__diagnostics" aria-live="off">
            <div>
              <strong>{telemetry.activeProfile.toUpperCase()}</strong> ·{' '}
              {(telemetry.segmentThroughputBps / 1_000_000).toFixed(2)} Mbps · Buf{' '}
              {telemetry.currentBufferAheadSec.toFixed(1)}s
            </div>
            <div>
              Start {telemetry.startupMs ?? '-'}ms · Rebuf {telemetry.rebufferCount} · Drop{' '}
              {telemetry.droppedFrames}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
