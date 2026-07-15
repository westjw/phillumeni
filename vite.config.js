import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // Baked in at build time and shown in Profile — the ground truth for "which
  // code am I actually running?" (a stale native bundle hid for a week without it)
  define: {
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // registered manually in main.jsx (focus-based update check)
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'phillumeni',
        short_name: 'phillumeni',
        description: 'Collect matchbooks from the spots that still have them.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#1A1918',
        theme_color: '#1A1918',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // precache the app shell; only .woff2 fonts (the 2.8MB .ttf is skipped),
        // and the lazy mapbox chunk stays under the default size limit.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
})
