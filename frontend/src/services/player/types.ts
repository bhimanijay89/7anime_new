export type ProviderId = 'animetvplus' | 'nxsha' | 'megaplay' | 'anivault-api';

export type PlayerServerId = 'server1' | 'beta' | 'default' | 'hindi';

export type SandboxMode = 'strict' | 'standard' | 'none';

export interface ProviderCapabilities {
  embedPlayback: boolean;
  episodeSwitching: boolean;
  autoplay: boolean;
  autoNext: boolean;
  autoSkip: boolean;
  theaterMode: boolean;
  ambientMode: boolean;
  fullscreen: boolean;
  playerSize: boolean;
  lightsOff: boolean;
  supportsSubDub: boolean;
  progressPostMessage: boolean;
}

export interface ServerDescriptor {
  id: PlayerServerId;
  provider: ProviderId;
  label: string;
  shortDescription: string;
  sandboxMode: SandboxMode;
  capabilities: ProviderCapabilities;
}

export interface EmbedResolveInput {
  server: PlayerServerId | string;
  anilistId?: number | string | null;
  malId?: number | string | null;
  tmdbId?: number | string | null;
  mediaType?: 'tv' | 'movie' | string | null;
  seasonNumber?: number | string | null;
  episodeNumber: number | string;
  tmdbEpisodeNumber?: number | string | null;
  audioMode?: 'sub' | 'dub';
  autoplay?: boolean;
}

export interface ResolvedSubtitleTrack {
  lang?: string;
  label: string;
  default?: boolean;
  src?: string;
  url?: string;
}

export interface ResolvedEmbedResult {
  ok: boolean;
  provider: ProviderId;
  serverId: PlayerServerId;
  serverLabel: string;
  embedUrl: string | null;
  hlsProxyUrl?: string | null;
  m3u8?: string | null;
  playbackMode?: string | null;
  subtitles?: ResolvedSubtitleTrack[];
  sandboxMode: SandboxMode;
  sandboxAttribute?: string;
  allowAttribute: string;
  capabilities: ProviderCapabilities;
  resolvedIdentifiers: {
    anilistId: number | null;
    malId: number | null;
    tmdbId: number | null;
    seasonNumber: number | null;
    episodeNumber: number;
  };
  errorCode?:
    | 'missing_anilist_id'
    | 'missing_mal_id'
    | 'missing_tmdb_id'
    | 'unsupported_media_type'
    | 'invalid_season'
    | 'invalid_episode'
    | 'api_error';
  errorMessage?: string;
  loading?: boolean;
  resolvedServerName?: string | null;
}

export interface ParsedEmbedProgress {
  progressSeconds: number;
  durationSeconds: number;
  completed: boolean;
  isPaused: boolean;
}
