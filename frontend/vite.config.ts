import path from 'path';
import fs from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Each .html at the project root becomes a separate build entry — one per
// iframe (index = headless, app = panel, modal = modal).
const htmlEntries = fs
  .readdirSync('.')
  .filter((file) => path.extname(file) === '.html')
  .reduce((acc: Record<string, string>, file) => {
    acc[path.basename(file, '.html')] = path.resolve(__dirname, file);
    return acc;
  }, {});

export default defineConfig(({ command }) => ({
  // GitHub Pages serves this as a project site at /fal-miro/, not the domain
  // root — every asset/embed URL in the app already goes through Vite's
  // import.meta.env.BASE_URL (see frontendPageUrl in lib/api.ts), so this one
  // line is enough. Dev server stays at '/' so `npm run dev` is unaffected.
  base: command === 'build' ? '/fal-miro/' : '/',
  build: {
    rollupOptions: {
      input: htmlEntries,
    },
  },
  plugins: [react()],
  server: {
    // Runway uses 5173, ElevenLabs 5174 — keep this app on its own port.
    port: 5175,
  },
}));
