import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import https from 'node:https';
import { fal } from '@fal-ai/client';

const {
  FAL_KEY,
  // Separate Admin API key — required for account/billing (Fal won't serve
  // billing with a regular inference key). Also used for the pricing endpoint.
  ADMIN_KEY,
  ALLOWED_ORIGINS = 'http://localhost:5175',
  PORT = 8789,
  FAL_PLATFORM_API_BASE = 'https://api.fal.ai/v1',
  DEBUG = '1',
} = process.env;

if (!ADMIN_KEY) {
  console.warn('[boot] ADMIN_KEY is not set. /api/fal/balance (credits) will return an error.');
}
if (!FAL_KEY) {
  console.warn(
    '[boot] FAL_KEY is not set. /api/fal/run and /api/fal/status will fail ' +
      'until you set it. Get one at https://fal.ai/dashboard/keys',
  );
} else {
  // The client also auto-reads FAL_KEY from env, but configure explicitly so
  // it's obvious where credentials come from.
  fal.config({ credentials: FAL_KEY });
}

const allowedOrigins = ALLOWED_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const debug = DEBUG !== '0' && DEBUG !== 'false';

const app = express();
// Fal inputs can carry base64 data URIs (e.g. an image picked off the board),
// so allow a generous JSON body.
app.use(express.json({ limit: '50mb' }));
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow listed origins (the frontend). For anything else — including the
      // backend's own origin loading /embed + /proxy subresources — don't throw
      // (that would 500 the request); just decline to add CORS headers. Routes
      // that must be cross-origin readable (e.g. /proxy) set their own.
      cb(null, !origin || allowedOrigins.includes(origin));
    },
    methods: ['GET', 'POST'],
  }),
);

// ---------------------------------------------------------------------------
// Logging helpers (mirrors the Runway/ElevenLabs backend's boxed style).
// ---------------------------------------------------------------------------

/** Truncate a long string (e.g. base64 data URI) so logs stay readable. */
function summarize(value) {
  if (typeof value !== 'string') return value;
  if (value.length <= 80) return value;
  return `${value.slice(0, 60)}…(${value.length} chars)`;
}

/** Shallow-summarize an input object so data URIs don't flood the console. */
function summarizeInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = summarize(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? summarize(x) : x));
    else out[k] = v;
  }
  return out;
}

function logBox(label, body) {
  if (!debug) return;
  const dashes = '─'.repeat(60);
  console.log(`\n┌${dashes}`);
  console.log(`│ ${label}`);
  console.log(`├${dashes}`);
  console.log(JSON.stringify(body, null, 2).replace(/^/gm, '│ '));
  console.log(`└${dashes}\n`);
}

// ---------------------------------------------------------------------------
// Output extraction — every Fal model returns a slightly different result
// shape. This best-effort helper pulls primary media URLs out so the frontend
// has a consistent `output: string[]` to drop on the board, while `data`
// always carries the full untouched result for anything model-specific.
// ---------------------------------------------------------------------------

function extractOutputUrls(data) {
  if (!data || typeof data !== 'object') return [];
  const urls = [];

  const pushUrl = (obj) => {
    if (obj && typeof obj === 'object' && typeof obj.url === 'string') urls.push(obj.url);
    else if (typeof obj === 'string' && /^https?:\/\//.test(obj)) urls.push(obj);
  };

  // Common Fal output keys across image / video / audio / segmentation models.
  if (Array.isArray(data.images)) data.images.forEach(pushUrl);
  pushUrl(data.image);
  pushUrl(data.video);
  pushUrl(data.audio);
  if (Array.isArray(data.audios)) data.audios.forEach(pushUrl);
  pushUrl(data.audio_url);
  pushUrl(data.video_url);
  // SAM 3 returns masks[] (the masked/extracted image when apply_mask is on).
  if (Array.isArray(data.masks)) data.masks.forEach(pushUrl);
  // Image-to-3D models return the mesh under varying keys — Hunyuan3D uses
  // `model_mesh`, others `model_glb` / `mesh`. Prefer a .glb (what our on-board
  // viewer renders); fall back to `model_obj` last.
  const glb = firstGlbUrl(data);
  if (glb) urls.push(glb);
  else {
    pushUrl(data.model_mesh);
    pushUrl(data.model_glb);
    pushUrl(data.mesh);
    pushUrl(data.model_obj);
  }
  // Meshy rigging: prefer an animated glb so the board embed moves.
  const rig = firstRiggedGlb(data);
  if (rig) urls.push(rig);

  return urls;
}

/** Pick a playable animated glb from a Meshy rigging result (walk first). */
function firstRiggedGlb(data) {
  const pick = (f) => (f && typeof f === 'object' && typeof f.url === 'string' ? f.url : null);
  const ba = data.basic_animations ?? {};
  const firstAnim =
    Array.isArray(data.animations) && data.animations.length ? pick(data.animations[0].animation_glb) : null;
  return pick(ba.walking_glb) ?? pick(ba.running_glb) ?? firstAnim ?? pick(data.rigged_character_glb);
}

/** Pull the first .glb URL out of a 3D model result, if any. */
function firstGlbUrl(data) {
  for (const key of ['model_mesh', 'model_glb', 'mesh', 'model_obj']) {
    const obj = data[key];
    const url = obj && typeof obj === 'object' ? obj.url : typeof obj === 'string' ? obj : null;
    if (typeof url === 'string' && /\.glb(\?|$)/i.test(url)) return url;
  }
  return null;
}

/** Normalize Fal's queue status to a small, stable enum for the frontend. */
function normalizeStatus(falStatus) {
  switch (falStatus) {
    case 'IN_QUEUE':
      return 'QUEUED';
    case 'IN_PROGRESS':
      return 'RUNNING';
    case 'COMPLETED':
      return 'SUCCEEDED';
    default:
      return falStatus || 'UNKNOWN';
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) =>
  res.json({ ok: true, hasKey: Boolean(FAL_KEY), hasAdminKey: Boolean(ADMIN_KEY) }),
);

// ---------------------------------------------------------------------------
// Video embed player
//
// Miro has no native video widget, but its embed widget renders any iframable
// URL. Fal returns a plain .mp4 URL, so we wrap it in a tiny HTML5 <video>
// player page and point a Miro embed at this route.
//
//   GET /embed/video?url=<encoded fal video url>
// ---------------------------------------------------------------------------
app.get('/embed/video', (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).send('Missing or invalid url');
  }
  const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { margin: 0; height: 100%; background: #000; }
    video { width: 100%; height: 100%; object-fit: contain; display: block; }
  </style>
</head>
<body>
  <video src="${safe}" controls autoplay muted loop playsinline></video>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Audio player
//
// Same embed trick as /embed/video: Fal music/TTS models return a plain audio
// URL (.mp3/.wav/…), so we wrap it in an <audio> player page and point a Miro
// embed at this route — giving a real player on the board.
//
//   GET /embed/audio?url=<encoded fal audio url>
// ---------------------------------------------------------------------------
app.get('/embed/audio', (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).send('Missing or invalid url');
  }
  const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { margin: 0; height: 100%; }
    body {
      background: #141417;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 0 18px;
      box-sizing: border-box;
      font-family: system-ui, sans-serif;
    }
    .badge {
      flex: 0 0 auto;
      width: 44px;
      height: 44px;
      border-radius: 11px;
      background: rgba(255, 221, 51, 0.14);
      border: 1px solid rgba(255, 221, 51, 0.4);
      color: #FFDD33;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
    }
    audio { flex: 1 1 auto; width: 100%; height: 40px; }
  </style>
</head>
<body>
  <div class="badge">&#9835;</div>
  <audio src="${safe}" controls preload="metadata"></audio>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// 3D model viewer
//
// Miro has no 3D data format, but its embed widget renders any iframable URL —
// the same trick as /embed/video. Image-to-3D models return a .glb; we wrap it
// in a Google <model-viewer> page so the mesh is orbit-able right on the board.
//
//   GET /embed/3d?url=<encoded fal .glb url>
// ---------------------------------------------------------------------------
app.get('/embed/3d', (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).send('Missing or invalid url');
  }
  const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script type="module" src="https://unpkg.com/@google/model-viewer@3.5.0/dist/model-viewer.min.js"></script>
  <style>
    html, body { margin: 0; height: 100%; background: #14142b; }
    model-viewer { width: 100%; height: 100%; --poster-color: #14142b; }
    .err { color: #fca5a5; font-family: system-ui, sans-serif; padding: 16px; }
  </style>
</head>
<body>
  <model-viewer
    src="${safe}"
    camera-controls
    auto-rotate
    touch-action="pan-y"
    shadow-intensity="1"
    exposure="1"
    environment-image="neutral"
    ar
  ></model-viewer>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Rigged-character viewer
//
// Meshy rigging returns an animated .glb (mesh + a skeletal animation clip).
// Same declarative <model-viewer> as /embed/3d, but with `autoplay` so the
// character animates on the board (and camera-controls to orbit it).
//
//   GET /embed/rig?url=<encoded animated .glb url>
// ---------------------------------------------------------------------------
app.get('/embed/rig', (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).send('Missing or invalid url');
  }
  const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script type="module" src="https://unpkg.com/@google/model-viewer@3.5.0/dist/model-viewer.min.js"></script>
  <style>
    html, body { margin: 0; height: 100%; background: #14142b; }
    model-viewer { width: 100%; height: 100%; --poster-color: #14142b; }
  </style>
</head>
<body>
  <model-viewer
    src="${safe}"
    autoplay
    camera-controls
    touch-action="pan-y"
    shadow-intensity="1"
    exposure="1"
    environment-image="neutral"
  ></model-viewer>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// 360° panorama viewer
//
// Image-to-panorama (Hunyuan World) returns an equirectangular 2:1 image. We
// map it to the inside of a sphere so the board shows an interactive
// photosphere — drag to look around. Same embed-any-URL trick as /embed/video
// and /embed/3d, and — like /embed/3d's <model-viewer> — it's fully
// declarative (A-Frame's <a-sky> + one external script), because the generic
// embed iframe doesn't run inline ES-module / import-map scripts.
//
// The texture loads via our own /proxy (same origin) so WebGL doesn't refuse
// the cross-origin image.
//
//   GET /embed/panorama?url=<encoded equirectangular image url>
// ---------------------------------------------------------------------------
app.get('/embed/panorama', (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).send('Missing or invalid url');
  }
  // Load the texture through our proxy (same origin as this page) → clean.
  const texUrl = `/proxy?url=${encodeURIComponent(url)}`;
  const safe = texUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="https://aframe.io/releases/1.5.0/aframe.min.js"></script>
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: #14142b; }
    a-scene { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <a-scene embedded vr-mode-ui="enabled: false" loading-screen="enabled: false" cursor="rayOrigin: mouse">
    <a-assets>
      <!-- Same-origin (served via our /proxy) — no crossorigin needed, and
           adding it would force a CORS request the browser then blocks. -->
      <img id="pano" src="${safe}" />
    </a-assets>
    <!-- Equirectangular sky; drag to look around (default camera look-controls). -->
    <a-sky src="#pano"></a-sky>
  </a-scene>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// CORS proxy — streams a remote asset (a Fal .glb or .mp4) back with an
// Access-Control-Allow-Origin header. Two callers rely on this:
//   • "3D Viewer → Image" loads a .glb into <model-viewer> and snapshots it;
//   • "Video Player → Image" loads a .mp4 into a <video crossorigin> and draws
//     the current frame to a canvas.
// The browser taints those canvases unless the asset was fetched
// cross-origin-clean, and Fal's CDN doesn't ship CORS headers — so both load
// through here. `Range` is forwarded (with the key headers mirrored back) so
// video seeking / scrubbing works.
//
//   GET /proxy?url=<encoded url>
// ---------------------------------------------------------------------------
app.get('/proxy', (req, res) => {
  const target = typeof req.query.url === 'string' ? req.query.url : '';
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ error: 'Missing or invalid url' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'Invalid scheme' });
  }

  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');

  const lib = parsed.protocol === 'https:' ? https : http;
  const upstreamHeaders = {
    'User-Agent': 'fal-miro-proxy/1',
    ...(req.headers.range ? { Range: String(req.headers.range) } : {}),
  };

  const upstream = lib.get(target, { headers: upstreamHeaders }, (upRes) => {
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = upRes.headers[h];
      if (v != null) res.set(h, String(v));
    }
    res.status(upRes.statusCode || 200);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    console.error('[proxy] upstream error:', err?.message ?? err);
    if (!res.headersSent) res.status(502).json({ error: messageOf(err) });
    else res.destroy();
  });
});

// ---------------------------------------------------------------------------
// Run a model — submit to Fal's queue and return the request id immediately.
//
// Body:
// {
//   endpointId: string,   // e.g. "fal-ai/flux/dev"
//   input: object         // model-specific arguments (built by the panel form)
// }
//
// The decoupled architecture means the headless iframe polls /status; we never
// block the request thread waiting on a long generation.
// ---------------------------------------------------------------------------
app.post('/api/fal/run', async (req, res) => {
  try {
    const { endpointId, input } = req.body ?? {};
    if (!endpointId || typeof endpointId !== 'string') {
      return res.status(400).json({ error: 'endpointId is required' });
    }
    if (!input || typeof input !== 'object') {
      return res.status(400).json({ error: 'input object is required' });
    }

    logBox(`POST queue.submit → ${endpointId}`, summarizeInput(input));

    const { request_id: requestId } = await fal.queue.submit(endpointId, { input });

    if (debug) console.log(`[run] ${endpointId} request_id=${requestId}`);
    return res.json({ requestId, endpointId, status: 'QUEUED' });
  } catch (err) {
    console.error('[run] error:', err?.status ?? '', err?.message ?? err);
    if (err?.body?.detail) console.error('[run] validation detail:', JSON.stringify(err.body.detail, null, 2));
    return res.status(502).json({ error: falError(err) });
  }
});

// ---------------------------------------------------------------------------
// Poll status. endpointId is required (Fal scopes requests to an endpoint).
// On completion we also fetch the result so the caller gets output URLs in one
// round trip.
//
//   GET /api/fal/status/:requestId?endpointId=fal-ai/flux/dev
// ---------------------------------------------------------------------------
app.get('/api/fal/status/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const endpointId = req.query.endpointId;
    if (!endpointId || typeof endpointId !== 'string') {
      return res.status(400).json({ error: 'endpointId query param is required' });
    }

    const status = await fal.queue.status(endpointId, { requestId, logs: false });
    const normalized = normalizeStatus(status.status);

    if (normalized !== 'SUCCEEDED') {
      return res.json({
        requestId,
        endpointId,
        status: normalized,
        queuePosition: typeof status.queue_position === 'number' ? status.queue_position : null,
      });
    }

    // Completed — fetch the result payload.
    const result = await fal.queue.result(endpointId, { requestId });
    const data = result?.data ?? result ?? {};
    const output = extractOutputUrls(data);

    if (debug) console.log(`[status] ${endpointId} ${requestId} → SUCCEEDED (${output.length} output url(s))`);

    return res.json({
      requestId,
      endpointId,
      status: 'SUCCEEDED',
      output,
      data,
    });
  } catch (err) {
    console.error('[status] error:', err?.status ?? '', err?.message ?? err);
    if (err?.body?.detail) console.error('[status] validation detail:', JSON.stringify(err.body.detail, null, 2));
    return res.status(502).json({ error: falError(err) });
  }
});

// ---------------------------------------------------------------------------
// Cancel an in-flight request.
//   POST /api/fal/cancel/:requestId?endpointId=...
// ---------------------------------------------------------------------------
app.post('/api/fal/cancel/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const endpointId = req.query.endpointId;
    if (!endpointId || typeof endpointId !== 'string') {
      return res.status(400).json({ error: 'endpointId query param is required' });
    }
    await fal.queue.cancel(endpointId, { requestId });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[cancel] error:', err);
    return res.status(502).json({ error: messageOf(err) });
  }
});

// ---------------------------------------------------------------------------
// Model schema — the heart of "Option A". Proxies Fal's Platform Models API
// with expand=openapi-3.0 so the frontend can build a form from the live
// schema instead of hardcoding fields per model.
//
//   GET /api/fal/schema?endpointId=fal-ai/flux/dev
//
// Returns { endpointId, metadata, openapi } where `openapi` is the model's
// full OpenAPI 3.0 spec (inputs, enums, ranges, output shape).
// ---------------------------------------------------------------------------
app.get('/api/fal/schema', async (req, res) => {
  try {
    const endpointId = req.query.endpointId;
    if (!endpointId || typeof endpointId !== 'string') {
      return res.status(400).json({ error: 'endpointId query param is required' });
    }

    const url = new URL(`${FAL_PLATFORM_API_BASE}/models`);
    url.searchParams.set('endpoint_id', endpointId);
    url.searchParams.set('expand', 'openapi-3.0');

    const headers = { Accept: 'application/json' };
    // Auth is optional but grants higher rate limits.
    if (FAL_KEY) headers.Authorization = `Key ${FAL_KEY}`;

    const upstream = await fetch(url, { headers });
    const payload = await upstream.json();
    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .json({ error: payload?.error?.message ?? `Models API ${upstream.status}` });
    }

    const model = Array.isArray(payload.models) ? payload.models[0] : undefined;
    if (!model) {
      return res.status(404).json({ error: `No model found for endpoint_id "${endpointId}"` });
    }

    // `openapi` is either the spec or { error: {...} } if expansion failed.
    const openapi = model.openapi && !model.openapi.error ? model.openapi : null;
    if (!openapi) {
      return res.status(502).json({
        error: model.openapi?.error?.message ?? 'OpenAPI expansion unavailable for this model',
      });
    }

    return res.json({
      endpointId: model.endpoint_id,
      metadata: model.metadata ?? null,
      openapi,
    });
  } catch (err) {
    console.error('[schema] error:', err);
    return res.status(502).json({ error: messageOf(err) });
  }
});

// ---------------------------------------------------------------------------
// Model catalog sync — the discovery layer. Lists every Fal model with its
// metadata (category, tags, display_name, thumbnail, status) so the frontend
// can drive Category/tags and (eventually) auto-populate the catalog instead of
// hand-maintaining it. Paginated upstream; cached in-memory with a TTL to stay
// well under rate limits. Add ?refresh=1 to force a re-fetch.
//
//   GET /api/fal/models  → { models: [{ endpointId, displayName, category, tags[], status, thumbnailUrl }], count, cachedAt }
// ---------------------------------------------------------------------------
let modelsCache = null; // { at: number, models: [...] }
const MODELS_TTL_MS = 60 * 60 * 1000;

app.get('/api/fal/models', async (req, res) => {
  try {
    const fresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (!fresh && modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) {
      return res.json({ models: modelsCache.models, count: modelsCache.models.length, cachedAt: modelsCache.at });
    }

    const headers = { Accept: 'application/json' };
    const key = ADMIN_KEY ?? FAL_KEY; // optional; a key grants higher rate limits
    if (key) headers.Authorization = `Key ${key}`;

    const all = [];
    let cursor = null;
    for (let page = 0; page < 50; page++) {
      // Safety cap on pages.
      const url = new URL(`${FAL_PLATFORM_API_BASE}/models`);
      url.searchParams.set('limit', '100');
      if (cursor) url.searchParams.set('cursor', cursor);

      const upstream = await fetch(url, { headers });
      const payload = await upstream.json();
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: payload?.error?.message ?? `Models ${upstream.status}` });
      }

      const models = Array.isArray(payload?.models) ? payload.models : [];
      for (const m of models) {
        const meta = m?.metadata ?? {};
        const endpointId = m?.endpoint_id ?? meta.endpoint_id ?? null;
        if (!endpointId) continue;
        all.push({
          endpointId,
          displayName: typeof meta.display_name === 'string' ? meta.display_name : null,
          category: typeof meta.category === 'string' ? meta.category : null,
          tags: Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : [],
          status: typeof meta.status === 'string' ? meta.status : null,
          thumbnailUrl: typeof meta.thumbnail_url === 'string' ? meta.thumbnail_url : null,
        });
      }

      if (!payload?.has_more || !payload?.next_cursor) break;
      cursor = payload.next_cursor;
    }

    modelsCache = { at: Date.now(), models: all };
    return res.json({ models: all, count: all.length, cachedAt: modelsCache.at });
  } catch (err) {
    console.error('[models] error:', err);
    return res.status(502).json({ error: messageOf(err) });
  }
});

// ---------------------------------------------------------------------------
// Account balance — powers the credits badge.
//   GET /api/fal/balance  → { balance, currency }
// Note: Fal's billing endpoint may require an Admin API key; if FAL_KEY lacks
// the scope this returns an error the badge renders as "—".
// ---------------------------------------------------------------------------
app.get('/api/fal/balance', async (_req, res) => {
  try {
    if (!ADMIN_KEY) return res.status(400).json({ error: 'ADMIN_KEY not set' });
    const upstream = await fetch(`${FAL_PLATFORM_API_BASE}/account/billing?expand=credits`, {
      headers: { Authorization: `Key ${ADMIN_KEY}`, Accept: 'application/json' },
    });
    const payload = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: payload?.error?.message ?? `Billing ${upstream.status}` });
    }
    const credits = payload?.credits ?? null;
    return res.json({
      balance: typeof credits?.current_balance === 'number' ? credits.current_balance : null,
      currency: credits?.currency ?? 'USD',
    });
  } catch (err) {
    console.error('[balance] error:', err);
    return res.status(502).json({ error: messageOf(err) });
  }
});

// ---------------------------------------------------------------------------
// Cost estimate — unit price × billing units. Best-effort (no per-call cost is
// returned by Fal), used to stamp an est. cost on each generated asset.
//   GET /api/fal/estimate?endpointId=…&units=N  → { costUSD, unit }
// ---------------------------------------------------------------------------
app.get('/api/fal/estimate', async (req, res) => {
  try {
    const endpointId = req.query.endpointId;
    const units = Math.max(1, Number(req.query.units) || 1);
    // Elapsed compute time (seconds), supplied for time-billed models.
    const seconds = Number(req.query.seconds) > 0 ? Number(req.query.seconds) : null;
    if (!endpointId || typeof endpointId !== 'string') {
      return res.status(400).json({ error: 'endpointId query param is required' });
    }
    const url = new URL(`${FAL_PLATFORM_API_BASE}/models/pricing`);
    url.searchParams.set('endpoint_id', endpointId);
    const headers = { Accept: 'application/json' };
    const pricingKey = ADMIN_KEY ?? FAL_KEY;
    if (pricingKey) headers.Authorization = `Key ${pricingKey}`;
    const upstream = await fetch(url, { headers });
    const payload = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: payload?.error?.message ?? `Pricing ${upstream.status}` });
    }
    const price = Array.isArray(payload?.prices) ? payload.prices[0] : null;
    if (!price || typeof price.unit_price !== 'number') {
      return res.json({ costUSD: null, unit: price?.unit ?? null });
    }
    // Time-billed models (Fal reports a unit like "second" / "compute_second")
    // are charged by how long the job runs, not by output count — so multiply
    // by the elapsed seconds when the caller provides them. Everything else
    // (per image / per megapixel / per video) bills by `units`.
    const unit = typeof price.unit === 'string' ? price.unit : null;
    const perSecond = unit ? /second/i.test(unit) : false;
    const billedUnits = perSecond && seconds ? seconds : units;
    return res.json({
      costUSD: Number((price.unit_price * billedUnits).toFixed(4)),
      unit,
      unitPrice: price.unit_price,
      units: billedUnits,
      perSecond,
    });
  } catch (err) {
    console.error('[estimate] error:', err);
    return res.status(502).json({ error: messageOf(err) });
  }
});

// Fal validation errors (422) put the useful info in err.body.detail — a list
// of { loc, msg, type }. Surface that instead of the generic "Unprocessable
// Entity" so the frontend (and logs) show what was actually rejected.
function falError(err) {
  const body = err?.body;
  if (body?.detail) {
    try {
      const details = Array.isArray(body.detail) ? body.detail : [body.detail];
      // Map Fal's known error types to concise, actionable messages.
      if (details[0]?.type === 'no_media_generated') {
        return (
          'Fal produced no output (no_media_generated). Common causes: the inputs ' +
          "can't be turned into the requested media — e.g. first/last frames that are " +
          'too different to transition between — or content blocked by safety. Try ' +
          'frames from the same scene/subject.'
        );
      }
      const msgs = details.map((d) => {
        if (typeof d === 'string') return d;
        const loc = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'body').join('.') : d.loc;
        return [loc, d.msg].filter(Boolean).join(': ');
      });
      const joined = msgs.filter(Boolean).join(' | ');
      if (joined) return joined;
    } catch {
      /* fall through */
    }
  }
  return messageOf(err);
}

function messageOf(err) {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

app.listen(Number(PORT), () => {
  console.log(`[boot] fal-miro backend listening on http://localhost:${PORT}`);
  console.log(`[boot] allowed origins: ${allowedOrigins.join(', ') || '(none)'}`);
});
