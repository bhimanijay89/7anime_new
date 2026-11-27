import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  createWebAmbilight,
  type AmbilightViewMode,
  type WebAmbilightController,
} from 'youtube-ambientlight';
import 'youtube-ambientlight/styles.css';
import type { AmbientSettings } from '@/src/types/settings';
import {
  getCurrentPlayerLayout,
  toWebAmbilightSettings,
} from '@/src/services/player/ambientSettings';

export type LiveAmbientStatus = 'idle' | 'live' | 'fallback';

export interface UseLiveAmbientOptions {
  videoElement: HTMLVideoElement | null;
  stageRef: RefObject<HTMLDivElement | null>;
  videoContainerRef: RefObject<HTMLDivElement | null>;
  isFullscreen: boolean;
  theaterMode: boolean;
  enabled: boolean;
  settings: AmbientSettings;
  sourceKey: string;
}

export function useLiveAmbient({
  videoElement,
  stageRef,
  videoContainerRef,
  isFullscreen,
  theaterMode,
  enabled,
  settings,
  sourceKey,
}: UseLiveAmbientOptions): { status: LiveAmbientStatus } {
  const [status, setStatus] = useState<LiveAmbientStatus>('idle');
  const controllerRef = useRef<WebAmbilightController | null>(null);

  const activeView: AmbilightViewMode = getCurrentPlayerLayout({
    isFullscreen,
    theaterMode,
  });
  const viewRef = useRef<AmbilightViewMode>(activeView);
  const initialSettingsRef = useRef(toWebAmbilightSettings(settings, enabled));

  useEffect(() => {
    viewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    initialSettingsRef.current = toWebAmbilightSettings(settings, enabled);
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!videoElement || !stage) {
      return;
    }

    let disposed = false;

    const controller = createWebAmbilight({
      video: videoElement,
      stage,
      videoContainer: videoElement.parentElement || videoContainerRef.current,
      scrollContainer: stage.closest('.content.browse-scroll') as HTMLElement | null,
      getFullscreenElement: () => document.fullscreenElement || videoContainerRef.current || stage,
      getView: () => viewRef.current,
      settings: initialSettingsRef.current,
      onFrameRendered: () => {
        if (!disposed) {
          setStatus((prev) => (prev === 'live' ? prev : 'live'));
        }
      },
      onVisibilityChange: (visible) => {
        if (!disposed && !visible) {
          setStatus('idle');
        }
      },
    });

    controllerRef.current = controller;

    return () => {
      disposed = true;
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      controller.destroy();
      setStatus('idle');
    };
  }, [videoElement, stageRef, videoContainerRef]);

  useEffect(() => {
    controllerRef.current?.updateSettings(toWebAmbilightSettings(settings, enabled)).catch(() => {});
  }, [
    enabled,
    settings,
    settings.blur,
    settings.spread,
    settings.fadeDuration,
    settings.enabledLayouts.small,
    settings.enabledLayouts.theater,
    settings.enabledLayouts.fullscreen,
  ]);

  useEffect(() => {
    controllerRef.current?.setView(activeView).catch(() => {});
  }, [activeView]);

  useEffect(() => {
    controllerRef.current?.resize().catch(() => {});
  }, [sourceKey]);

  return { status: videoElement && enabled ? status : 'idle' };
}
