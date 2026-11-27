export type ThemeId =
  | 'graphite'
  | 'noir'
  | 'midnight'
  | 'obsidian'
  | 'slate'
  | 'forest'
  | 'wine'
  | 'ocean'
  | 'light'
  | 'paper'
  | 'mist'
  | 'snow'
  | 'custom';

export type BaseTextSize = 'small' | 'medium' | 'large';
export type TitleLangPref = 'english' | 'original';
export type CatalogLangPref = 'any' | 'sub' | 'dub';
export type PlayerServer = 'server1' | 'beta' | 'default' | 'hindi';

export interface CaptionSettings {
  fontFamily: 'default' | 'sans' | 'serif' | 'mono';
  fontSize: 'small' | 'normal' | 'large' | 'xlarge';
  fontColor: string;
  fontWeight: 'normal' | 'bold';
  italic: boolean;
  uppercase: boolean;
  bgColor: string;
  bgOpacity: 'none' | 'subtle' | 'medium' | 'strong';
  edgeStyle: 'none' | 'drop' | 'outline' | 'raised';
  verticalPosition: 'bottom' | 'lifted';
}

export interface ShortcutBinding {
  id: string;
  label: string;
  group: 'playback' | 'seeking' | 'volume' | 'subtitles' | 'navigation';
  defaultKey: string;
  currentKey: string;
  fixed?: boolean;
  altKeys?: string[];
}

export type AmbientLayoutMode = 'small' | 'theater' | 'fullscreen';
export type AmbientViewMode = 'all' | AmbientLayoutMode;

export interface AmbientEnabledLayouts {
  small: boolean;
  theater: boolean;
  fullscreen: boolean;
}

export interface AmbientSettings {
  enabled: boolean;
  blur: number;
  spread: number;
  fadeDuration: number;
  enabledLayouts: AmbientEnabledLayouts;
}

export interface PlayerPreferences {
  preferredAudio: 'sub' | 'dub';
  defaultServer: PlayerServer;
  autoplayNext: boolean;
  autoSkip: boolean;
  markWatchedPercent: number;
  skipStepSec: number;
  longSkipSec: number;
  arrowStepSec: number;
  controlBarSize: number;
  videoSize: number;
  playerSize: number;
  toastPosition: 'top' | 'center';
  toastDurationSec: number;
  pauseMenu: boolean;
  ambientMode: boolean;
  ambientSettings: AmbientSettings;
  lightsOffBrightness: number;
  theaterMode: boolean;
  lightsOff: boolean;
  controlButtons: {
    volume: boolean;
    captions: boolean;
    cast: boolean;
    airplay: boolean;
    pip: boolean;
    fillTab: boolean;
    fullscreen: boolean;
    prevNext: boolean;
    autoplaySwitch: boolean;
  };
}

export interface ContentPreferences {
  titleLanguage: TitleLangPref;
  defaultSort: 'trending' | 'popular' | 'score' | 'newest';
  catalogLanguage: CatalogLangPref;
  showContinueWatchingOnHome: boolean;
  showEpisodeThumbsOnHome: boolean;
  showMature18Plus: boolean;
}

export interface PrivacyPreferences {
  audienceAnalytics: boolean;
  playbackDiagnostics: boolean;
}

export interface DiscordPresencePreferences {
  enabled: boolean;
  autoShare: boolean;
  hideTitle: boolean;
  hideEpisode: boolean;
}

export interface CustomThemeColors {
  bg: string;
  surface: string;
  accent: string;
  text: string;
}

export interface ThemePreferences {
  theme: ThemeId;
  followSystem: boolean;
  accentColor: string;
  colorPagesAfterTitle: boolean;
  textSize: BaseTextSize;
  animations: boolean;
  backdropBlur: boolean;
  customColors: CustomThemeColors;
}
