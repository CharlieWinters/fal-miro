import 'dotenv/config';
import { serve } from '@hono/node-server';

import { app } from './app.js';

const {
  FAL_KEY,
  ADMIN_KEY,
  BACKEND_KEY,
  ALLOWED_ORIGINS = 'http://localhost:5175',
  PORT = '8789',
} = process.env;

if (!ADMIN_KEY) {
  console.warn('[boot] ADMIN_KEY is not set. /api/fal/balance (credits) will return an error.');
}
if (!FAL_KEY) {
  console.warn(
    '[boot] FAL_KEY is not set. /api/fal/run and /api/fal/status will fail ' +
      'until you set it. Get one at https://fal.ai/dashboard/keys',
  );
}
if (!BACKEND_KEY) {
  console.warn(
    '[boot] BACKEND_KEY is not set. Every /api/fal/* request will be rejected ' +
      'until you set one (any random string — the frontend sends it back as ' +
      'the x-fal-proxy-key header) — this is what stops anyone but your ' +
      'frontend from spending your FAL_KEY credits.',
  );
}

const allowedOrigins = ALLOWED_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

serve({ fetch: app.fetch, port: Number(PORT) }, () => {
  console.log(`[boot] fal-miro backend listening on http://localhost:${PORT}`);
  console.log(`[boot] allowed origins: ${allowedOrigins.join(', ') || '(none)'}`);
});
