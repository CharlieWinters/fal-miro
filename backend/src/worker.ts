// Cloudflare Workers entrypoint — deploy with `npm run deploy:worker`
// (wrangler). Set secrets first: `wrangler secret put FAL_KEY` (and
// `ADMIN_KEY` if you want the credits badge / catalog discovery to work).
// See wrangler.toml for the non-secret vars (ALLOWED_ORIGINS, etc).
//
// Hono app instances implement the `fetch(request, env, ctx)` signature
// Workers expects directly, so this file is just the export.
import { app } from './app.js';

export default app;
