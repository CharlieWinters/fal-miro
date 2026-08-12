import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';

import { app } from './app.js';
import { setFallbackMiroTokenStore, type StoredMiroToken } from './lib/miroOauth.js';

// Persist OAuth tokens to a local gitignored file instead of the plain
// in-memory Map lib/miroOauth.ts falls back to otherwise — `tsx watch`
// restarts this whole process on every source-file save, which was
// silently wiping an in-memory store on every edit during development.
// Production self-hosts should still prefer the Workers KV binding
// (wrangler.toml) over this; this is a Node/local-dev convenience only.
const TOKENS_FILE = fileURLToPath(new URL('../.miro-tokens.json', import.meta.url));

function readTokenFile(): Record<string, StoredMiroToken> {
  try {
    if (!existsSync(TOKENS_FILE)) return {};
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
  } catch (e) {
    console.warn('[boot] failed to read .miro-tokens.json, starting empty:', e);
    return {};
  }
}

function writeTokenFile(data: Record<string, StoredMiroToken>): void {
  writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
}

setFallbackMiroTokenStore({
  async get(userId) {
    return readTokenFile()[userId] ?? null;
  },
  async put(userId, token) {
    const data = readTokenFile();
    data[userId] = token;
    writeTokenFile(data);
  },
});

const {
  FAL_KEY,
  ADMIN_KEY,
  BACKEND_KEY,
  MIRO_CLIENT_ID,
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
if (!MIRO_CLIENT_ID) {
  console.log(
    '[boot] MIRO_CLIENT_ID is not set. That\'s fine unless you want "Connect ' +
      'Miro account" (reading Doc-format item content) — see .dev.vars.example.',
  );
}

const allowedOrigins = ALLOWED_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

serve({ fetch: app.fetch, port: Number(PORT) }, () => {
  console.log(`[boot] fal-miro backend listening on http://localhost:${PORT}`);
  console.log(`[boot] allowed origins: ${allowedOrigins.join(', ') || '(none)'}`);
});
