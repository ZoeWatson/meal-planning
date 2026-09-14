import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { registerSW } from 'virtual:pwa-register';

import { App } from './App';
// Imported for its side effect: it registers the `beforeinstallprompt` listener
// at module load. The event fires before React mounts and is not replayed, so
// catching it cannot wait for a component. Named here rather than left to the
// import graph, so that reordering something in App.tsx cannot quietly break it.
import './pwa/install';
import { ensureSeeded } from './db/repository';
import { getSyncMeta } from './db/syncWrites';
import { startAutoSync } from './sync/syncManager';
import './styles.css';

/**
 * The service worker is what makes the browser build work offline, and it is
 * only ever registered there.
 *
 * The Android build has no use for it — its assets ship inside the APK, so there
 * is no network for a cache to stand in front of — and a real cost: the worker's
 * cache survives an app update, so a stale one can keep serving an old build
 * inside a new app, where there is no address bar to force a reload from.
 */
if (!Capacitor.isNativePlatform()) {
  registerSW({ immediate: true });

  /**
   * Asks the browser not to evict the database.
   *
   * Without this, IndexedDB is "best effort" storage: browsers are free to clear
   * it under disk pressure, and Safari drops it outright after about a week of
   * not opening the site. That is survivable when a server holds a copy. Here
   * nothing does — the only other copy is a transfer file the user remembered to
   * export — so eviction is not a cache miss, it is every plan, tick and price
   * gone with no way back.
   *
   * Granted silently for an installed app in the browsers that matter, and
   * refused without a prompt where it is not. Either way it is worth asking, and
   * not worth telling the user about: there is nothing they could do in response.
   * The native build needs none of this, because an installed app's storage is
   * not the browser's to reclaim.
   */
  void navigator.storage?.persist?.().catch(() => undefined);
}

/**
 * Seeding happens before first paint so the app never renders an empty library
 * and then pops content in. It is idempotent and cheap after the first run.
 */
void ensureSeeded()
  .catch((err: unknown) => {
    console.error('Failed to seed the recipe library', err);
  })
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    // Started after render, and only when this device is actually linked — an
    // unlinked device should never touch the network at all.
    void getSyncMeta().then((meta) => {
      if (meta.spaceId) startAutoSync();
    });
  });
