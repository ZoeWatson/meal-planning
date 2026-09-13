import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Offline is a hard requirement, not a nice-to-have — the grocery list gets used
 * in a supermarket where the signal is poor.
 *
 * The whole app is client-side: the recipe library lives in IndexedDB and the
 * planner runs in the browser, so precaching the shell is genuinely sufficient
 * for full functionality with the radio off. There is no API to be unavailable.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      /**
       * Registered by hand in `main.tsx` rather than injected into the page,
       * because there are now two things this build runs inside and only one of
       * them wants a service worker.
       *
       * In the browser it is what makes the app work with the radio off. Inside
       * the Android app it is worse than useless: the assets are already on the
       * device, so it caches local files against no network, and its cache
       * outlives an APK update — which means a worker installed by last month's
       * build can keep serving last month's app over the top of the new one, with
       * no address bar to reload from and nothing on screen to explain it.
       */
      injectRegister: null,
      includeAssets: ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      manifest: {
        name: 'Meal Planning',
        short_name: 'Meals',
        description: 'Weekly meal plans that overlap ingredients, and the grocery list to match.',
        theme_color: '#1f6f4a',
        background_color: '#faf9f7',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        /**
         * The OCR runtime is ~20 MB and two of its three wasm cores will never
         * be used on any given device, so precaching it would mean every visitor
         * paying for photo import whether or not they ever open it — including
         * the ones who came to tick off a shopping list.
         *
         * It is fetched on first use instead and cached by the browser from
         * there, which is the right shape for a feature this heavy and this
         * occasional. `.wasm.js` has to be named explicitly: it ends in `.js`
         * and would otherwise be swept up by the pattern above.
         */
        globIgnores: ['**/tesseract/**'],
        cleanupOutdatedCaches: true,
        // One core is ~4 MB; the default 2 MB ceiling would silently drop it.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
});
