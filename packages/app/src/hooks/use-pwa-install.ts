import { useCallback, useEffect, useState } from "react";
import { isWeb } from "@/constants/platform";

// `BeforeInstallPromptEvent` ships only on Chromium-family browsers that
// support the Web App Install banner. We accept it loosely because the
// runtime contract is the only thing this hook depends on.
interface BeforeInstallPromptEventLike extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function readIsStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const media = window.matchMedia?.("(display-mode: standalone)");
  if (media?.matches) return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;

  // iPadOS 13+ reports as Mac. Touch points are the giveaway.
  const isIpad =
    /iPad/.test(ua) ||
    (navigator.platform === "MacIntel" &&
      typeof navigator.maxTouchPoints === "number" &&
      navigator.maxTouchPoints > 1);

  const isIOS = /iPad|iPhone|iPod/.test(ua) || isIpad;
  const isWebkit = /WebKit/.test(ua);
  // Exclude Chrome on iOS (CriOS) and other WebKit-cloaked browsers — only
  // stock Safari gets the "Add to Home Screen" affordance.
  const isOtherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return isIOS && isWebkit && !isOtherBrowser;
}

export interface PwaInstallState {
  /** True if the user is already running the installed app (no banner needed). */
  isStandalone: boolean;
  /** True if the browser has fired `beforeinstallprompt` and the user is not yet installed. */
  canInstall: boolean;
  /** True if the platform is iOS Safari, which has no `beforeinstallprompt` event. */
  isIosUnsupported: boolean;
  /** True on any web platform where the user *could* install but the event hasn't fired yet. */
  showManual: boolean;
  /** Triggers the browser's install UI. Resolves after the user makes a choice. */
  prompt(): Promise<boolean>;
}

const NOOP_STATE: PwaInstallState = {
  isStandalone: false,
  canInstall: false,
  isIosUnsupported: false,
  showManual: false,
  async prompt() {
    return false;
  },
};

export function usePwaInstall(): PwaInstallState {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEventLike | null>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(false);
  const [isIos, setIsIos] = useState<boolean>(false);
  const [hasMounted, setHasMounted] = useState<boolean>(false);

  useEffect(() => {
    if (!isWeb) return;
    setIsStandalone(readIsStandalone());
    setIsIos(isIosSafari());
    setHasMounted(true);

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEventLike);
    };

    const onAppInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const prompt = useCallback(async (): Promise<boolean> => {
    if (!deferredPrompt) return false;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      return choice.outcome === "accepted";
    } catch {
      setDeferredPrompt(null);
      return false;
    }
  }, [deferredPrompt]);

  if (!isWeb) return NOOP_STATE;
  if (isStandalone) {
    return {
      isStandalone: true,
      canInstall: false,
      isIosUnsupported: false,
      showManual: false,
      prompt,
    };
  }
  const canInstall = deferredPrompt !== null;
  const isIosUnsupported = isIos && !canInstall;
  // Always show a discoverable button on web (not-yet-installed) so the user
  // can find the install affordance even before Chrome fires the event. The
  // click handler still gates on `deferredPrompt` so we never invoke a
  // missing prompt.
  const showManual = hasMounted && !canInstall && !isStandalone;
  return {
    isStandalone: false,
    canInstall,
    isIosUnsupported,
    showManual,
    prompt,
  };
}
