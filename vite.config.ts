import { defineConfig } from 'vite';

export default defineConfig({
  // Keep local development at /; Pages publishes this repository under its own path.
  base: process.env.RALLY_BASE_PATH || '/',
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          motion: ['gsap'],
        },
      },
    },
  },
});
