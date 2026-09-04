// Kept separate from vite.config.ts so the build config stays about building.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // falCatalog.ts reads its cache from localStorage at import time, so the
    // hull modules need a DOM even though none of these tests render anything.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
