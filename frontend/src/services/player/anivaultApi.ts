import {
  getAllowAttribute,
  SERVER_DESCRIPTORS,
} from './providerCapabilities.ts';
import type {
  PlayerServerId,
  ResolvedEmbedResult,
} from './types.ts';

const API_BASE = (
  import.meta.env?.VITE_ANIVAULT_API_URL ||
  'https://anivaultapi-production.up.railway.app'
).replace(/\/+$/, '');

const SOURCE_BY_SERVER: Partial<Record<PlayerServerId, 'megaplay' | 'zokoanime'>> = {
  server1: 'zokoanime',
  default: 'megaplay',
};

const STREAM_REQUEST_TIMEOUT_MS = 12_000;
const STREAM_CACHE_TTL_MS = 90_000;
const TRANSIENT_RETRY_DELAY_MS = 350;

interface CachedResolution {
  result: ResolvedEmbedResult;
  expiresAtMs: number;
}

interface InFlightEntry {
  controller: AbortController;
  waiters: number;
  promise: Promise<ResolvedEmbedResult>;
}

const resolvedCache = new Map<string, CachedResolution>();
const inFlightResolutions = new Map<string, InFlightEntry>();

function getNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function buildStreamCacheKey(input: {
  server: PlayerServerId;
  anilistId: number | null;
  malId: number | null;
  episodeNumber: number;
  audioMode: 'sub' | 'dub';
}): string {
  return `${input.server}:${input.anilistId ?? 'none'}:${input.malId ?? 'none'}:${input.episodeNumber}:${input.audioMode}`;
}

export function invalidateAniVaultStream(input: {
  server: PlayerServerId;
  anilistId?: number | string | null;
  malId?: number | string | null;
  episodeNumber: number;
  audioMode: 'sub' | 'dub';
}): void {
  const key = buildStreamCacheKey({
    server: input.server,
    anilistId: positiveId(input.anilistId),
    malId: positiveId(input.malId),
    episodeNumber: input.episodeNumber,
    audioMode: input.audioMode,
  });
  resolvedCache.delete(key);
}

export function resetAniVaultApiCache(): void {
  resolvedCache.clear();
  for (const entry of inFlightResolutions.values()) {
    entry.controller.abort();
  }
  inFlightResolutions.clear();
}

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

function awaitWithCallerSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException('Playback request was cancelled.', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('Playback request was cancelled.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  parentSignal: AbortSignal
): Promise<Response> {
  const attemptController = new AbortController();
  let timedOut = false;

  const onParentAbort = () => attemptController.abort();
  if (parentSignal.aborted) {
    attemptController.abort();
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    attemptController.abort();
  }, timeoutMs);

  try {
    return await fetchFn(url, {
      headers: { Accept: 'application/json' },
      signal: attemptController.signal,
    });
  } catch (err) {
    if (timedOut) {
      throw new Error(`AniVault API timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    globalThis.clearTimeout(timer);
    parentSignal.removeEventListener('abort', onParentAbort);
  }
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
  bypassCache?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ResolvedEmbedResult> {
  const { server, episodeNumber, audioMode, signal } = input;
  const autoplay = input.autoplay ?? true;
  const base = baseResult(server, input, autoplay);
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

  if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1) {
    return failure('A valid episode number is required.');
  }
  const source = SOURCE_BY_SERVER[server];
  if (!source) return failure('This streaming source is no longer available.');

  let requestUrl = '';
  if (source === 'megaplay') {
    if (!anilistId) return failure('MegaPlay requires a valid AniList ID.');
    requestUrl = `${API_BASE}/api/watch/megaplay/${anilistId}/${episodeNumber}/${audioMode}`;
  } else {
    if (!anilistId && !malId) return failure('ZokoAnime requires a valid AniList ID or MAL ID.');
    const directId = anilistId ? String(anilistId) : malId ? `mal-${String(malId)}` : '';
    if (!directId) return failure('ZokoAnime requires an AniList ID or MAL ID.');
    requestUrl = `${API_BASE}/api/watch/zokoanime/${encodeURIComponent(directId)}/${episodeNumber}/${audioMode}`;
  }

  const cacheKey = buildStreamCacheKey({
    server,
    anilistId,
    malId,
    episodeNumber,
    audioMode,
  });

  const nowEpoch = Date.now();
  if (!input.bypassCache) {
    const cached = resolvedCache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowEpoch) {
      return {
        ...cached.result,
        allowAttribute: getAllowAttribute(base.capabilities, autoplay),
        resolutionLatencyMs: 0,
      };
    }
    if (cached) {
      resolvedCache.delete(cacheKey);
    }
  } else {
    resolvedCache.delete(cacheKey);
  }

  const existingInFlight = !input.bypassCache ? inFlightResolutions.get(cacheKey) : undefined;
  let sharedEntry: InFlightEntry;

  if (existingInFlight) {
    sharedEntry = existingInFlight;
    sharedEntry.waiters += 1;
  } else {
    const controller = new AbortController();
    const fetchFn = input.fetchImpl ?? fetch;
    const timeoutMs = input.timeoutMs ?? STREAM_REQUEST_TIMEOUT_MS;
    const startedAt = getNow();

    const promise = (async (): Promise<ResolvedEmbedResult> => {
      let lastResponse: Response | null = null;
      let lastError: unknown = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (controller.signal.aborted) {
          throw new DOMException('Playback request was cancelled.', 'AbortError');
        }
        try {
          const response = await fetchWithTimeout(
            fetchFn,
            requestUrl,
            timeoutMs,
            controller.signal
          );
          if (response.ok || response.status < 500 || attempt === 1) {
            lastResponse = response;
            break;
          }
          lastResponse = response;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
          }
          lastError = err;
          if (attempt === 1) break;
        }

        await new Promise((resolve) => globalThis.setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      }

      if (!lastResponse) {
        throw lastError ?? new Error('Unable to reach AniVault streaming API.');
      }

      const payload = (await lastResponse.json().catch(() => ({}))) as Record<string, unknown>;
      if (!lastResponse.ok) {
        return failure(
          typeof payload.error === 'string'
            ? payload.error
            : `${source} playback request failed (HTTP ${lastResponse.status}).`
        );
      }

      const rawProxy = typeof payload.hlsProxyUrl === 'string' ? payload.hlsProxyUrl.trim() : '';
      if (!rawProxy) {
        return failure(
          'The API response did not include hlsProxyUrl. Refusing to open the provider embed page.'
        );
      }

      let safeProxy: string;
      try {
        const parsed = new URL(rawProxy);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return failure('The API returned an unsupported HLS proxy URL.');
        }
        safeProxy = parsed.toString();
      } catch {
        return failure('The API returned an invalid HLS proxy URL.');
      }

      const subtitles = Array.isArray(payload.subtitles)
        ? payload.subtitles.flatMap(
            (
              item
            ): Array<{ lang?: string; label: string; default?: boolean; src?: string; url?: string }> => {
              if (!item || typeof item !== 'object') return [];
              const track = item as Record<string, unknown>;
              const trackUrl =
                typeof track.url === 'string'
                  ? track.url
                  : typeof track.src === 'string'
                    ? track.src
                    : undefined;
              if (!trackUrl) return [];
              return [
                {
                  lang: typeof track.lang === 'string' ? track.lang : undefined,
                  label:
                    typeof track.label === 'string'
                      ? track.label
                      : typeof track.lang === 'string'
                        ? track.lang
                        : 'Subtitle',
                  default: track.default === true,
                  src: typeof track.src === 'string' ? track.src : undefined,
                  url: trackUrl,
                },
              ];
            }
          )
        : [];

      const m3u8 = typeof payload.m3u8 === 'string' ? payload.m3u8 : null;
      const result: ResolvedEmbedResult = {
        ...base,
        ok: true,
        embedUrl: safeProxy,
        hlsProxyUrl: safeProxy,
        m3u8,
        playbackMode: typeof payload.playbackMode === 'string' ? payload.playbackMode : 'hls',
        subtitles,
        resolvedServerName:
          typeof payload.serverName === 'string'
            ? payload.serverName
            : typeof payload.server === 'string'
              ? payload.server
              : source === 'zokoanime'
                ? 'ZokoAnime'
                : 'MegaPlay Direct',
        resolvedAtMs: Date.now(),
        resolutionLatencyMs: Math.max(1, Math.round(getNow() - startedAt)),
      };

      resolvedCache.set(cacheKey, {
        result,
        expiresAtMs: Date.now() + STREAM_CACHE_TTL_MS,
      });

      return result;
    })().finally(() => {
      if (inFlightResolutions.get(cacheKey)?.controller === controller) {
        inFlightResolutions.delete(cacheKey);
      }
    });

    sharedEntry = { controller, waiters: 1, promise };
    inFlightResolutions.set(cacheKey, sharedEntry);
  }

  let cleanedUpWaiter = false;
  const releaseWaiter = () => {
    if (cleanedUpWaiter) return;
    cleanedUpWaiter = true;
    sharedEntry.waiters = Math.max(0, sharedEntry.waiters - 1);
    if (sharedEntry.waiters === 0) {
      sharedEntry.controller.abort();
      if (inFlightResolutions.get(cacheKey) === sharedEntry) {
        inFlightResolutions.delete(cacheKey);
      }
    }
  };

  signal?.addEventListener('abort', releaseWaiter, { once: true });

  try {
    return await awaitWithCallerSignal(sharedEntry.promise, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return failure('Playback request was cancelled.');
    }
    return failure(
      error instanceof Error
        ? `Could not reach AniVault API: ${error.message}`
        : 'Could not reach AniVault API.'
    );
  } finally {
    signal?.removeEventListener('abort', releaseWaiter);
    releaseWaiter();
  }
}
