import {
  getAllowAttribute,
  SERVER_DESCRIPTORS,
} from './providerCapabilities';
import type {
  PlayerServerId,
  ResolvedEmbedResult,
} from './types';

const API_BASE = (
  import.meta.env.VITE_ANIVAULT_API_URL ||
  'https://anivaultapi-production.up.railway.app'
 ).replace(/\/+$/, '');

const SOURCE_BY_SERVER: Partial<Record<PlayerServerId, 'megaplay' | 'zokoanime'>> = {
  server1: 'zokoanime',
  default: 'megaplay',
};

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function baseResult(
  server: PlayerServerId,
  ids: { anilistId?: unknown; malId?: unknown; tmdbId?: unknown; episodeNumber: number },
  autoplay: boolean
): Omit<ResolvedEmbedResult, 'ok' | 'embedUrl'> {
  const descriptor = SERVER_DESCRIPTORS[server];
  return {
    provider: 'anivault-api',
    serverId: server,
    serverLabel: descriptor.label,
    sandboxMode: 'none',
    allowAttribute: getAllowAttribute(descriptor.capabilities, autoplay),
    capabilities: descriptor.capabilities,
    resolvedIdentifiers: {
      anilistId: positiveId(ids.anilistId),
      malId: positiveId(ids.malId),
      tmdbId: positiveId(ids.tmdbId),
      seasonNumber: null,
      episodeNumber: ids.episodeNumber,
    },
  };
}

export function createLoadingEmbed(
  server: PlayerServerId,
  ids: { anilistId?: unknown; malId?: unknown; tmdbId?: unknown; episodeNumber?: number } = {},
  autoplay = true
): ResolvedEmbedResult {
  return {
    ...baseResult(server, { ...ids, episodeNumber: ids.episodeNumber ?? 1 }, autoplay),
    ok: false,
    embedUrl: null,
    hlsProxyUrl: null,
    m3u8: null,
    subtitles: [],
    loading: true,
    errorMessage: 'Connecting to AniVault streaming API…',
  };
}

export async function resolveAniVaultStream(input: {
  server: PlayerServerId;
  anilistId?: number | string | null;
  malId?: number | string | null;
  tmdbId?: number | string | null;
  episodeNumber: number;
  audioMode: 'sub' | 'dub';
  autoplay?: boolean;
  signal?: AbortSignal;
}): Promise<ResolvedEmbedResult> {
  const { server, episodeNumber, audioMode, signal } = input;
  const base = baseResult(server, input, input.autoplay ?? true);
  const anilistId = positiveId(input.anilistId);
  const malId = positiveId(input.malId);

  const failure = (message: string): ResolvedEmbedResult => ({
    ...base,
    ok: false,
    embedUrl: null,
    hlsProxyUrl: null,
    m3u8: null,
    subtitles: [],
    errorCode: 'api_error',
    errorMessage: message,
  });

  if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1) return failure('A valid episode number is required.');
  const source = SOURCE_BY_SERVER[server];
  if (!source) return failure('This streaming source is no longer available.');

  try {
    let response: Response;
    if (source === 'megaplay') {
      if (!anilistId) return failure('MegaPlay requires a valid AniList ID.');
      const url = API_BASE + '/api/watch/megaplay/' + anilistId + '/' + episodeNumber + '/' + audioMode;
      response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    } else {
      if (!anilistId && !malId) return failure('ZokoAnime requires a valid AniList ID or MAL ID.');
      const directId = anilistId ? String(anilistId) : malId ? 'mal-' + String(malId) : '';
      if (!directId) return failure('ZokoAnime requires an AniList ID or MAL ID.');
      const url = API_BASE + '/api/watch/zokoanime/' + encodeURIComponent(directId) + '/' + episodeNumber + '/' + audioMode;
      response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    }

    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return failure(typeof payload.error === 'string' ? payload.error : source + ' playback request failed (HTTP ' + response.status + ').');

    const rawProxy = typeof payload.hlsProxyUrl === 'string' ? payload.hlsProxyUrl.trim() : '';
    if (!rawProxy) return failure('The API response did not include hlsProxyUrl. Refusing to open the provider embed page.');
    let safeProxy: string;
    try {
      const parsed = new URL(rawProxy);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return failure('The API returned an unsupported HLS proxy URL.');
      safeProxy = parsed.toString();
    } catch {
      return failure('The API returned an invalid HLS proxy URL.');
    }

    const subtitles = Array.isArray(payload.subtitles) ? payload.subtitles.flatMap((item): Array<{lang?: string; label: string; default?: boolean; src?: string; url?: string}> => {
      if (!item || typeof item !== 'object') return [];
      const track = item as Record<string, unknown>;
      const trackUrl = typeof track.url === 'string' ? track.url : typeof track.src === 'string' ? track.src : undefined;
      if (!trackUrl) return [];
      return [{
        lang: typeof track.lang === 'string' ? track.lang : undefined,
        label: typeof track.label === 'string' ? track.label : typeof track.lang === 'string' ? track.lang : 'Subtitle',
        default: track.default === true,
        src: typeof track.src === 'string' ? track.src : undefined,
        url: trackUrl,
      }];
    }) : [];

    const m3u8 = typeof payload.m3u8 === 'string' ? payload.m3u8 : null;
    return {
      ...base,
      ok: true,
      embedUrl: safeProxy,
      hlsProxyUrl: safeProxy,
      m3u8,
      playbackMode: typeof payload.playbackMode === 'string' ? payload.playbackMode : 'hls',
      subtitles,
      resolvedServerName: typeof payload.serverName === 'string' ? payload.serverName : typeof payload.server === 'string' ? payload.server : source === 'zokoanime' ? 'ZokoAnime' : 'MegaPlay Direct',
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return failure('Playback request was cancelled.');
    }
    return failure(
      error instanceof Error
        ? `Could not reach AniVault API: ${error.message}`
        : 'Could not reach AniVault API.'
    );
  }
}
