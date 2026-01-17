import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { signalingServerPlugin } from './vite-plugin-signaling';

export default defineConfig({
  envPrefix: ['VITE_', 'QUICKSAVE_'],
  server: {
    host: true, // Allow external access (needed for ngrok)
    port: 5173,
    allowedHosts: ['.ngrok-free.app', '.ngrok.io'],
  },
  plugins: [
    signalingServerPlugin(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
      manifest: {
        name: 'Quicksave',
        short_name: 'Quicksave',
        description: 'Remote git control with E2E encryption',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  optimizeDeps: {
    include: ['@quicksave/shared'],
  },
});
