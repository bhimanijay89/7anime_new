import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Captions,
  ChevronLeft,
  ChevronRight,
  Flag,
  Info,
  Lightbulb,
  Maximize2,
  Mic,
  Monitor,
  Server,
  Sliders,
  Sparkles,
  X,
} from 'lucide-react';
import { useApp } from '@/src/context/AppContext';
import {
  STILLS_POOL,
} from '@/src/data/catalogService';
import {
  type WatchOrderItem,
} from '@/src/utils/watchRelations';
import { GlassPlayer } from '@/src/components/GlassPlayer';
import { AmbientSettingsControls } from '@/src/components/AmbientSettingsControls';
import { WatchPlaylistPanel } from '@/src/components/WatchPlaylistPanel';
import { WatchAnimeMeta } from '@/src/components/WatchAnimeMeta';
import { WatchCommentsSection } from '@/src/components/WatchCommentsSection';
import { WatchSidebarExtras } from '@/src/components/WatchSidebarExtras';
import { AniListService } from '@/src/services/anilist';
import { apiClient } from '@/src/services/apiClient';
import { ArtworkResolver } from '@/src/services/artworkResolver';
import { ErrorState } from '@/src/components/Skeletons';
import {
  ORDERED_SERVER_IDS,
  SERVER_DESCRIPTORS,
  normalizePlayerServer,
  type PlayerServerId,
  type ResolvedEmbedResult,
} from '@/src/services/player';
import type { AnimeTitle, EpisodeItem, EpisodeKind } from '@/src/types/anime';
import { createLoadingEmbed, resolveAniVaultStream } from '@/src/services/player/anivaultApi';
import type { AnimeEpisodeCatalogue } from '@7anime/shared';

function extractSeasonNumberFromTitle(title?: string | null): number {
  if (!title) return 1;
  const lower = title.toLowerCase();
  const match =
    lower.match(/\b(?:season|series|s)\s*(\d+)\b/i) ||
    lower.match(/(\d+)(?:st|nd|rd|th)\s*season/i) ||
    lower.match(/\bpart\s*(\d+)\b/i) ||
    lower.match(/\bcour\s*(\d+)\b/i);
  if (match) {
    const parsed = parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  if (/\bseason\s+ii\b|\b2nd\s+season\b/i.test(lower)) return 2;
  if (/\bseason\s+iii\b|\b3rd\s+season\b/i.test(lower)) return 3;
  if (/\bseason\s+iv\b|\b4th\s+season\b/i.test(lower)) return 4;
  return 1;
}

function extractAniListId(rawParam?: string): number | null {
  if (!rawParam) return null;
  let decoded = rawParam;
  try {
    decoded = decodeURIComponent(rawParam);
  } catch {}
  const clean = decoded.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').trim();
  if (/^\d+$/.test(clean)) return parseInt(clean, 10);
  // Exclude season, part, cour, or stage numbers (e.g. -season-2, -part-2)
  if (/-(season|part|cour|stage)-\d+$/i.test(clean)) {
    return null;
  }
  const match = clean.match(/-(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

export const WatchPage: React.FC = () => {
  const { id, episode: epParam } = useParams<{ id: string; episode?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const {
    t,
    playerPrefs,
    setPlayerPrefs,
    setReportOpen,
    showToast,
  } = useApp();

  const [anime, setAnime] = useState<AnimeTitle | null>(null);
  const [episodesData, setEpisodesData] = useState<AnimeEpisodeCatalogue | null>(null);
  const [liveRelations, setLiveRelations] = useState<AnimeTitle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;

    async function loadWatchAnime() {
      setIsLoading(true);
      setError(null);
      setAnime(null);
      setEpisodesData(null);
      setLiveRelations([]);

      let targetId = extractAniListId(id);
      if (!targetId && id) {
        try {
          let cleanQuery = decodeURIComponent(id)
            .replace(/[?#].*$/, '')
            .replace(/\/+$/, '')
            .replace(/-(season|part|cour|stage)-\d+$/i, '')
            .replace(/-\d+$/, '')
            .replace(/-/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const matches = await AniListService.searchPreview(cleanQuery, 1);
          if (matches.length > 0) targetId = matches[0].id;
        } catch (e) {
          console.warn('[WatchPage] AniList search fallback failed:', e);
        }
      }

      if (!targetId) {
        setIsLoading(false);
        setError(`Could not resolve anime "${id}"`);
        return;
      }

      try {
        let [backendResolved, anilistDetails, episodesResult] = await Promise.allSettled([
          apiClient.getAnimeById(targetId),
          AniListService.getAnimeDetails(targetId),
          apiClient.getEpisodes(targetId),
        ]);

        let backendData = backendResolved.status === 'fulfilled' ? backendResolved.value : null;
        let anilistData = anilistDetails.status === 'fulfilled' ? anilistDetails.value : null;
        let catData = episodesResult.status === 'fulfilled' ? episodesResult.value : null;

        if (!backendData && !anilistData && !isCancelled) {
          // Automatic single retry with 600ms backoff
          await new Promise((r) => setTimeout(r, 600));
          if (!isCancelled) {
            [backendResolved, anilistDetails, episodesResult] = await Promise.allSettled([
              apiClient.getAnimeById(targetId, true),
              AniListService.getAnimeDetails(targetId, true),
              apiClient.getEpisodes(targetId, true),
            ]);
            backendData = backendResolved.status === 'fulfilled' ? backendResolved.value : null;
            anilistData = anilistDetails.status === 'fulfilled' ? anilistDetails.value : null;
            catData = episodesResult.status === 'fulfilled' ? episodesResult.value : null;
          }
        }

        if (catData && !isCancelled) {
          setEpisodesData(catData);
        }

        if (!backendData && !anilistData) {
          throw new Error(`Failed to load anime with ID ${targetId}`);
        }

        if (anilistData) {
          setLiveRelations(anilistData.related);
        }

        const verifiedEpCount = catData?.totalAnnouncedEpisodes ?? catData?.airedEpisodeCount ?? backendData?.episodes ?? anilistData?.anime?.episodeCount ?? 0;
        const verifiedSubCount = catData?.airedEpisodeCount ?? verifiedEpCount;

        let base: AnimeTitle;
        if (anilistData) {
          base = {
            ...anilistData.anime,
            episodeCount: verifiedEpCount || anilistData.anime.episodeCount,
            subCount: verifiedSubCount || anilistData.anime.subCount,
          };
        } else {
          base = {
            id: targetId,
            slug: backendData!.routeId || String(targetId),
            routeId: backendData!.routeId || String(targetId),
            title: backendData!.titles.english || backendData!.titles.romaji || 'Untitled',
            poster: backendData!.artwork.poster || '',
            banner: backendData!.artwork.backdrop || null,
            year: backendData!.seasonYear ?? null,
            score: backendData!.ratings.tmdb ?? backendData!.ratings.anilist ?? null,
            rating: 'PG-13',
            duration: backendData!.duration ? `${backendData!.duration} min` : '24 min',
            status: backendData!.status || 'RELEASING',
            type: backendData!.format || 'TV',
            genres: backendData!.genres || [],
            studios: backendData!.studios || [],
            episodeCount: verifiedEpCount,
            subCount: verifiedSubCount,
            dubCount: 0,
            synopsis: backendData!.description || '',
            anilistId: targetId,
          };
        }

        if (backendData) {
          base.anilistId = base.anilistId ?? backendData.externalIds.anilistId ?? targetId;
          base.malId = base.malId ?? backendData.externalIds.malId ?? null;
          base.tmdbId = backendData.externalIds.tmdbId ?? base.tmdbId ?? null;
          base.mediaType = backendData.externalIds.mediaType ?? base.mediaType ?? (String(base.type || '').toUpperCase() === 'MOVIE' ? 'movie' : 'tv');
          base.tmdbSeasonNumber = backendData.externalIds.tmdbSeasonNumber ?? base.tmdbSeasonNumber ?? null;

          const resolvedArt = ArtworkResolver.resolve(backendData);
          if (resolvedArt.poster) base.poster = resolvedArt.poster;
          if (resolvedArt.backdrop) base.banner = resolvedArt.backdrop;
          if (resolvedArt.logo) base.logo = resolvedArt.logo;
          if (resolvedArt.trailer) base.trailer = resolvedArt.trailer;
        }

        // Ensure AniList ID is resolved from MAL ID if an entry only provided MAL ID
        if ((!base.anilistId || Number(base.anilistId) <= 0) && base.malId) {
          const mappedAniId = await AniListService.resolveAniListIdByMalId(Number(base.malId));
          if (mappedAniId) {
            base.anilistId = mappedAniId;
          }
        }

        if (!isCancelled) {
          setAnime(base);
        }
      } catch (err: unknown) {
        if (!isCancelled) {
          console.error('[WatchPage] Failed to load watch anime:', err);
          setError(err instanceof Error ? err.message : 'Failed to load video player');
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    loadWatchAnime();

    return () => {
      isCancelled = true;
    };
  }, [id]);

  const episodes: EpisodeItem[] = useMemo(() => {
    const inferredSeason =
      anime?.tmdbSeasonNumber && anime.tmdbSeasonNumber > 0
        ? anime.tmdbSeasonNumber
        : extractSeasonNumberFromTitle(anime?.title);

    if (episodesData?.episodes && episodesData.episodes.length > 0) {
      return episodesData.episodes.map((ep) => {
        let kind: EpisodeKind = 'unknown';
        if (ep.classification) {
          kind = ep.classification.toLowerCase() as EpisodeKind;
        } else if (ep.isFiller === true) {
          kind = 'filler';
        }
        return {
          number: ep.number,
          title: ep.title || `Episode ${ep.number}`,
          synopsis: ep.overview || `Episode ${ep.number} of ${anime?.title || 'the series'}.`,
          aired: ep.airDate || `${anime?.year || ''}`,
          duration: ep.duration ? `${ep.duration}m` : (anime?.duration != null ? `${anime.duration}m` : '24m'),
          durationSec: ep.duration ? ep.duration * 60 : 1440,
          hasSub: Boolean(ep.hasSub),
          hasDub: Boolean(ep.hasDub),
          kind,
          classificationSource: ep.classificationSource,
          arc: 'Season 1',
          season: ep.tmdbSeasonNumber ?? inferredSeason,
          tmdbEpisodeNumber: ep.tmdbEpisodeNumber,
          thumbnail: ep.thumbnail || anime?.banner || anime?.cover || null,
          source: ep.source,
          metadataVerified: ep.metadataVerified,
          isPlayable: ep.isPlayable,
        };
      });
    }

    // Client-side Guaranteed Fallback:
    let confirmedCount = 0;
    if (typeof episodesData?.airedEpisodeCount === 'number' && episodesData.airedEpisodeCount > 0) {
      confirmedCount = episodesData.airedEpisodeCount;
    } else if (anime?.status === 'FINISHED' || !anime?.status) {
      confirmedCount = episodesData?.totalAnnouncedEpisodes || anime?.episodeCount || 0;
    } else if (anime?.subCount && anime.subCount > 0) {
      confirmedCount = anime.subCount;
    } else if (anime?.status !== 'NOT_YET_RELEASED' && anime?.episodeCount && anime.episodeCount > 0) {
      confirmedCount = anime.episodeCount;
    }

    if (confirmedCount > 0) {
      const cleanDur = anime?.duration ? `${String(anime.duration).replace(/\s*min\b/gi, '').trim()}m` : '24m';
      return Array.from({ length: confirmedCount }, (_, i) => {
        const num = i + 1;
        return {
          number: num,
          title: `Episode ${num}`,
          synopsis: `Episode ${num} of ${anime?.title || 'the series'}.`,
          aired: anime?.year ? `${anime.year}` : '',
          duration: cleanDur,
          durationSec: 1440,
          hasSub: false,
          hasDub: false,
          kind: 'unknown' as EpisodeKind,
          classificationSource: 'generated_fallback',
          arc: 'Season 1',
          season: inferredSeason,
          thumbnail: anime?.banner || anime?.cover || null,
          source: 'GENERATED_FALLBACK',
          metadataVerified: false,
          isPlayable: false,
        };
      });
    }

    return [];
  }, [episodesData, anime]);

  const rawEp = epParam ?? searchParams.get('ep') ?? '1';
  const epNum = Math.max(1, Number.parseInt(rawEp, 10) || 1);
  const currentEpisode: EpisodeItem = useMemo(() => {
    const inferredSeason =
      anime?.tmdbSeasonNumber && anime.tmdbSeasonNumber > 0
        ? anime.tmdbSeasonNumber
        : extractSeasonNumberFromTitle(anime?.title);
    return (
      episodes.find((e) => e.number === epNum) ??
      episodes[0] ?? {
        number: epNum,
        title: `Episode ${epNum}`,
        synopsis: `Episode ${epNum}`,
        aired: 'Recent',
        duration: '24m',
        durationSec: 1440,
        hasSub: true,
        hasDub: false,
        kind: 'unknown',
        arc: 'Main Arc',
        season: inferredSeason,
        thumbnail: null,
      }
    );
  }, [episodes, epNum, anime?.tmdbSeasonNumber, anime?.title]);

  const [skipFiller, setSkipFiller] = useState(false);
  const [audioMode, setAudioMode] = useState<'sub' | 'dub'>(playerPrefs.preferredAudio || 'sub');
  const [server, setServer] = useState<PlayerServerId>(() =>
    normalizePlayerServer(playerPrefs.defaultServer)
  );
  const [backupNoticeDismissed, setBackupNoticeDismissed] = useState(false);
  const [sizePopover, setSizePopover] = useState(false);
  const [ambientPopover, setAmbientPopover] = useState(false);
  const [synExpanded, setSynExpanded] = useState(false);

  const [resolvedEmbed, setResolvedEmbed] = useState<ResolvedEmbedResult>(() =>
    createLoadingEmbed(server)
  );
  const [streamRetryKey, setStreamRetryKey] = useState(0);
  const bypassCacheRef = useRef(false);
  const autoplayPrefRef = useRef(playerPrefs.autoplayNext);

  useEffect(() => {
    autoplayPrefRef.current = playerPrefs.autoplayNext;
  }, [playerPrefs.autoplayNext]);

  useEffect(() => {
    if (!anime) {
      setResolvedEmbed(createLoadingEmbed(server));
      return;
    }

    const controller = new AbortController();
    const shouldBypassCache = bypassCacheRef.current;
    bypassCacheRef.current = false;

    setResolvedEmbed(createLoadingEmbed(server, {
      anilistId: anime.anilistId ?? anime.id,
      malId: anime.malId,
      tmdbId: anime.tmdbId,
      episodeNumber: currentEpisode.number,
    }, autoplayPrefRef.current));

    resolveAniVaultStream({
      server,
      anilistId: anime.anilistId ?? anime.id,
      malId: anime.malId,
      tmdbId: anime.tmdbId,
      episodeNumber: currentEpisode.number,
      audioMode,
      autoplay: autoplayPrefRef.current,
      bypassCache: shouldBypassCache,
      signal: controller.signal,
    }).then((result) => {
      if (!controller.signal.aborted) setResolvedEmbed(result);
    });

    return () => controller.abort();
  }, [
    server,
    anime?.anilistId,
    anime?.id,
    anime?.malId,
    anime?.tmdbId,
    currentEpisode.number,
    audioMode,
    streamRetryKey,
  ]);

  const handleSelectServer = (nextServer: PlayerServerId) => {
    setServer(nextServer);
    showToast(`Switched to ${SERVER_DESCRIPTORS[nextServer].label}`);
  };

  const watchOrder: WatchOrderItem[] = useMemo(() => {
    if (!anime) return [];
    return [
      {
        anime,
        badgeTopLeft: anime.type || 'TV',
        isCurrent: true,
      },
      ...liveRelations.map((rel, idx) => ({
        anime: rel,
        badgeTopLeft: rel.type || `ENTRY ${idx + 2}`,
        isCurrent: false,
      })),
    ];
  }, [anime, liveRelations]);

  const relatedAnime = liveRelations;

  const goToEpisode = (n: number) => {
    if (anime) navigate(`/anime/${anime.routeId}?ep=${n}`);
  };

  const getNextEpisodeNumber = (currentNum: number, forward: boolean = true) => {
    if (!skipFiller) {
      return forward ? currentNum + 1 : currentNum - 1;
    }
    if (forward) {
      const remaining = episodes.filter((e) => e.number > currentNum);
      const nextEligible = remaining.find((e) => e.kind !== 'filler');
      return nextEligible ? nextEligible.number : currentNum + 1;
    } else {
      const previous = episodes.filter((e) => e.number < currentNum).sort((a, b) => b.number - a.number);
      const prevEligible = previous.find((e) => e.kind !== 'filler');
      return prevEligible ? prevEligible.number : currentNum - 1;
    }
  };

  const nextTargetEp = getNextEpisodeNumber(currentEpisode.number, true);
  const prevTargetEp = getNextEpisodeNumber(currentEpisode.number, false);
  const hasNext = episodes.some((e) => e.number === nextTargetEp);
  const hasPrev = episodes.some((e) => e.number === prevTargetEp);

  if (isLoading) {
    return (
      <div className="watch-shell">
        <div className="page-shell" style={{ padding: '60px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ height: 480, borderRadius: 16, background: 'rgba(255,255,255,0.06)', animation: 'pulse 1.8s infinite' }} />
        </div>
      </div>
    );
  }

  if (error || !anime) {
    return (
      <div className="watch-shell">
        <div className="page-shell" style={{ padding: '80px 24px' }}>
          <ErrorState
            title="Playback Unavailable"
            message={error || 'Could not find details for this title.'}
            onRetry={() => window.location.reload()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="watch-shell">
      {playerPrefs.lightsOff && (
        <div
          className="watch-lights-backdrop"
          style={{ opacity: 1 - playerPrefs.lightsOffBrightness / 100 }}
          onClick={() => setPlayerPrefs((p) => ({ ...p, lightsOff: false }))}
        />
      )}

      <div className={`watch-grid ${playerPrefs.theaterMode ? 'is-theater' : ''}`}>
        <div>
          <GlassPlayer
            anime={anime}
            episode={currentEpisode}
            audioMode={audioMode}
            server={server}
            resolvedEmbed={resolvedEmbed}
            onRetryResolve={() => {
              bypassCacheRef.current = true;
              setStreamRetryKey((key) => key + 1);
            }}
            onSelectServer={handleSelectServer}
            hasPrev={hasPrev}
            hasNext={hasNext}
            onPrevEpisode={() => hasPrev && goToEpisode(prevTargetEp)}
            onNextEpisode={() => hasNext && goToEpisode(nextTargetEp)}
          />

          {/* Player Controls Toolbar */}
          <div className="watch-toolbar">
            <div className="watch-toolbar__pills">
              <button
                type="button"
                className="watch-pill"
                disabled={!resolvedEmbed.capabilities.autoplay}
                aria-pressed={resolvedEmbed.capabilities.autoplay ? playerPrefs.autoplayNext : false}
                title={
                  resolvedEmbed.capabilities.autoNext
                    ? 'Autoplay & Auto-next enabled'
                    : resolvedEmbed.capabilities.autoplay
                      ? 'Autoplay enabled (Auto-next unavailable on this server)'
                      : 'Autoplay unavailable on this server'
                }
                style={{
                  opacity: resolvedEmbed.capabilities.autoplay ? 1 : 0.38,
                  cursor: resolvedEmbed.capabilities.autoplay ? 'pointer' : 'not-allowed',
                }}
                onClick={() =>
                  resolvedEmbed.capabilities.autoplay &&
                  setPlayerPrefs((p) => ({ ...p, autoplayNext: !p.autoplayNext }))
                }
              >
                <span>{t('watch.autoplay')}</span>
              </button>
              <button
                type="button"
                className="watch-pill"
                disabled={!resolvedEmbed.capabilities.autoSkip}
                aria-pressed={resolvedEmbed.capabilities.autoSkip ? playerPrefs.autoSkip : false}
                title={
                  resolvedEmbed.capabilities.autoSkip
                    ? 'Auto-skip intro / outro'
                    : `Auto-skip is not available on ${SERVER_DESCRIPTORS[server].label}`
                }
                style={{
                  opacity: resolvedEmbed.capabilities.autoSkip ? 1 : 0.38,
                  cursor: resolvedEmbed.capabilities.autoSkip ? 'pointer' : 'not-allowed',
                }}
                onClick={() =>
                  resolvedEmbed.capabilities.autoSkip &&
                  setPlayerPrefs((p) => ({ ...p, autoSkip: !p.autoSkip }))
                }
              >
                <span>{t('watch.autoskip')}</span>
              </button>
              <button
                type="button"
                className="watch-pill"
                aria-pressed={playerPrefs.theaterMode}
                onClick={() => setPlayerPrefs((p) => ({ ...p, theaterMode: !p.theaterMode }))}
              >
                <Monitor size={13} />
                <span>{t('watch.theater')}</span>
              </button>
              <button
                type="button"
                className="watch-pill"
                aria-pressed={playerPrefs.lightsOff}
                onClick={() => setPlayerPrefs((p) => ({ ...p, lightsOff: !p.lightsOff }))}
              >
                <Lightbulb size={13} />
                <span>{t('watch.lightsOff')}</span>
              </button>
              <button
                type="button"
                className="watch-pill"
                aria-pressed={playerPrefs.ambientMode}
                onClick={() => setPlayerPrefs((p) => ({ ...p, ambientMode: !p.ambientMode }))}
              >
                <Sparkles size={13} />
                <span>{t('watch.ambient')}</span>
              </button>

              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="watch-pill"
                  aria-expanded={ambientPopover}
                  aria-label="Ambient light settings"
                  title="Ambient light settings (Blur, Spread, Fade, Views)"
                  onClick={() => {
                    setAmbientPopover((p) => !p);
                    setSizePopover(false);
                  }}
                >
                  <Sliders size={13} />
                  <span>Ambient tune</span>
                </button>
                {ambientPopover && (
                  <div
                    className="facet-popover"
                    style={{
                      padding: 14,
                      width: 312,
                      maxWidth: 'calc(100vw - 24px)',
                      maxHeight: 'none',
                      bottom: 'calc(100% + 8px)',
                      top: 'auto',
                    }}
                  >
                    <AmbientSettingsControls variant="popover" />
                  </div>
                )}
              </div>

              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="watch-pill"
                  aria-expanded={sizePopover}
                  onClick={() => {
                    setSizePopover((p) => !p);
                    setAmbientPopover(false);
                  }}
                >
                  <Sliders size={13} />
                  <span>{t('watch.playerSize')}</span>
                </button>
                {sizePopover && (
                  <div
                    className="facet-popover"
                    style={{ padding: 12, width: 220, bottom: 'calc(100% + 8px)', top: 'auto' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
                      <span>Player width</span>
                      <strong>{playerPrefs.playerSize}%</strong>
                    </div>
                    <input
                      type="range"
                      min={65}
                      max={100}
                      value={playerPrefs.playerSize}
                      onChange={(e) =>
                        setPlayerPrefs((p) => ({ ...p, playerSize: Number(e.target.value) }))
                      }
                      style={{ width: '100%' }}
                    />
                  </div>
                )}
              </div>
              <button
                type="button"
                className="watch-pill"
                onClick={() => {
                  const el = document.querySelector('.glassplayer') as HTMLElement | null;
                  el?.requestFullscreen?.().catch(() => { });
                }}
              >
                <Maximize2 size={13} />
                <span>Fullscreen</span>
              </button>
            </div>

            <div className="watch-toolbar__pills">
              <button
                type="button"
                className="watch-pill watch-pill--icon"
                disabled={!hasPrev}
                aria-label="Previous episode"
                title="Previous episode"
                onClick={() => hasPrev && goToEpisode(prevTargetEp)}
                style={{ opacity: hasPrev ? 1 : 0.4 }}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                type="button"
                className="watch-pill watch-pill--icon"
                disabled={!hasNext}
                aria-label="Next episode"
                title="Next episode"
                onClick={() => hasNext && goToEpisode(nextTargetEp)}
                style={{ opacity: hasNext ? 1 : 0.4 }}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          {/* Episode Title & Synopsis */}
          <div className="watch-ep-summary" style={{ marginTop: 18 }}>
            <h1 style={{ margin: '0 0 6px', fontSize: 21, fontWeight: 700 }}>
              {currentEpisode.number}. {currentEpisode.title}
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: 13.5,
                lineHeight: 1.5,
                color: 'rgb(var(--c-text2))',
                display: synExpanded ? 'block' : '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: synExpanded ? undefined : 2,
                overflow: 'hidden',
              }}
            >
              {currentEpisode.synopsis}
            </p>
            <button
              type="button"
              onClick={() => setSynExpanded((p) => !p)}
              style={{
                marginTop: 4,
                padding: 0,
                border: 0,
                background: 'transparent',
                color: '#9cc3ff',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {synExpanded ? 'Show less' : 'Show more'}
            </button>
          </div>

          {/* Server Notice Banner */}
          {!backupNoticeDismissed && (
            <div className="watch-server-notice">
              <Info size={16} style={{ flexShrink: 0, opacity: 0.78 }} />
              <span style={{ flex: 1 }}>
                Subtitle or audio issues, lag or buffering? Try another streaming source below.
              </span>
              <button
                type="button"
                className="yt-icon-button"
                aria-label="Dismiss tip"
                onClick={() => setBackupNoticeDismissed(true)}
                style={{ width: 26, height: 26, flexShrink: 0 }}
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* Audio Mode & Server Picker */}
          <div className="watch-server-row">
            <div className="watch-audio-switch">
              <button
                type="button"
                aria-pressed={resolvedEmbed.capabilities.supportsSubDub && audioMode === 'sub'}
                disabled={!resolvedEmbed.capabilities.supportsSubDub}
                title={
                  resolvedEmbed.capabilities.supportsSubDub
                    ? 'Subtitled audio track'
                    : server === 'hindi'
                      ? 'Fixed Hindi audio on Hindi server'
                      : 'Multi-audio controlled inside Server 1 player'
                }
                style={{
                  opacity: resolvedEmbed.capabilities.supportsSubDub ? 1 : 0.4,
                  cursor: resolvedEmbed.capabilities.supportsSubDub ? 'pointer' : 'not-allowed',
                }}
                onClick={() => resolvedEmbed.capabilities.supportsSubDub && setAudioMode('sub')}
              >
                <Captions size={13} />
                <span>SUB</span>
              </button>
              <button
                type="button"
                aria-pressed={resolvedEmbed.capabilities.supportsSubDub && audioMode === 'dub'}
                disabled={!resolvedEmbed.capabilities.supportsSubDub}
                title={
                  resolvedEmbed.capabilities.supportsSubDub
                    ? 'English Dub audio track'
                    : server === 'hindi'
                      ? 'Fixed Hindi audio on Hindi server'
                      : 'Multi-audio controlled inside Server 1 player'
                }
                style={{
                  opacity: resolvedEmbed.capabilities.supportsSubDub ? 1 : 0.4,
                  cursor: resolvedEmbed.capabilities.supportsSubDub ? 'pointer' : 'not-allowed',
                }}
                onClick={() => resolvedEmbed.capabilities.supportsSubDub && setAudioMode('dub')}
              >
                <Mic size={13} />
                <span>DUB</span>
              </button>
            </div>

            {ORDERED_SERVER_IDS.map((srvId) => {
              const desc = SERVER_DESCRIPTORS[srvId];
              const active = server === srvId;
              return (
                <button
                  key={srvId}
                  type="button"
                  className={`watch-pill ${active ? 'is-server-active' : ''}`}
                  title={desc.shortDescription}
                  onClick={() => handleSelectServer(srvId)}
                >
                  <span className="ani-switch" data-checked={active ? 'true' : 'false'} />
                  <span>{desc.label}</span>
                </button>
              );
            })}

            <button
              type="button"
              className="watch-pill"
              title="Cycle streaming server"
              onClick={() => {
                const idx = ORDERED_SERVER_IDS.indexOf(server);
                const next = ORDERED_SERVER_IDS[(idx + 1) % ORDERED_SERVER_IDS.length];
                handleSelectServer(next);
              }}
            >
              <Server size={13} />
              <span>Player</span>
            </button>

            <button
              type="button"
              className="watch-pill"
              onClick={() => setReportOpen(true)}
            >
              <Flag size={13} />
              <span>{t('watch.reportProblem')}</span>
            </button>
          </div>

          <WatchAnimeMeta anime={anime} watchOrder={watchOrder} />

          {playerPrefs.theaterMode && (
            <div style={{ marginTop: 28 }}>
              <WatchPlaylistPanel
                episodes={episodes}
                currentEp={currentEpisode.number}
                onSelectEpisode={goToEpisode}
                skipFiller={skipFiller}
                onToggleSkipFiller={() => setSkipFiller((p) => !p)}
              />
              <WatchSidebarExtras relatedAnime={relatedAnime} />
            </div>
          )}
        </div>

        {!playerPrefs.theaterMode && (
          <div className="watch-aside">
            <WatchPlaylistPanel
              episodes={episodes}
              currentEp={currentEpisode.number}
              onSelectEpisode={goToEpisode}
              skipFiller={skipFiller}
              onToggleSkipFiller={() => setSkipFiller((p) => !p)}
            />
            <WatchSidebarExtras relatedAnime={relatedAnime} />
          </div>
        )}

        <div className="watch-comments-slot">
          <WatchCommentsSection anime={anime} currentEp={currentEpisode.number} />
        </div>
      </div>
    </div>
  );
};
