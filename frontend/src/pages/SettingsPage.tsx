import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Check,
  ChevronDown,
  Database,
  Lock,
  Palette,
  Radio,
  Search,
  Shield,
  Sun,
  User,
} from 'lucide-react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { AccountSection, ACCOUNT_SUBS, type AccountSub } from '@/src/components/AccountSection';
import { useApp } from '@/src/context/AppContext';
import { ACCENT_SWATCHES, THEME_OPTIONS } from '@/src/utils/themeUtils';
import { ProfileStyleModal } from '@/src/components/profile/ProfileStyleModal';
import { AmbientSettingsControls } from '@/src/components/AmbientSettingsControls';
import { apiClient } from '@/src/services/apiClient';
import { discordPresenceService, type PresenceState } from '@/src/services/discordPresenceService';
import { cacheManager, imageTracker, type CacheMetrics } from '@/src/services/cache';

type SettingsSection =
  | 'account'
  | 'appearance'
  | 'notifications'
  | 'discord'
  | 'data';

export const SettingsPage: React.FC = () => {
  const {
    t,
    locale,
    locales,
    setLocale,
    user,
    setAuthOpen,
    signOut,
    themePrefs,
    setThemePrefs,
    privacyPrefs,
    setPrivacyPrefs,
    discordPrefs,
    setDiscordPrefs,
    clearHistory,
    clearRecentSearches,
    exportStorageJson,
    resetDeviceData,
    showToast,
    updateUserProfile,
  } = useApp();

  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  const [presenceState, setPresenceState] = useState<PresenceState>(() =>
    discordPresenceService.getState()
  );

  const [cacheStats, setCacheStats] = useState<CacheMetrics>(() =>
    cacheManager.getCacheStats()
  );

  useEffect(() => {
    const unsubPresence = discordPresenceService.subscribe((s) => setPresenceState(s));
    const unsubCache = cacheManager.subscribeToStats((s) => setCacheStats(s));
    return () => {
      unsubPresence();
      unsubCache();
    };
  }, []);

  const [section, setSection] = useState<SettingsSection>('account');
  const [accountExpanded, setAccountExpanded] = useState<boolean>(false);
  const [accountSub, setAccountSub] = useState<AccountSub>('overview');
  const [filterQuery, setFilterQuery] = useState('');
  const [isStyleModalOpen, setIsStyleModalOpen] = useState(false);
  const spyLockUntil = useRef(0);

  // Scroll-spy updates, ignored briefly after a sidebar click so short end sections stay selected.
  const handleSpy = useCallback((id: AccountSub) => {
    if (Date.now() >= spyLockUntil.current) setAccountSub(id);
  }, []);

  // Deep links and direct route / reload synchronization
  useEffect(() => {
    const sectionParam = searchParams.get('section') as SettingsSection | null;
    const subParam = searchParams.get('sub') as AccountSub | null;
    const h = location.hash;

    if (h) {
      const id = h.slice(1);
      if (id.startsWith('pf-')) {
        const sub = id.slice(3) as AccountSub;
        setSection('account');
        setAccountSub(sub);
        setAccountExpanded(true);
        const timer = window.setTimeout(() => {
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 60);
        return () => window.clearTimeout(timer);
      }
      if (id.startsWith('settings-')) {
        const sec = id.replace('settings-', '') as SettingsSection;
        if (['account', 'appearance', 'notifications', 'discord', 'data'].includes(sec)) {
          setSection(sec);
          if (sec === 'account') {
            setAccountExpanded(true);
          } else {
            setAccountExpanded(false);
          }
        }
        const timer = window.setTimeout(() => {
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 60);
        return () => window.clearTimeout(timer);
      }
    }

    if (subParam) {
      setSection('account');
      setAccountSub(subParam);
      setAccountExpanded(true);
      const timer = window.setTimeout(() => {
        document.getElementById(`pf-${subParam}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
      return () => window.clearTimeout(timer);
    }

    if (sectionParam) {
      if (['account', 'appearance', 'notifications', 'discord', 'data'].includes(sectionParam)) {
        setSection(sectionParam);
        if (sectionParam === 'account') {
          setAccountExpanded(true);
        } else {
          setAccountExpanded(false);
        }
      }
    }
  }, [searchParams, location.hash]);

  // Auto-expand account if the filter search query explicitly matches account suboptions
  useEffect(() => {
    const q = filterQuery.trim().toLowerCase();
    if (q && ('account sign in profile sync guest overview visibility connected password devices'.includes(q))) {
      setAccountExpanded(true);
    }
  }, [filterQuery]);

  const sections: { id: SettingsSection; label: string; icon: React.ReactNode; keywords: string }[] = [
    { id: 'account', label: t('settings.account'), icon: <User size={16} />, keywords: 'account sign in profile sync guest overview visibility connected password devices' },
    { id: 'appearance', label: t('settings.appearance'), icon: <Sun size={16} />, keywords: 'theme accent dark light language english animations blur text size ambient spread fade glow lighting view modes small theater fullscreen' },
    { id: 'notifications', label: t('settings.notifications'), icon: <Bell size={16} />, keywords: 'alerts push episodes privacy analytics diagnostics' },
    { id: 'discord', label: 'Discord Presence', icon: <Radio size={16} />, keywords: 'discord rich presence activity watching companion game status' },
    { id: 'data', label: t('settings.yourData'), icon: <Lock size={16} />, keywords: 'export history reset device storage cache l1 l2' },
  ];

  const visibleSections = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter((s) => s.label.toLowerCase().includes(q) || s.keywords.includes(q));
  }, [filterQuery]);

  const showSection = (id: SettingsSection) => {
    if (!filterQuery.trim()) return true;
    return visibleSections.some((s) => s.id === id);
  };

  const scrollToSection = (id: SettingsSection) => {
    setSection(id);
    if (id !== 'account') {
      setAccountExpanded(false);
    }
    const next = new URLSearchParams(searchParams);
    next.set('section', id);
    next.delete('sub');
    setSearchParams(next, { replace: true });

    const el = document.getElementById(`settings-${id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleExport = () => {
    const blob = new Blob([exportStorageJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `7anime-data-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Data exported');
  };

  const jumpSub = (id: AccountSub) => {
    spyLockUntil.current = Date.now() + 1200;
    setAccountSub(id);
    setSection('account');
    setAccountExpanded(true);

    const next = new URLSearchParams(searchParams);
    next.set('section', 'account');
    next.set('sub', id);
    setSearchParams(next, { replace: true });

    const targetEl = document.getElementById(`pf-${id}`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      document.getElementById('settings-account')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="page-shell pf-page">
      <div className="page-header">
        <div className="page-header__left">
          <h1 className="page-title">{t('settings.title')}</h1>
        </div>
      </div>

      <div className="settings-layout">
        <aside className="pf-nav" aria-label="Settings sections">
          <label className="pf-nav__search">
            <Search size={15} aria-hidden="true" />
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Search settings"
              aria-label="Search settings"
            />
          </label>

          <div className="pf-nav__list">
            {visibleSections.map((s) => (
              <React.Fragment key={s.id}>
                <button
                  type="button"
                  className={`pf-nav__item ${section === s.id ? 'is-active' : ''}`}
                  onClick={() => {
                    if (s.id === 'account') {
                      if (!accountExpanded) {
                        setAccountExpanded(true);
                        scrollToSection('account');
                      } else if (section === 'account') {
                        setAccountExpanded(false);
                      } else {
                        scrollToSection('account');
                      }
                    } else {
                      setAccountExpanded(false);
                      scrollToSection(s.id);
                    }
                  }}
                  aria-expanded={s.id === 'account' ? accountExpanded : undefined}
                  aria-controls={s.id === 'account' ? 'account-suboptions' : undefined}
                >
                  {s.icon}
                  <span>{s.label}</span>
                  {s.id === 'account' && (
                    <ChevronDown
                      size={15}
                      style={{
                        marginLeft: 'auto',
                        transition: 'transform 0.24s cubic-bezier(0.4, 0, 0.2, 1)',
                        transform: accountExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        opacity: 0.7,
                      }}
                      aria-hidden="true"
                    />
                  )}
                </button>
                {s.id === 'account' && (
                  <div
                    id="account-suboptions"
                    className="pf-nav__accordion"
                    data-expanded={accountExpanded ? 'true' : 'false'}
                    role="region"
                    aria-label="Account subpages"
                  >
                    <div className="pf-nav__subs">
                      {ACCOUNT_SUBS.map((sub) => (
                        <button
                          key={sub.id}
                          type="button"
                          className={`pf-nav__sub ${section === 'account' && accountSub === sub.id ? 'is-active' : ''}`}
                          onClick={() => jumpSub(sub.id)}
                          tabIndex={accountExpanded ? 0 : -1}
                        >
                          {sub.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        </aside>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {showSection('account') && (
            <section id="settings-account" style={{ scrollMarginTop: 84 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <User size={18} />
                  <h2 style={{ margin: 0, fontSize: 20, fontWeight: 750 }}>{t('settings.account')}</h2>
                </div>
                {user && (
                  <button
                    type="button"
                    className="watch-pill"
                    onClick={() => setIsStyleModalOpen(true)}
                    style={{ height: 32, padding: '0 14px', fontSize: 12.5, fontWeight: 650 }}
                  >
                    Change profile style
                  </button>
                )}
              </div>
              {user ? (
                <AccountSection onActive={handleSpy} />
              ) : (
                <div className="settings-card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                    <p style={{ margin: 0, fontSize: 13.5, color: 'rgb(var(--c-text2))' }}>
                      Browsing as a guest. Your list stays on this device.
                    </p>
                    <button
                      type="button"
                      onClick={() => setAuthOpen(true)}
                      style={{
                        height: 36,
                        padding: '0 18px',
                        borderRadius: 999,
                        border: 0,
                        background: '#ffffff',
                        color: '#09090b',
                        fontSize: 13,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      {t('nav.signIn')}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {showSection('appearance') && (
            <section id="settings-appearance" style={{ scrollMarginTop: 84, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Palette size={18} />
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{t('settings.appearance')}</h2>
              </div>

              <div className="settings-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 650 }}>Language</h3>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600 }}>Interface language</span>
                      <span
                        style={{
                          padding: '2px 7px',
                          borderRadius: 6,
                          background: 'rgba(255,255,255,0.08)',
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: '0.04em',
                          color: 'rgb(var(--c-text2))',
                        }}
                      >
                        THIS DEVICE
                      </span>
                    </div>
                    <div style={{ fontSize: 12.5, color: 'rgb(var(--c-text2))', marginTop: 3 }}>
                      Browser language: English
                    </div>
                  </div>

                  <select
                    className="watch-panel__select"
                    style={{ width: 'auto', minWidth: 140, borderRadius: 999, paddingInline: 14 }}
                    value={locale}
                    onChange={(e) => setLocale(e.target.value as typeof locale)}
                    aria-label="Interface language"
                  >
                    {locales.map((loc) => (
                      <option key={loc.tag} value={loc.tag}>
                        {loc.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="settings-card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 650 }}>Theme &amp; accent</h3>
                    <div style={{ fontSize: 12.5, color: 'rgb(var(--c-text2))', marginTop: 4 }}>Theme</div>
                  </div>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={themePrefs.followSystem}
                      onChange={(e) =>
                        setThemePrefs((p) => ({ ...p, followSystem: e.target.checked }))
                      }
                    />
                    <span>Follow system</span>
                  </label>
                </div>

                <div className="theme-swatches">
                  {THEME_OPTIONS.map((th) => {
                    const active = themePrefs.theme === th.id;
                    return (
                      <button
                        key={th.id}
                        type="button"
                        className={`theme-swatch ${active ? 'is-active' : ''}`}
                        style={{
                          background: th.swatchBg,
                          color: th.isLight ? '#18181b' : '#ffffff',
                        }}
                        onClick={() =>
                          setThemePrefs((p) => ({ ...p, theme: th.id, followSystem: false }))
                        }
                      >
                        <div className="theme-swatch__preview">
                          <span className="theme-swatch__dot" style={{ background: th.swatchDot }} />
                          <span className="theme-swatch__bar" style={{ background: th.swatchSurface }} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                          <span>{th.label}</span>
                          {active && <Check size={13} />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {themePrefs.theme === 'custom' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, paddingTop: 8 }}>
                    {(
                      [
                        { k: 'bg', l: 'Background' },
                        { k: 'surface', l: 'Surface' },
                        { k: 'accent', l: 'Accent' },
                        { k: 'text', l: 'Text' },
                      ] as const
                    ).map((field) => (
                      <label key={field.k} style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span>{field.l}</span>
                        <input
                          type="color"
                          value={themePrefs.customColors[field.k]}
                          onChange={(e) =>
                            setThemePrefs((p) => ({
                              ...p,
                              customColors: { ...p.customColors, [field.k]: e.target.value },
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                )}

                <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    {ACCENT_SWATCHES.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        aria-label={`Accent ${hex}`}
                        onClick={() => setThemePrefs((p) => ({ ...p, accentColor: hex }))}
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: '50%',
                          border: themePrefs.accentColor === hex ? '2.5px solid rgb(var(--c-text))' : '1px solid rgba(128,128,140,0.42)',
                          background: hex,
                          cursor: 'pointer',
                        }}
                      />
                    ))}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                    <span style={{ fontSize: 13.5 }}>Text size</span>
                    <div className="watch-audio-switch">
                      {(['small', 'medium', 'large'] as const).map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          aria-pressed={themePrefs.textSize === sz}
                          onClick={() => setThemePrefs((p) => ({ ...p, textSize: sz }))}
                        >
                          {sz}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13.5, cursor: 'pointer' }}>
                    <span>UI animations &amp; transitions</span>
                    <input
                      type="checkbox"
                      checked={themePrefs.animations}
                      onChange={(e) => setThemePrefs((p) => ({ ...p, animations: e.target.checked }))}
                    />
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13.5, cursor: 'pointer' }}>
                    <span>Frosted glass backdrop blur</span>
                    <input
                      type="checkbox"
                      checked={themePrefs.backdropBlur}
                      onChange={(e) => setThemePrefs((p) => ({ ...p, backdropBlur: e.target.checked }))}
                    />
                  </label>
                </div>
              </div>

              <div className="settings-card">
                <AmbientSettingsControls variant="card" />
              </div>
            </section>
          )}

          {showSection('notifications') && (
            <section id="settings-notifications" style={{ scrollMarginTop: 84, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Bell size={18} />
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{t('settings.notifications')} &amp; Privacy</h2>
              </div>
              <div className="settings-card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, cursor: 'pointer' }}>
                  <span>Anonymous audience analytics</span>
                  <input
                    type="checkbox"
                    checked={privacyPrefs.audienceAnalytics}
                    onChange={(e) =>
                      setPrivacyPrefs((p) => ({ ...p, audienceAnalytics: e.target.checked }))
                    }
                  />
                </label>
                <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, cursor: 'pointer' }}>
                  <span>Playback buffering diagnostics</span>
                  <input
                    type="checkbox"
                    checked={privacyPrefs.playbackDiagnostics}
                    onChange={(e) =>
                      setPrivacyPrefs((p) => ({ ...p, playbackDiagnostics: e.target.checked }))
                    }
                  />
                </label>
              </div>
            </section>
          )}

          {showSection('discord') && (
            <section id="settings-discord" style={{ scrollMarginTop: 84, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Radio size={18} />
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Discord Rich Presence</h2>
              </div>
              <div className="settings-card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <p style={{ margin: 0, fontSize: 13.5, color: 'rgb(var(--c-text2))', lineHeight: 1.5 }}>
                  Display the anime currently playing on 7Anime in your Discord profile activity via the local desktop companion. Runs 100% locally with zero cloud database requests.
                </p>

                {/* Connection Status Indicator */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    borderRadius: 10,
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.07)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        backgroundColor:
                          !discordPrefs.enabled
                            ? 'rgba(255, 255, 255, 0.3)'
                            : presenceState.status === 'CONNECTED' && presenceState.discordConnected
                              ? '#22c55e'
                              : presenceState.status === 'CONNECTED'
                                ? '#eab308'
                                : presenceState.status === 'CONNECTING'
                                  ? '#3b82f6'
                                  : 'rgba(255, 255, 255, 0.4)',
                        boxShadow:
                          presenceState.status === 'CONNECTED' && presenceState.discordConnected
                            ? '0 0 10px rgba(34, 197, 94, 0.5)'
                            : 'none',
                      }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                        {!discordPrefs.enabled
                          ? 'Presence Disabled (Opt-in)'
                          : presenceState.status === 'CONNECTING'
                            ? 'Connecting to Companion...'
                            : presenceState.status === 'CONNECTED' && presenceState.discordConnected
                              ? `Connected · Discord @${presenceState.discordUser?.username || 'Active'}`
                              : presenceState.status === 'CONNECTED'
                                ? 'Companion Connected · Discord Desktop Not Detected'
                                : 'Companion Offline · Local Desktop Bridge Not Running'}
                      </span>
                      <span style={{ fontSize: 11.5, color: 'rgb(var(--c-text3))' }}>
                        {!discordPrefs.enabled
                          ? 'Enable below to start sharing activity.'
                          : presenceState.status === 'CONNECTED' && presenceState.discordConnected
                            ? 'Live Rich Presence updates will sync automatically during playback.'
                            : presenceState.status === 'CONNECTED'
                              ? 'Please launch Discord desktop client on your PC to show presence.'
                              : 'Launch companion via "npm run companion" on your machine.'}
                      </span>
                    </div>
                  </div>

                  {discordPrefs.enabled && presenceState.status === 'DISCONNECTED' && (
                    <button
                      type="button"
                      className="watch-pill"
                      style={{ height: 28, fontSize: 12, padding: '0 12px' }}
                      onClick={() => discordPresenceService.connect()}
                    >
                      Retry
                    </button>
                  )}
                </div>

                {/* Preference Toggles */}
                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13.5, cursor: 'pointer' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>Enable Discord Presence</div>
                    <div style={{ fontSize: 11.5, color: 'rgb(var(--c-text3))' }}>Allow local companion to broadcast your viewing activity</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={discordPrefs.enabled}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setDiscordPrefs((p) => ({ ...p, enabled }));
                      showToast(enabled ? 'Discord Presence enabled' : 'Discord Presence disabled');
                    }}
                  />
                </label>

                <label
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 13.5,
                    cursor: discordPrefs.enabled ? 'pointer' : 'not-allowed',
                    opacity: discordPrefs.enabled ? 1 : 0.5,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>Automatically share current anime</div>
                    <div style={{ fontSize: 11.5, color: 'rgb(var(--c-text3))' }}>Update Discord activity as soon as video playback starts</div>
                  </div>
                  <input
                    type="checkbox"
                    disabled={!discordPrefs.enabled}
                    checked={discordPrefs.autoShare}
                    onChange={(e) => setDiscordPrefs((p) => ({ ...p, autoShare: e.target.checked }))}
                  />
                </label>

                <label
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 13.5,
                    cursor: discordPrefs.enabled ? 'pointer' : 'not-allowed',
                    opacity: discordPrefs.enabled ? 1 : 0.5,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>Hide anime title</div>
                    <div style={{ fontSize: 11.5, color: 'rgb(var(--c-text3))' }}>Shows generic "Watching Anime" instead of specific title</div>
                  </div>
                  <input
                    type="checkbox"
                    disabled={!discordPrefs.enabled}
                    checked={discordPrefs.hideTitle}
                    onChange={(e) => setDiscordPrefs((p) => ({ ...p, hideTitle: e.target.checked }))}
                  />
                </label>

                <label
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 13.5,
                    cursor: discordPrefs.enabled ? 'pointer' : 'not-allowed',
                    opacity: discordPrefs.enabled ? 1 : 0.5,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>Hide episode information</div>
                    <div style={{ fontSize: 11.5, color: 'rgb(var(--c-text3))' }}>Hides season and episode counts from your activity</div>
                  </div>
                  <input
                    type="checkbox"
                    disabled={!discordPrefs.enabled}
                    checked={discordPrefs.hideEpisode}
                    onChange={(e) => setDiscordPrefs((p) => ({ ...p, hideEpisode: e.target.checked }))}
                  />
                </label>

                {/* Companion Action Button & Setup Guide */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, paddingTop: 4 }}>
                  <button
                    type="button"
                    className="watch-pill"
                    onClick={() => {
                      discordPresenceService.clearActivity();
                      discordPresenceService.disconnect();
                      showToast('Discord activity cleared');
                    }}
                  >
                    Disconnect & Clear Activity
                  </button>
                </div>

                <div
                  style={{
                    marginTop: 6,
                    padding: '12px 14px',
                    borderRadius: 8,
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px dashed rgba(255, 255, 255, 0.1)',
                    fontSize: 12,
                    color: 'rgb(var(--c-text3))',
                    lineHeight: 1.6,
                  }}
                >
                  <strong style={{ color: 'rgb(var(--c-text1))' }}>How to launch the Companion:</strong>
                  <br />
                  Run <code style={{ color: 'var(--c-accent, #b29ce0)', background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 4 }}>npm run companion</code> in your terminal on this computer. It connects to your Discord desktop client over local named pipes.
                </div>
              </div>
            </section>
          )}

          {showSection('data') && (
            <section id="settings-data" style={{ scrollMarginTop: 84, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Shield size={18} />
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{t('settings.yourData')}</h2>
              </div>
              <div className="settings-card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <p style={{ margin: 0, fontSize: 13.5, color: 'rgb(var(--c-text2))' }}>
                  All local watch progress, lists, folders, and appearance preferences stay right in your browser unless you sign in to sync.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  <button type="button" className="watch-pill" onClick={handleExport}>
                    Export storage JSON
                  </button>
                  <button type="button" className="watch-pill" onClick={clearHistory}>
                    Clear watch history
                  </button>
                  <button
                    type="button"
                    className="watch-pill"
                    onClick={() => {
                      clearRecentSearches();
                      showToast('Recent searches cleared');
                    }}
                  >
                    Clear recent searches
                  </button>
                  <button
                    type="button"
                    className="watch-pill"
                    style={{ color: '#fda4af', borderColor: 'rgba(251,113,133,0.35)' }}
                    onClick={resetDeviceData}
                  >
                    Reset all device data
                  </button>
                </div>
              </div>

              {/* Centralized Intelligent Cache Diagnostics Card */}
              <div className="settings-card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Database size={16} style={{ color: 'rgb(var(--c-accent))' }} />
                    <span style={{ fontSize: 15, fontWeight: 700 }}>
                      Intelligent Cache System (L1 Memory & L2 IndexedDB)
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: '3px 8px',
                      borderRadius: 12,
                      background: 'rgba(var(--c-accent), 0.15)',
                      color: 'rgb(var(--c-accent))',
                    }}
                  >
                    Hit Ratio: {cacheStats.hitRatio}%
                  </span>
                </div>

                <p style={{ margin: 0, fontSize: 13, color: 'rgb(var(--c-text2))' }}>
                  Multi-tier caching prevents duplicate network requests, accelerates page navigation with Stale-While-Revalidate, and persists public metadata across browser sessions.
                </p>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                    gap: 10,
                  }}
                >
                  <div style={{ padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: 11, color: 'rgb(var(--c-text2))' }}>L1 Memory Hits</div>
                    <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }}>{cacheStats.hitsL1}</div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: 11, color: 'rgb(var(--c-text2))' }}>L2 Persistent Hits</div>
                    <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }}>{cacheStats.hitsL2}</div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: 11, color: 'rgb(var(--c-text2))' }}>Deduplicated</div>
                    <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }}>{cacheStats.deduplications}</div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: 11, color: 'rgb(var(--c-text2))' }}>SWR Refreshes</div>
                    <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }}>{cacheStats.revalidations}</div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: 11, color: 'rgb(var(--c-text2))' }}>Cache Entries</div>
                    <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }}>{cacheStats.entryCountL1}</div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: 11, color: 'rgb(var(--c-text2))' }}>Estimated Size</div>
                    <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }}>
                      {(cacheStats.bytesEstimate / 1024).toFixed(1)} KB
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                  <button
                    type="button"
                    className="watch-pill"
                    onClick={async () => {
                      await cacheManager.clear();
                      showToast('Cache purged successfully');
                    }}
                  >
                    Purge All Cache
                  </button>
                  <button
                    type="button"
                    className="watch-pill"
                    onClick={async () => {
                      const purged = await cacheManager.invalidateByPrefix('anime:search:');
                      showToast(`Purged ${purged} search cache entries`);
                    }}
                  >
                    Purge Search Cache
                  </button>
                  <button
                    type="button"
                    className="watch-pill"
                    onClick={() => {
                      imageTracker.clear();
                      showToast('Image negative cache reset');
                    }}
                  >
                    Reset Broken Image Tracker
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>

      {user && (
        <ProfileStyleModal
          isOpen={isStyleModalOpen}
          onClose={() => setIsStyleModalOpen(false)}
          currentDecoration={user.avatarDecoration}
          currentBannerEffect={user.bannerEffect}
          onSave={(dec, bfx) => {
            updateUserProfile({ avatarDecoration: dec, bannerEffect: bfx });
            if (apiClient.isAuthenticated()) {
              apiClient.updateProfile({ avatarDecoration: dec, bannerEffect: bfx }).catch(() => {});
            }
          }}
        />
      )}
    </div>
  );
};
