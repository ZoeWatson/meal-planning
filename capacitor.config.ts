import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android wrapper.
 *
 * Nothing here changes how the app works — it is the same `dist` the browser
 * gets, running in a WebView with a filesystem and a share sheet attached. The
 * two things it buys are an icon on the phone that opens without a browser, and
 * storage that belongs to an installed app rather than to a browser that is free
 * to evict it.
 *
 * `appId` is the identity Android knows this app by. Changing it later installs a
 * *second*, separate app alongside the first, with its own empty database — so it
 * is effectively permanent once anything is installed.
 */
const config: CapacitorConfig = {
  appId: 'com.zoewatson.mealplanning',
  appName: 'Meal Planning',
  webDir: 'dist',
  android: {
    /**
     * Served from `https://localhost` rather than a custom scheme.
     *
     * IndexedDB is partitioned by origin, and the origin here is whatever the
     * WebView is told to serve from. Pinning it means the database survives app
     * updates; letting it vary would strand every plan and shopping list the user
     * had, silently, on the next release.
     */
    androidScheme: 'https',
  },
};

export default config;
