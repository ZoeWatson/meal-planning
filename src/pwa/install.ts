/**
 * The browser's install prompt, wrapped so the app can ask rather than wait.
 *
 * Left alone, Chrome decides when to offer installation, and what it decides is
 * mostly "not yet" — the prompt is buried in a menu most people never open, and
 * the automatic bar that used to appear no longer reliably does. For anyone being
 * sent this app by a relative, an install that lives behind ⋮ is an install that
 * does not happen.
 *
 * `beforeinstallprompt` is the way out: catch the event, stop the browser doing
 * anything with it, and fire it later from a button on a screen that explains
 * what installing means.
 *
 * THE LISTENER IS REGISTERED AT MODULE LOAD, ON PURPOSE. The event fires early —
 * routinely before React has mounted — and it is not replayed for a listener that
 * turns up afterwards. Registering this from inside a component is the standard
 * way to build an install button that works on your machine and never fires on
 * anyone else's. `main.tsx` imports this module for that reason and no other.
 */

import { Capacitor } from '@capacitor/core';

import { installRouteFor, type BrowserFacts, type InstallHow } from './installRoute';

/** Not in TypeScript's DOM lib: it is Chromium-only and not on a standards track. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState =
  /** Already an app: running standalone, or inside the Android build. */
  | { readonly kind: 'installed' }
  /** The browser has offered a prompt and the button will work. */
  | { readonly kind: 'ready' }
  /** No prompt on offer, so the only honest thing to show is directions. */
  | { readonly kind: 'manual'; readonly how: InstallHow };

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;

const listeners = new Set<() => void>();

/**
 * Cached because `useSyncExternalStore` compares snapshots by identity: building
 * a fresh object per call would report a change on every render and loop.
 */
let snapshot: InstallState = { kind: 'manual', how: 'menu' };

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    // iOS does not support the display-mode query and has its own flag instead.
    || (window.navigator as { standalone?: boolean }).standalone === true;
}

function facts(): BrowserFacts {
  if (typeof navigator === 'undefined') return { userAgent: '', platform: '', maxTouchPoints: 0 };
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  };
}

function compute(): InstallState {
  if (installed || isStandalone() || Capacitor.isNativePlatform()) return { kind: 'installed' };
  if (deferred) return { kind: 'ready' };
  // Nothing to fire. For most of these browsers directions are not a fallback,
  // they are the only route — and for one of them there is no route to describe.
  return { kind: 'manual', how: installRouteFor(facts()) };
}

function refresh(): void {
  const next = compute();
  const same = next.kind === snapshot.kind
    && (next.kind !== 'manual' || next.how === (snapshot as { how?: string }).how);
  if (same) return;

  snapshot = next;
  for (const listener of listeners) listener();
}

export function subscribeToInstallState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getInstallState(): InstallState {
  return snapshot;
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

/**
 * Shows the browser's install prompt.
 *
 * The event is single-use — a second `prompt()` on the same one throws — so it is
 * dropped afterwards whatever the user chose. Chrome fires a fresh event if it
 * decides the app is installable again, and the screen follows that back to a
 * working button on its own.
 */
export async function promptInstall(): Promise<InstallOutcome> {
  const event = deferred;
  if (!event) return 'unavailable';

  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } finally {
    deferred = null;
    refresh();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Stops Chrome showing anything of its own. The app is about to offer this
    // properly, and two competing invitations is worse than either alone.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    refresh();
  });

  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;

    /**
     * Asked again here because this is the moment it is most likely to be
     * granted: browsers weigh installation heavily, and the request made at
     * startup on a first visit is usually declined. Getting it now is what makes
     * the difference between data that survives and data the browser is free to
     * evict — which matters more here than in most apps, since there is no server
     * holding a second copy.
     */
    void navigator.storage?.persist?.().catch(() => undefined);

    refresh();
  });

  // Catches the case where the app is opened standalone in a session that began
  // in a tab, so the Install tab does not linger after it stops meaning anything.
  window.matchMedia('(display-mode: standalone)').addEventListener('change', refresh);

  snapshot = compute();
}
