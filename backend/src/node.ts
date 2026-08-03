import 'dotenv/config';
import { serve } from '@hono/node-server';

import { app } from './app.js';

const { FAL_KEY, ADMIN_KEY, ALLOWED_ORIGINS = 'http://localhost:5175', PORT = '8789' } = process.env;

if (!ADMIN_KEY) {
  console.warn('[boot] ADMIN_KEY is not set. /api/fal/balance (credits) will return an error.');
}
if (!FAL_KEY) {
  console.warn(
    '[boot] FAL_KEY is not set. /api/fal/run and /api/fal/status will fail ' +
      'until you set it. Get one at https://fal.ai/dashboard/keys',
  );
}

const allowedOrigins = ALLOWED_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

serve({ fetch: app.fetch, port: Number(PORT) }, () => {
  console.log(`[boot] fal-miro backend listening on http://localhost:${PORT}`);
  console.log(`[boot] allowed origins: ${allowedOrigins.join(', ') || '(none)'}`);
});
