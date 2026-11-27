import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, signOutSupabase } from '@/src/services/supabase';
import {
  DEFAULT_LOCALE,
  detectBrowserLocale,
  getLocaleDir,
  getLocaleEntry,
  isValidLocale,
  LOCALES,
} from '@/src/i18n/locales';
import { translate } from '@/src/i18n/translations';
import type { LocaleEntry, LocaleTag, TextDir } from '@/src/types/i18n';
import type {
  AmbientSettings,
  CaptionSettings,
  ContentPreferences,
  DiscordPresencePreferences,
  PlayerPreferences,
  PrivacyPreferences,
  ThemePreferences,
} from '@/src/types/settings';
import {
  DEFAULT_AMBIENT_SETTINGS,
  normalizeAmbientSettings,
} from '@/src/services/player/ambientSettings';
import { discordPresenceService } from '@/src/services/discordPresenceService';
import type { AuthProvider, UserProfile, WatchStatus } from '@/src/types/user';
import type { ChatMessage, ForumCategory, ForumThread, WatchRoom } from '@/src/types/community';
import {
  computeWatchTimeMinutes,
  createFolder,
  INITIAL_LIBRARY_STATE,
  LibraryState,
  parseImportedLibraryBackup,
  recordWatchProgress,
  removeFromLibrary,
  setWatchStatus,
  toggleFolderItem,
  toggleTitleLike,
} from '@/src/utils/libraryStore';
import { applyThemeToDocument } from '@/src/utils/themeUtils';
import {
  INITIAL_CHAT_MESSAGES,
  INITIAL_COMMUNITY_THREADS,
  INITIAL_WATCH_ROOMS,
} from '@/src/data/catalogService';
import { apiClient, UserProfileResponse } from '@/src/services/apiClient';

const STORAGE_KEYS = {
  locale: '7anime:locale:v1',
  theme: '7anime:theme:v1',
  content: '7anime:content:v1',
  player: '7anime:player:v1',
  captions: '7anime:captions:v1',
  privacy: '7anime:privacy:v1',
  discord: '7anime:discord:v1',
  library: '7anime:library:v1',
  user: '7anime:user:v1',
  recentSearches: '7anime:recent-searches:v1',
};

export const DEFAULT_THEME_PREFS: ThemePreferences = {
  theme: 'graphite',
  followSystem: false,
  accentColor: '#b29ce0',
  colorPagesAfterTitle: true,
  textSize: 'medium',
  animations: true,
  backdropBlur: true,
  customColors: {
    bg: '#100e11',
    surface: '#24202b',
    accent: '#b29ce0',
    text: '#eeeaf1',
  },
};

export const DEFAULT_CONTENT_PREFS: ContentPreferences = {
  titleLanguage: 'english',
  defaultSort: 'trending',
  catalogLanguage: 'any',
  showContinueWatchingOnHome: true,
  showEpisodeThumbsOnHome: true,
  showMature18Plus: false,
};

export const DEFAULT_PLAYER_PREFS: PlayerPreferences = {
  preferredAudio: 'sub',
  defaultServer: 'server1',
  autoplayNext: true,
  autoSkip: true,
  markWatchedPercent: 90,
  skipStepSec: 10,
  longSkipSec: 90,
  arrowStepSec: 5,
  controlBarSize: 70,
  videoSize: 100,
  playerSize: 100,
  toastPosition: 'top',
  toastDurationSec: 1.1,
  pauseMenu: true,
  ambientMode: true,
  ambientSettings: DEFAULT_AMBIENT_SETTINGS,
  lightsOffBrightness: 8,
  theaterMode: false,
  lightsOff: false,
  controlButtons: {
    volume: true,
    captions: true,
    cast: true,
    airplay: true,
    pip: true,
    fillTab: true,
    fullscreen: true,
    prevNext: true,
    autoplaySwitch: true,
  },
};

export const DEFAULT_CAPTION_PREFS: CaptionSettings = {
  fontFamily: 'default',
  fontSize: 'normal',
  fontColor: '#FFFFFF',
  fontWeight: 'bold',
  italic: false,
  uppercase: false,
  bgColor: '#000000',
  bgOpacity: 'strong',
  edgeStyle: 'drop',
  verticalPosition: 'bottom',
};

export const DEFAULT_PRIVACY_PREFS: PrivacyPreferences = {
  audienceAnalytics: false,
  playbackDiagnostics: false,
};

export const DEFAULT_DISCORD_PREFS: DiscordPresencePreferences = {
  enabled: false,
  autoShare: true,
  hideTitle: false,
  hideEpisode: false,
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

interface ToastMessage {
  id: number;
  text: string;
  tone?: 'info' | 'error';
}

interface AppContextValue {
  // i18n
  locale: LocaleTag;
  localeEntry: LocaleEntry;
  locales: readonly LocaleEntry[];
  dir: TextDir;
  setLocale: (tag: LocaleTag) => void;
  t: (key: string, params?: Record<string, string | number>) => string;

  // Preferences
  themePrefs: ThemePreferences;
  setThemePrefs: React.Dispatch<React.SetStateAction<ThemePreferences>>;
  contentPrefs: ContentPreferences;
  setContentPrefs: React.Dispatch<React.SetStateAction<ContentPreferences>>;
  playerPrefs: PlayerPreferences;
  setPlayerPrefs: React.Dispatch<React.SetStateAction<PlayerPreferences>>;
  captionPrefs: CaptionSettings;
  setCaptionPrefs: React.Dispatch<React.SetStateAction<CaptionSettings>>;
  privacyPrefs: PrivacyPreferences;
  setPrivacyPrefs: React.Dispatch<React.SetStateAction<PrivacyPreferences>>;
  discordPrefs: DiscordPresencePreferences;
  setDiscordPrefs: React.Dispatch<React.SetStateAction<DiscordPresencePreferences>>;
  resetPlayerPrefs: () => void;

  // Auth & Profile
  user: UserProfile | null;
  signIn: (provider: AuthProvider, customName?: string) => void;
  signOut: () => void;
  updateUserProfile: (patch: Partial<UserProfile>) => void;

  // Library
  library: LibraryState;
  setAnimeStatus: (routeId: string, status: WatchStatus) => void;
  removeAnimeFromLibrary: (routeId: string) => void;
  toggleAnimeInFolder: (folderId: string, routeId: string) => void;
  addLibraryFolder: (name: string, initialRouteId?: string) => void;
  logWatchProgress: (routeId: string, episode: number, positionSec: number, durationSec: number, audioMode: 'sub' | 'dub') => void;
  toggleLikeAnime: (routeId: string) => void;
  clearHistory: () => void;
  exportStorageJson: () => string;
  importBackupJson: (raw: string) => boolean;
  resetDeviceData: () => void;
  watchTimeMinutes: number;

  // Search & Recent
  recentSearches: string[];
  addRecentSearch: (q: string) => void;
  clearRecentSearches: () => void;

  // Social
  chatMessages: ChatMessage[];
  sendChatMessage: (body: string) => void;
  threads: ForumThread[];
  createThread: (title: string, category: ForumCategory, body: string) => ForumThread;
  replyToThread: (threadId: string, body: string) => void;
  watchRooms: WatchRoom[];
  createWatchRoom: (opts: { name: string; routeId: string; hostName: string; isPublic: boolean }) => WatchRoom;

  // Overlays & UI state
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  chatOpen: boolean;
  setChatOpen: (v: boolean) => void;
  authOpen: boolean;
  setAuthOpen: (v: boolean) => void;
  reportOpen: boolean;
  setReportOpen: (v: boolean) => void;
  requestAnimeOpen: boolean;
  setRequestAnimeOpen: (v: boolean) => void;
  backupBannerDismissed: boolean;
  dismissBackupBanner: () => void;
  showToast: (text: string, tone?: 'info' | 'error') => void;
  toast: ToastMessage | null;
}

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<LocaleTag>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.locale);
      if (isValidLocale(saved)) return saved;
      return detectBrowserLocale(typeof navigator !== 'undefined' ? navigator.languages : []);
    } catch {
      return DEFAULT_LOCALE;
    }
  });

  const [themePrefs, setThemePrefs] = useState<ThemePreferences>(() =>
    readJson(STORAGE_KEYS.theme, DEFAULT_THEME_PREFS)
  );
  const [contentPrefs, setContentPrefs] = useState<ContentPreferences>(() =>
    readJson(STORAGE_KEYS.content, DEFAULT_CONTENT_PREFS)
  );
  const [playerPrefs, setPlayerPrefsState] = useState<PlayerPreferences>(() => {
    const merged = readJson(STORAGE_KEYS.player, DEFAULT_PLAYER_PREFS);
    const normalizedAmbient = normalizeAmbientSettings(
      merged.ambientSettings,
      typeof merged.ambientMode === 'boolean' ? merged.ambientMode : DEFAULT_PLAYER_PREFS.ambientMode
    );
    return {
      ...merged,
      controlButtons: {
        ...DEFAULT_PLAYER_PREFS.controlButtons,
        ...(merged.controlButtons ?? {}),
      },
      ambientMode: normalizedAmbient.enabled,
      ambientSettings: normalizedAmbient,
    };
  });

  const setPlayerPrefs = useCallback<React.Dispatch<React.SetStateAction<PlayerPreferences>>>(
    (action) => {
      setPlayerPrefsState((prev) => {
        const draft = typeof action === 'function' ? action(prev) : action;
        const ambientSettingsChanged = draft.ambientSettings !== prev.ambientSettings;
        const ambientModeChanged = draft.ambientMode !== prev.ambientMode;

        const targetEnabled = ambientSettingsChanged
          ? Boolean(draft.ambientSettings?.enabled ?? draft.ambientMode)
          : ambientModeChanged
            ? Boolean(draft.ambientMode)
            : Boolean(draft.ambientSettings?.enabled ?? draft.ambientMode);

        const normalizedAmbient: AmbientSettings = normalizeAmbientSettings(
          {
            ...(draft.ambientSettings ?? prev.ambientSettings),
            enabled: targetEnabled,
          },
          targetEnabled
        );

        return {
          ...DEFAULT_PLAYER_PREFS,
          ...draft,
          controlButtons: {
            ...DEFAULT_PLAYER_PREFS.controlButtons,
            ...(draft.controlButtons ?? prev.controlButtons),
          },
          ambientMode: normalizedAmbient.enabled,
          ambientSettings: normalizedAmbient,
        };
      });
    },
    []
  );
  const [captionPrefs, setCaptionPrefs] = useState<CaptionSettings>(() =>
    readJson(STORAGE_KEYS.captions, DEFAULT_CAPTION_PREFS)
  );
  const [privacyPrefs, setPrivacyPrefs] = useState<PrivacyPreferences>(() =>
    readJson(STORAGE_KEYS.privacy, DEFAULT_PRIVACY_PREFS)
  );
  const [discordPrefs, setDiscordPrefs] = useState<DiscordPresencePreferences>(() =>
    readJson(STORAGE_KEYS.discord, DEFAULT_DISCORD_PREFS)
  );

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.discord, JSON.stringify(discordPrefs));
    } catch {}
    discordPresenceService.updatePrefs(discordPrefs);
  }, [discordPrefs]);

  useEffect(() => {
    discordPresenceService.init(discordPrefs);
  }, []);

  const [library, setLibrary] = useState<LibraryState>(() =>
    readJson(STORAGE_KEYS.library, INITIAL_LIBRARY_STATE)
  );

  const [user, setUser] = useState<UserProfile | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.user);
      return raw ? (JSON.parse(raw) as UserProfile) : null;
    } catch {
      return null;
    }
  });

  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.recentSearches);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(INITIAL_CHAT_MESSAGES);
  const [threads, setThreads] = useState<ForumThread[]>(INITIAL_COMMUNITY_THREADS);
  const [watchRooms, setWatchRooms] = useState<WatchRoom[]>(INITIAL_WATCH_ROOMS);

  // Overlays
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [requestAnimeOpen, setRequestAnimeOpen] = useState(false);
  const [backupBannerDismissed, setBackupBannerDismissed] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const showToast = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    const id = Date.now();
    setToast({ id, text, tone });
    setTimeout(() => {
      setToast((prev) => (prev?.id === id ? null : prev));
    }, 2800);
  }, []);

  // Apply locale & dir to <html>
  useEffect(() => {
    const dir = getLocaleDir(locale);
    document.documentElement.setAttribute('lang', locale);
    document.documentElement.setAttribute('dir', dir);
    try {
      localStorage.setItem(STORAGE_KEYS.locale, locale);
    } catch {
      // ignore storage quota errors
    }
  }, [locale]);

  // Apply theme & accent to <html>
  useEffect(() => {
    applyThemeToDocument(themePrefs);
    try {
      localStorage.setItem(STORAGE_KEYS.theme, JSON.stringify(themePrefs));
    } catch {}
  }, [themePrefs]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.content, JSON.stringify(contentPrefs));
    } catch {}
  }, [contentPrefs]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.player, JSON.stringify(playerPrefs));
    } catch {}
  }, [playerPrefs]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.captions, JSON.stringify(captionPrefs));
    } catch {}
  }, [captionPrefs]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.privacy, JSON.stringify(privacyPrefs));
    } catch {}
  }, [privacyPrefs]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.library, JSON.stringify(library));
    } catch {}
  }, [library]);

  useEffect(() => {
    try {
      if (user) localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
      else localStorage.removeItem(STORAGE_KEYS.user);
    } catch {}
  }, [user]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.recentSearches, JSON.stringify(recentSearches));
    } catch {}
  }, [recentSearches]);

  // Global search shortcuts (/ and Ctrl+K / Cmd+K) and overlay controls
  useEffect(() => {
    const isEditable = (el: EventTarget | null): boolean => {
      if (!el || !(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.getAttribute('role') === 'textbox') return true;
      return false;
    };

    const onKey = (e: KeyboardEvent) => {
      // 1. Ctrl+K or Cmd+K shortcut
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
        return;
      }

      // 2. '/' Quick Search shortcut (must not trigger in input/textarea/select/contenteditable or with modifier keys)
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (!isEditable(e.target)) {
          e.preventDefault();
          setSearchOpen(true);
          return;
        }
      }

      // 3. Escape closes search & modals
      if (e.key === 'Escape') {
        setSearchOpen(false);
        setAuthOpen(false);
        setReportOpen(false);
        setRequestAnimeOpen(false);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setLocale = useCallback((tag: LocaleTag) => {
    if (isValidLocale(tag)) setLocaleState(tag);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale]
  );

  const signIn = useCallback(
    (provider: AuthProvider, customName?: string) => {
      const displayName =
        customName?.trim() ||
        (provider === 'google'
          ? 'KuroViewer'
          : provider === 'discord'
            ? 'ZenithPM'
            : provider === 'anilist'
              ? 'AniSyncer'
              : 'Viewer');
      const profile: UserProfile = {
        id: `u-${Date.now()}`,
        username: displayName,
        handle: `@${displayName.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
        avatar: null,
        accentColor: '#8ac4ff',
        avatarDecoration: 'none',
        bannerEffect: 'none',
        bannerUrl: null,
        frameStyle: 'none',
        bio: 'Watching subbed & dubbed anime in HD on 7Anime.',
        level: 0,
        xp: 0,
        nextLevelXp: 75,
        isVip: false,
        provider,
        joinedAt: '2026',
      };
      setUser(profile);
      setAuthOpen(false);
      showToast(`Signed in as ${profile.username}`);
    },
    [showToast]
  );

  // Refs to track active user ID and ongoing sync to prevent duplicate session initialization
  const currentUserIdRef = useRef<string | null>(null);
  const isSyncingRef = useRef<boolean>(false);

  // Secure OAuth redirect callback handler and session restoration
  useEffect(() => {
    let isMounted = true;

    // Helper: Synchronizes an authenticated Supabase session with the user profile
    const syncUserProfile = async (
      session: any,
      fallbackProvider: AuthProvider = 'discord'
    ): Promise<boolean> => {
      if (isSyncingRef.current) return false;
      if (currentUserIdRef.current === session.user?.id && user) return true;

      isSyncingRef.current = true;
      try {
        apiClient.saveSession(session);
        const meData = await apiClient.getMe();
        if (isMounted && meData?.user) {
          const displayName =
            meData.profile?.displayName ||
            meData.profile?.username ||
            (meData.user.user_metadata?.full_name as string) ||
            (meData.user.user_metadata?.name as string) ||
            (meData.user.email ? meData.user.email.split('@')[0] : 'User');

          const rawHandle =
            meData.profile?.username ||
            (meData.user.user_metadata?.username as string) ||
            (meData.user.email ? meData.user.email.split('@')[0] : 'user');
          const handleName = rawHandle.toLowerCase().replace(/[^a-z0-9]/g, '');

          const resolvedProvider =
            (meData.user.app_metadata?.provider as AuthProvider) || fallbackProvider;

          let cachedStyle: {
            avatarDecoration?: string;
            bannerEffect?: string;
            bannerUrl?: string;
            banner?: string;
            usernameGlow?: string | null;
            visibility?: any;
          } = {};
          try {
            const rawStyle = localStorage.getItem(`7anime:custom_style:${meData.user.id}`);
            if (rawStyle) cachedStyle = JSON.parse(rawStyle);
          } catch {}

          const avatarDecoration =
            meData.profile?.avatarDecoration ||
            cachedStyle.avatarDecoration ||
            (meData.user.user_metadata?.avatar_decoration as any) ||
            (meData.user.user_metadata?.avatarDecoration as any) ||
            'none';

          const bannerEffect =
            meData.profile?.bannerEffect ||
            cachedStyle.bannerEffect ||
            (meData.user.user_metadata?.banner_effect as any) ||
            (meData.user.user_metadata?.bannerEffect as any) ||
            'none';

          const bannerUrl =
            meData.profile?.bannerUrl ||
            cachedStyle.bannerUrl ||
            (meData.user.user_metadata?.banner_url as any) ||
            (meData.user.user_metadata?.bannerUrl as any) ||
            null;

          const profile: UserProfile = {
            id: meData.user.id,
            username: displayName,
            handle: `@${handleName || 'user'}`,
            avatar:
              meData.profile?.avatarUrl ||
              (meData.user.user_metadata?.avatar_url as string) ||
              (meData.user.user_metadata?.picture as string) ||
              null,
            accentColor: '#8ac4ff',
            avatarDecoration: avatarDecoration as any,
            bannerEffect: bannerEffect as any,
            bannerUrl: bannerUrl || undefined,
            banner: bannerUrl || undefined,
            usernameGlow: (meData.profile as any)?.username_glow || (meData.profile as any)?.usernameGlow || cachedStyle.usernameGlow || null,
            visibility: (meData.profile as any)?.visibility || cachedStyle.visibility || undefined,
            frameStyle: (meData.profile?.frameStyle as any) || 'none',
            bio: meData.profile?.bio || 'Watching subbed & dubbed anime in HD on 7Anime.',
            level:
              typeof (meData.user.user_metadata as any)?.level === 'number'
                ? (meData.user.user_metadata as any).level
                : typeof (meData.profile as any)?.level === 'number'
                  ? (meData.profile as any).level
                  : 0,
            xp:
              typeof (meData.user.user_metadata as any)?.xp === 'number'
                ? (meData.user.user_metadata as any).xp
                : typeof (meData.profile as any)?.xp === 'number'
                  ? (meData.profile as any).xp
                  : 0,
            nextLevelXp: 75,
            isVip: Boolean(
              meData.user.user_metadata?.isVip ||
              meData.user.user_metadata?.vip ||
              meData.user.app_metadata?.isVip ||
              meData.user.app_metadata?.claims_admin
            ),
            provider: resolvedProvider,
            joinedAt: meData.user.createdAt
              ? String(new Date(meData.user.createdAt).getFullYear())
              : '2026',
          };

          currentUserIdRef.current = profile.id;
          setUser(profile);
          setAuthOpen(false);
          showToast(`Signed in as ${profile.username}`);
          return true;
        }
        return false;
      } catch (err) {
        console.warn('[AppContext] Profile synchronization error:', err);
        return false;
      } finally {
        isSyncingRef.current = false;
      }
    };

    const initializeAuth = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const authTicket = params.get('auth_ticket');
        const authError =
          params.get('auth_error') || params.get('error_description') || params.get('error');

        // Clean sensitive parameters from URL history
        if (
          authTicket ||
          authError ||
          params.has('code') ||
          params.has('auth_success') ||
          params.has('auth_provider')
        ) {
          const cleanUrl = window.location.pathname;
          window.history.replaceState({}, document.title, cleanUrl);
        }

        if (authError) {
          showToast(decodeURIComponent(authError), 'error');
          return;
        }

        // 1. Google OAuth single-use ticket exchange flow
        if (authTicket) {
          const exchangeResult = await apiClient.exchangeAuthTicket(authTicket);
          if (!exchangeResult.success || !exchangeResult.session) {
            showToast(exchangeResult.error || 'Authentication failed. Please try signing in again.', 'error');
            return;
          }
          await syncUserProfile(exchangeResult.session, 'google');
          return;
        }

        // 2. Discord / Supabase PKCE OAuth callback flow
        if (params.has('code')) {
          const { data: supaSessionData, error: supaErr } = await supabase.auth.getSession();
          if (supaErr) {
            showToast(supaErr.message || 'Discord authentication failed. Please try signing in again.', 'error');
            return;
          }
          if (supaSessionData?.session) {
            await syncUserProfile(supaSessionData.session, 'discord');
            return;
          }
        }

        // 3. Application mount: restore active session via apiClient.restoreSession()
        const restored = await apiClient.restoreSession();
        if (isMounted && restored?.user) {
          const displayName =
            restored.profile?.displayName ||
            restored.profile?.username ||
            (restored.user.user_metadata?.full_name as string) ||
            (restored.user.user_metadata?.name as string) ||
            (restored.user.email ? restored.user.email.split('@')[0] : 'User');

          const rawHandle =
            restored.profile?.username ||
            (restored.user.user_metadata?.username as string) ||
            (restored.user.email ? restored.user.email.split('@')[0] : 'user');
          const handleName = rawHandle.toLowerCase().replace(/[^a-z0-9]/g, '');

          const provider =
            (restored.user.app_metadata?.provider as AuthProvider) || 'google';

          currentUserIdRef.current = restored.user.id;
          setUser((prev) => {
            if (prev && prev.id === restored.user.id) {
              return {
                ...prev,
                username: displayName,
                avatar: restored.profile?.avatarUrl ?? prev.avatar,
                bio: restored.profile?.bio ?? prev.bio,
              };
            }
            return {
              id: restored.user.id,
              username: displayName,
              handle: `@${handleName || 'user'}`,
              avatar: restored.profile?.avatarUrl || null,
              bannerUrl: restored.profile?.bannerUrl || undefined,
              banner: restored.profile?.bannerUrl || undefined,
              accentColor: '#8ac4ff',
              bannerEffect: (restored.profile?.bannerEffect as any) || 'sakura',
              frameStyle: (restored.profile?.frameStyle as any) || 'none',
              bio: restored.profile?.bio || 'Watching subbed & dubbed anime in HD on 7Anime.',
              level: 0,
              xp: 0,
              nextLevelXp: 75,
              isVip: false,
              provider,
              joinedAt: restored.user.createdAt
                ? String(new Date(restored.user.createdAt).getFullYear())
                : '2026',
            };
          });
        } else if (isMounted) {
          // If apiClient had no stored session, also check Supabase client storage directly
          const { data: supaSessionData } = await supabase.auth.getSession();
          if (supaSessionData?.session) {
            await syncUserProfile(
              supaSessionData.session,
              (supaSessionData.session.user.app_metadata?.provider as AuthProvider) || 'discord'
            );
          } else {
            currentUserIdRef.current = null;
            setUser((prev) =>
              prev?.provider === 'google' || prev?.provider === 'discord' ? null : prev
            );
          }
        }
      } catch (err) {
        console.warn('[AppContext] Auth initialization error:', err);
      }
    };

    initializeAuth();

    // 4. Supabase auth state change listener (captures async PKCE token exchange and token refreshes)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!isMounted) return;

      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session) {
        apiClient.saveSession(session);
        if (currentUserIdRef.current !== session.user.id) {
          await syncUserProfile(
            session,
            (session.user.app_metadata?.provider as AuthProvider) || 'discord'
          );
        }
      } else if (event === 'SIGNED_OUT') {
        apiClient.clearSession();
        currentUserIdRef.current = null;
        setUser((prev) => (prev?.provider === 'discord' ? null : prev));
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [showToast]);

  const signOut = useCallback(() => {
    signOutSupabase().catch(() => {});
    apiClient.logout().catch(() => {});
    currentUserIdRef.current = null;
    setUser(null);
    showToast('Signed out');
  }, [showToast]);

  const updateUserProfile = useCallback((patch: Partial<UserProfile>) => {
    setUser((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, ...patch };
      if (
        patch.avatarDecoration !== undefined ||
        patch.bannerEffect !== undefined ||
        patch.bannerUrl !== undefined ||
        patch.banner !== undefined ||
        patch.usernameGlow !== undefined ||
        patch.visibility !== undefined ||
        patch.accentColor !== undefined
      ) {
        try {
          const styleCacheKey = `7anime:custom_style:${prev.id}`;
          localStorage.setItem(
            styleCacheKey,
            JSON.stringify({
              avatarDecoration: updated.avatarDecoration,
              bannerEffect: updated.bannerEffect,
              bannerUrl: updated.bannerUrl || updated.banner,
              banner: updated.banner || updated.bannerUrl,
              usernameGlow: updated.usernameGlow,
              visibility: updated.visibility,
              accentColor: updated.accentColor,
            })
          );
        } catch {}
      }
      return updated;
    });

    if (apiClient.isAuthenticated()) {
      apiClient
        .updateProfile({
          username: patch.username,
          displayName: patch.username,
          avatarUrl: patch.avatar || undefined,
          bio: patch.bio,
          avatarDecoration: patch.avatarDecoration,
          bannerEffect: patch.bannerEffect,
          bannerUrl: (patch.bannerUrl || patch.banner) ? String(patch.bannerUrl || patch.banner) : undefined,
          banner: (patch.banner || patch.bannerUrl) ? String(patch.banner || patch.bannerUrl) : undefined,
          usernameGlow: patch.usernameGlow,
          visibility: patch.visibility,
          frameStyle: patch.frameStyle,
        })
        .catch((err) => {
          console.warn('[AppContext] Failed to sync profile update to backend:', err);
        });
    }
  }, []);

  const setAnimeStatus = useCallback(
    (routeId: string, status: WatchStatus) => {
      setLibrary((prev) => setWatchStatus(prev, routeId, status));
      showToast(`Saved to ${status.replace('_', ' ')}`);
    },
    [showToast]
  );

  const removeAnimeFromLibrary = useCallback(
    (routeId: string) => {
      setLibrary((prev) => removeFromLibrary(prev, routeId));
      showToast('Removed from library');
    },
    [showToast]
  );

  const toggleAnimeInFolder = useCallback((folderId: string, routeId: string) => {
    setLibrary((prev) => toggleFolderItem(prev, folderId, routeId));
  }, []);

  const addLibraryFolder = useCallback(
    (name: string, initialRouteId?: string) => {
      setLibrary((prev) => createFolder(prev, name, initialRouteId));
      showToast(`Folder "${name}" created`);
    },
    [showToast]
  );

  const logWatchProgress = useCallback(
    (
      routeId: string,
      episode: number,
      positionSec: number,
      durationSec: number,
      audioMode: 'sub' | 'dub'
    ) => {
      setLibrary((prev) =>
        recordWatchProgress(prev, { routeId, episode, positionSec, durationSec, audioMode })
      );
    },
    []
  );

  const toggleLikeAnime = useCallback((routeId: string) => {
    setLibrary((prev) => toggleTitleLike(prev, routeId));
  }, []);

  const clearHistory = useCallback(() => {
    setLibrary((prev) => ({ ...prev, history: [] }));
    showToast('Watch history cleared');
  }, [showToast]);

  const exportStorageJson = useCallback(() => {
    return JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        ...library,
      },
      null,
      2
    );
  }, [library]);

  const importBackupJson = useCallback(
    (raw: string) => {
      const parsed = parseImportedLibraryBackup(raw);
      if (!parsed) {
        showToast('Invalid backup file', 'error');
        return false;
      }
      setLibrary((prev) => ({
        ...prev,
        entries: { ...prev.entries, ...(parsed.entries ?? {}) },
        folders: parsed.folders ?? prev.folders,
        history: parsed.history ?? prev.history,
        likedIds: parsed.likedIds ?? prev.likedIds,
      }));
      showToast('Library imported');
      return true;
    },
    [showToast]
  );

  const resetDeviceData = useCallback(() => {
    setLibrary(INITIAL_LIBRARY_STATE);
    setThemePrefs(DEFAULT_THEME_PREFS);
    setContentPrefs(DEFAULT_CONTENT_PREFS);
    setPlayerPrefs(DEFAULT_PLAYER_PREFS);
    setCaptionPrefs(DEFAULT_CAPTION_PREFS);
    setRecentSearches([]);
    showToast('Device data reset');
  }, [showToast]);

  const addRecentSearch = useCallback((q: string) => {
    const clean = q.trim();
    if (!clean) return;
    setRecentSearches((prev) => [clean, ...prev.filter((x) => x !== clean)].slice(0, 8));
  }, []);

  const clearRecentSearches = useCallback(() => {
    setRecentSearches([]);
  }, []);

  const sendChatMessage = useCallback(
    (body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const msg: ChatMessage = {
        id: `msg-${Date.now()}`,
        username: user?.username ?? 'Guest',
        level: user?.level ?? 1,
        isVip: user?.isVip ?? false,
        time: `${hh}:${mm}`,
        body: trimmed,
      };
      setChatMessages((prev) => [...prev, msg]);
    },
    [user]
  );

  const createThread = useCallback(
    (title: string, category: ForumCategory, body: string) => {
      const thread: ForumThread = {
        id: String(Date.now()).slice(-4),
        title: title.trim(),
        preview: body.trim().slice(0, 140),
        body: body.trim(),
        category,
        author: user?.username ?? 'Guest',
        isVip: user?.isVip,
        startedAgo: 'Just now',
        replyCount: 0,
        lastReplyAuthor: user?.username ?? 'Guest',
        lastReplyAgo: 'Just now',
        replies: [],
      };
      setThreads((prev) => [thread, ...prev]);
      showToast('Thread posted');
      return thread;
    },
    [user, showToast]
  );

  const replyToThread = useCallback(
    (threadId: string, body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      setThreads((prev) =>
        prev.map((th) => {
          if (th.id !== threadId) return th;
          return {
            ...th,
            replyCount: th.replyCount + 1,
            lastReplyAuthor: user?.username ?? 'Guest',
            lastReplyAgo: 'Just now',
            replies: [
              ...th.replies,
              {
                id: `rep-${Date.now()}`,
                author: user?.username ?? 'Guest',
                isVip: user?.isVip,
                timeAgo: 'Just now',
                body: trimmed,
              },
            ],
          };
        })
      );
    },
    [user]
  );

  const createWatchRoom = useCallback(
    (opts: { name: string; routeId: string; hostName: string; isPublic: boolean; animeTitle?: string; poster?: string }) => {
      const code = Math.random().toString(36).substring(2, 10).toUpperCase();
      const animeTitle = opts.animeTitle || 'Anime Stream';
      const room: WatchRoom = {
        code,
        name: opts.name.trim() || `${opts.hostName.trim() || 'Guest'}'s room`,
        routeId: opts.routeId,
        animeTitle,
        poster: opts.poster || '/assets/posters/f382e8b3b01044cf55c0.webp',
        episode: 1,
        audioMode: 'sub',
        hostName: opts.hostName.trim() || user?.username || 'Guest',
        watchingCount: 1,
        isPlaying: false,
        isPublic: opts.isPublic,
        positionSec: 0,
        messages: [
          {
            id: `wm-${Date.now()}`,
            username: opts.hostName.trim() || 'Host',
            time: 'Just now',
            body: `Room created for ${animeTitle}. Share code ${code} to watch together!`,
          },
        ],
      };
      setWatchRooms((prev) => [room, ...prev]);
      return room;
    },
    [user]
  );

  const resetPlayerPrefs = useCallback(() => {
    setPlayerPrefs(DEFAULT_PLAYER_PREFS);
    showToast('Player preferences reset');
  }, [showToast]);

  const watchTimeMinutes = useMemo(() => computeWatchTimeMinutes(library), [library]);

  const value: AppContextValue = {
    locale,
    localeEntry: getLocaleEntry(locale),
    locales: LOCALES,
    dir: getLocaleDir(locale),
    setLocale,
    t,
    themePrefs,
    setThemePrefs,
    contentPrefs,
    setContentPrefs,
    playerPrefs,
    setPlayerPrefs,
    captionPrefs,
    setCaptionPrefs,
    privacyPrefs,
    setPrivacyPrefs,
    discordPrefs,
    setDiscordPrefs,
    resetPlayerPrefs,
    user,
    signIn,
    signOut,
    updateUserProfile,
    library,
    setAnimeStatus,
    removeAnimeFromLibrary,
    toggleAnimeInFolder,
    addLibraryFolder,
    logWatchProgress,
    toggleLikeAnime,
    clearHistory,
    exportStorageJson,
    importBackupJson,
    resetDeviceData,
    watchTimeMinutes,
    recentSearches,
    addRecentSearch,
    clearRecentSearches,
    chatMessages,
    sendChatMessage,
    threads,
    createThread,
    replyToThread,
    watchRooms,
    createWatchRoom,
    searchOpen,
    setSearchOpen,
    chatOpen,
    setChatOpen,
    authOpen,
    setAuthOpen,
    reportOpen,
    setReportOpen,
    requestAnimeOpen,
    setRequestAnimeOpen,
    backupBannerDismissed,
    dismissBackupBanner: () => setBackupBannerDismissed(true),
    showToast,
    toast,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
